/**
 * TrajectoryCompressor — faithful port of `TrajectoryCompressor`
 * (upstream `trajectory_compressor.py` lines 332-1287).
 *
 * Compresses agent trajectories to fit within a target token budget by
 * replacing a middle window of turns with a single LLM-generated summary.
 *
 * Faithful divergences from upstream:
 *
 *  - Tokenizer is INJECTED rather than auto-loaded from HuggingFace. The
 *    upstream `_init_tokenizer` calls `AutoTokenizer.from_pretrained(...)`;
 *    we don't bundle a JS HF tokenizer, so callers pass any object satisfying
 *    the `Tokenizer` interface (typically a thin wrapper around `tiktoken`,
 *    `tokenizers`, or a remote service).
 *
 *  - LLM client is INJECTED rather than auto-constructed. Upstream
 *    `_init_summarizer` constructs either an OpenAI client OR uses the
 *    `agent.auxiliary_client.call_llm` router. Both paths live in `@hermests/agent`
 *    (which is still pending). The compressor receives an `LlmClientPair`
 *    (sync + async) — concrete bindings ship with `@hermests/agent`.
 *
 *  - Temperature resolver is INJECTED. The upstream `_effective_temperature_for_model`
 *    imports `agent.auxiliary_client._fixed_temperature_for_model`. We accept the
 *    resolver via the constructor; default is identity-passthrough (matches the
 *    `except: return requested_temperature` branch).
 *
 *  - File I/O and directory processing live in `directory-processor.ts` — the
 *    upstream `process_directory` + `_process_directory_async` + `main()` flow.
 *    Splitting keeps the compressor itself focused on per-trajectory logic.
 */

import { defaultSleep, jitteredBackoff } from "./backoff.js";
import type { CompressionConfig } from "./compression-config.js";
import { AggregateMetrics, TrajectoryMetrics } from "./metrics.js";
import { detectProvider } from "./provider-detection.js";
import type {
  AsyncLlmClient,
  BackoffFn,
  ChatCompletionResponse,
  Entry,
  LlmClientPair,
  Logger,
  SleepFn,
  SyncLlmClient,
  TemperatureResolver,
  Tokenizer,
  Turn,
} from "./types.js";

/**
 * Construction options for `TrajectoryCompressor`.
 *
 * Injection-based: the upstream auto-loads tokenizer/clients during `__init__`,
 * but those bindings live in other packages (agent, hf-tokenizer). Callers
 * supply concrete implementations here.
 */
export interface TrajectoryCompressorOptions {
  /** Tokenizer used for token counting. Required. */
  tokenizer: Tokenizer;
  /** LLM client pair (sync + async). Required for compression to produce summaries. */
  llmClient: LlmClientPair;
  /**
   * Temperature resolver — defaults to identity (returns requested temperature
   * unchanged), matching the upstream ImportError-fallback branch.
   */
  temperatureResolver?: TemperatureResolver | undefined;
  /** Logger — defaults to no-op. */
  logger?: Logger | undefined;
  /** Async sleep — defaults to `setTimeout`-backed. */
  sleep?: SleepFn | undefined;
  /** Sync sleep for `_generateSummary` — defaults to busy-wait via `Atomics.wait`. */
  syncSleep?: ((ms: number) => void) | undefined;
  /** Backoff fn — defaults to `jitteredBackoff`. */
  backoff?: BackoffFn | undefined;
}

/** No-op logger used when no logger is injected. Only `warning` is reachable
 *  from this module (errors come up from `directory-processor.ts`). The
 *  `error` slot is required by the `Logger` interface; reading the property
 *  is enough to satisfy v8 coverage. */
const NO_OP_LOGGER: Logger = {
  warning: () => undefined,
  /* v8 ignore next */
  error: () => undefined,
};

/** Identity-passthrough temperature resolver (matches the upstream import-failure branch). */
const PASSTHROUGH_TEMPERATURE: TemperatureResolver = (_model, requested) => requested;

/**
 * Default *synchronous* sleep — busy-blocks the thread for `ms` milliseconds.
 * Mirrors `time.sleep(seconds)`. Used only inside `_generateSummary` (the sync
 * variant) — production code should prefer the async path.
 *
 * Uses `Atomics.wait` on a fresh `SharedArrayBuffer` so it doesn't burn CPU.
 */
function defaultSyncSleep(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Returned by `compressTrajectory` / `compressTrajectoryAsync`.
 */
export interface CompressionResult {
  trajectory: Turn[];
  metrics: TrajectoryMetrics;
}

/**
 * Returned by `processEntry` / `processEntryAsync`.
 */
export interface ProcessEntryResult {
  entry: Entry;
  metrics: TrajectoryMetrics;
}

/**
 * Compresses agent trajectories to fit within a target token budget.
 *
 * Strategy:
 *   1. Keep protected head turns (system, human, first gpt+tool).
 *   2. Keep protected tail turns (last N turns).
 *   3. From the compressible middle region, compress only as much as needed.
 *   4. Replace compressed turns with a single human summary message.
 *   5. Keep remaining middle turns intact (model continues with tools).
 */
export class TrajectoryCompressor {
  readonly config: CompressionConfig;
  readonly aggregateMetrics: AggregateMetrics;

  readonly tokenizer: Tokenizer;
  readonly syncClient: SyncLlmClient;
  readonly asyncClient: AsyncLlmClient;
  /** Provider id detected from `config.baseUrl`. Empty string when unknown. */
  readonly llmProvider: string;
  readonly useCallLlm: boolean;

  readonly logger: Logger;

  private readonly temperatureResolver: TemperatureResolver;
  private readonly sleep: SleepFn;
  private readonly syncSleep: (ms: number) => void;
  private readonly backoff: BackoffFn;

  constructor(config: CompressionConfig, options: TrajectoryCompressorOptions) {
    this.config = config;
    this.aggregateMetrics = new AggregateMetrics();

    this.tokenizer = options.tokenizer;
    this.syncClient = options.llmClient.sync;
    this.asyncClient = options.llmClient.async;
    this.temperatureResolver = options.temperatureResolver ?? PASSTHROUGH_TEMPERATURE;
    this.logger = options.logger ?? NO_OP_LOGGER;
    this.sleep = options.sleep ?? defaultSleep;
    this.syncSleep = options.syncSleep ?? defaultSyncSleep;
    this.backoff = options.backoff ?? jitteredBackoff;

    // Faithful to `_init_summarizer`: detect provider from base URL, fall back
    // to raw client. When `provider` is non-empty, the sync/async clients are
    // expected to route through call_llm/async_call_llm.
    this.llmProvider = detectProvider(this.config.baseUrl);
    this.useCallLlm = this.llmProvider !== "";
  }

  // ── Token counting ─────────────────────────────────────────────────────

  /** Count tokens in `text` using the configured tokenizer. */
  countTokens(text: string): number {
    if (!text) return 0;
    try {
      const encoded = this.tokenizer.encode(text);
      return Array.isArray(encoded) ? encoded.length : encoded.length;
    } catch {
      // Fallback to character estimate — matches `len(text) // 4`.
      return Math.floor(text.length / 4);
    }
  }

  /** Count total tokens in a trajectory. */
  countTrajectoryTokens(trajectory: readonly Turn[]): number {
    let total = 0;
    for (const turn of trajectory) {
      total += this.countTokens(turnValue(turn));
    }
    return total;
  }

  /** Count tokens for each turn in a trajectory. */
  countTurnTokens(trajectory: readonly Turn[]): number[] {
    return trajectory.map((turn) => this.countTokens(turnValue(turn)));
  }

  // ── Protected indices ──────────────────────────────────────────────────

  /**
   * Find indices of protected turns. Returns the protected set plus the
   * compressible range `[compressibleStart, compressibleEnd)`.
   *
   * Faithful to the upstream algorithm including the `n // 2` head/tail split
   * used to disambiguate first-* and last-N when they overlap.
   */
  findProtectedIndices(trajectory: readonly Turn[]): {
    protected: Set<number>;
    compressibleStart: number;
    compressibleEnd: number;
  } {
    const n = trajectory.length;
    const protectedSet = new Set<number>();

    let firstSystem: number | null = null;
    let firstHuman: number | null = null;
    let firstGpt: number | null = null;
    let firstTool: number | null = null;

    for (let i = 0; i < n; i += 1) {
      const role = turnRole(trajectory[i]!);
      if (role === "system" && firstSystem === null) firstSystem = i;
      else if (role === "human" && firstHuman === null) firstHuman = i;
      else if (role === "gpt" && firstGpt === null) firstGpt = i;
      else if (role === "tool" && firstTool === null) firstTool = i;
    }

    if (this.config.protectFirstSystem && firstSystem !== null) {
      protectedSet.add(firstSystem);
    }
    if (this.config.protectFirstHuman && firstHuman !== null) {
      protectedSet.add(firstHuman);
    }
    if (this.config.protectFirstGpt && firstGpt !== null) {
      protectedSet.add(firstGpt);
    }
    if (this.config.protectFirstTool && firstTool !== null) {
      protectedSet.add(firstTool);
    }

    const tailStart = Math.max(0, n - this.config.protectLastNTurns);
    for (let i = tailStart; i < n; i += 1) {
      protectedSet.add(i);
    }

    // Determine compressible region using the upstream n/2 partition.
    const halfPoint = Math.floor(n / 2);
    const headProtected: number[] = [];
    const tailProtected: number[] = [];
    for (const idx of protectedSet) {
      if (idx < halfPoint) headProtected.push(idx);
      else tailProtected.push(idx);
    }

    const compressibleStart = headProtected.length > 0 ? Math.max(...headProtected) + 1 : 0;
    const compressibleEnd = tailProtected.length > 0 ? Math.min(...tailProtected) : n;

    return {
      protected: protectedSet,
      compressibleStart,
      compressibleEnd,
    };
  }

  // ── Extraction for summary ─────────────────────────────────────────────

  /**
   * Extract content from turns to be summarized. `end` is exclusive — matches
   * the upstream `range(start, end)` semantics.
   */
  extractTurnContentForSummary(trajectory: readonly Turn[], start: number, end: number): string {
    const parts: string[] = [];
    for (let i = start; i < end; i += 1) {
      const turn = trajectory[i]!;
      const role = turnRole(turn) || "unknown";
      let value = turnValue(turn);

      if (value.length > 3000) {
        value = `${value.slice(0, 1500)}\n...[truncated]...\n${value.slice(-500)}`;
      }

      parts.push(`[Turn ${i} - ${role.toUpperCase()}]:\n${value}`);
    }
    return parts.join("\n\n");
  }

  // ── Summary helpers ────────────────────────────────────────────────────

  /** Normalize summary-model output to a safe string. */
  static coerceSummaryContent(content: unknown): string {
    if (typeof content !== "string") {
      content = content ? String(content) : "";
    }
    return (content as string).trim();
  }

  /** Normalize summary text to include the expected prefix exactly once. */
  static ensureSummaryPrefix(summary: string): string {
    const text = (summary ?? "").trim();
    if (text.startsWith("[CONTEXT SUMMARY]:")) return text;
    return text === "" ? "[CONTEXT SUMMARY]:" : `[CONTEXT SUMMARY]: ${text}`;
  }

  // ── Provider detection (instance method preserves upstream surface) ────

  /** Detect the provider name from `config.baseUrl`. Wraps `detectProvider`. */
  detectProvider(): string {
    return detectProvider(this.config.baseUrl);
  }

  // ── Effective temperature ──────────────────────────────────────────────

  /** Resolve the effective temperature for the configured summarization model. */
  effectiveTemperatureForModel(): number | null {
    return this.temperatureResolver(
      this.config.summarizationModel,
      this.config.temperature,
      this.config.baseUrl,
    );
  }

  // ── Summary generation (sync) ──────────────────────────────────────────

  /**
   * Generate a summary of the compressed turns using the synchronous LLM
   * client. Retries up to `maxRetries`; falls back to a placeholder summary
   * after exhaustion.
   */
  generateSummary(content: string, metrics: TrajectoryMetrics): string {
    const prompt = this.buildSummaryPrompt(content);

    let attempt = 0;
    while (true) {
      try {
        metrics.summarizationApiCalls += 1;
        const temperature = this.effectiveTemperatureForModel();

        const response: ChatCompletionResponse = this.syncClient.createChatCompletion({
          model: this.config.summarizationModel,
          messages: [{ role: "user", content: prompt }],
          temperature,
          maxTokens: this.config.summaryTargetTokens * 2,
        });

        const raw = response.choices[0]?.message.content ?? null;
        const summary = TrajectoryCompressor.coerceSummaryContent(raw);
        return TrajectoryCompressor.ensureSummaryPrefix(summary);
      } catch (err) {
        metrics.summarizationErrors += 1;
        this.logger.warning(`Summarization attempt ${attempt + 1} failed: ${formatError(err)}`);

        if (attempt < this.config.maxRetries - 1) {
          const delay = this.backoff(attempt + 1, {
            baseDelay: this.config.retryDelay,
            maxDelay: 30.0,
          });
          this.syncSleep(Math.round(delay * 1000));
          attempt += 1;
          continue;
        }
        return "[CONTEXT SUMMARY]: [Summary generation failed - previous turns contained tool calls and responses that have been compressed to save context space.]";
      }
    }
  }

  // ── Summary generation (async) ─────────────────────────────────────────

  /**
   * Async variant of `generateSummary`. Faithful to the upstream
   * `_generate_summary_async` — same prompt, same retry/backoff behaviour,
   * uses `await asyncio.sleep(...)` (mapped to our async `sleep` injection).
   */
  async generateSummaryAsync(content: string, metrics: TrajectoryMetrics): Promise<string> {
    const prompt = this.buildSummaryPrompt(content);

    for (let attempt = 0; attempt < this.config.maxRetries; attempt += 1) {
      try {
        metrics.summarizationApiCalls += 1;
        const temperature = this.effectiveTemperatureForModel();

        const response = await this.asyncClient.createChatCompletion({
          model: this.config.summarizationModel,
          messages: [{ role: "user", content: prompt }],
          temperature,
          maxTokens: this.config.summaryTargetTokens * 2,
        });

        const raw = response.choices[0]?.message.content ?? null;
        const summary = TrajectoryCompressor.coerceSummaryContent(raw);
        return TrajectoryCompressor.ensureSummaryPrefix(summary);
      } catch (err) {
        metrics.summarizationErrors += 1;
        this.logger.warning(`Summarization attempt ${attempt + 1} failed: ${formatError(err)}`);

        if (attempt < this.config.maxRetries - 1) {
          const delay = this.backoff(attempt + 1, {
            baseDelay: this.config.retryDelay,
            maxDelay: 30.0,
          });
          await this.sleep(Math.round(delay * 1000));
        } else {
          return "[CONTEXT SUMMARY]: [Summary generation failed - previous turns contained tool calls and responses that have been compressed to save context space.]";
        }
      }
      /* v8 ignore next */
    }

    // Unreachable: the loop body always returns (success returns inside try,
    // exhaustion returns inside the else above). TS still requires this final
    // return for control-flow analysis, and v8 still records the "fell off the
    // loop" branch — ignore both since they are structurally dead.
    /* v8 ignore next */
    return "[CONTEXT SUMMARY]: [Summary generation failed - previous turns contained tool calls and responses that have been compressed to save context space.]";
  }

  /** Build the summary-generation prompt — shared between sync and async paths. */
  private buildSummaryPrompt(content: string): string {
    return `Summarize the following agent conversation turns concisely. This summary will replace these turns in the conversation history.

Write the summary from a neutral perspective describing what the assistant did and learned. Include:
1. What actions the assistant took (tool calls, searches, file operations)
2. Key information or results obtained
3. Any important decisions or findings
4. Relevant data, file names, values, or outputs

Keep the summary factual and informative. Target approximately ${this.config.summaryTargetTokens} tokens.

---
TURNS TO SUMMARIZE:
${content}
---

Write only the summary, starting with "[CONTEXT SUMMARY]:" prefix.`;
  }

  // ── Trajectory compression (sync) ──────────────────────────────────────

  /**
   * Compress a single trajectory to fit within the target token budget.
   * Faithful to the upstream `compress_trajectory` algorithm.
   */
  compressTrajectory(trajectory: Turn[]): CompressionResult {
    const metrics = new TrajectoryMetrics();
    metrics.originalTurns = trajectory.length;

    const turnTokens = this.countTurnTokens(trajectory);
    const totalTokens = turnTokens.reduce((acc, x) => acc + x, 0);
    metrics.originalTokens = totalTokens;

    if (totalTokens <= this.config.targetMaxTokens) {
      metrics.skippedUnderTarget = true;
      metrics.compressedTokens = totalTokens;
      metrics.compressedTurns = trajectory.length;
      metrics.compressionRatio = 1.0;
      return { trajectory, metrics };
    }

    const { compressibleStart: compressStart, compressibleEnd: compressEnd } =
      this.findProtectedIndices(trajectory);

    if (compressStart >= compressEnd) {
      metrics.compressedTokens = totalTokens;
      metrics.compressedTurns = trajectory.length;
      metrics.stillOverLimit = totalTokens > this.config.targetMaxTokens;
      return { trajectory, metrics };
    }

    const tokensToSave = totalTokens - this.config.targetMaxTokens;
    const targetTokensToCompress = tokensToSave + this.config.summaryTargetTokens;

    let accumulatedTokens = 0;
    let compressUntil = compressStart;

    for (let i = compressStart; i < compressEnd; i += 1) {
      accumulatedTokens += turnTokens[i]!;
      compressUntil = i + 1;
      if (accumulatedTokens >= targetTokensToCompress) break;
    }

    // The inner loop always sets compressUntil = i+1 on its final iteration,
    // so compressUntil === compressEnd whenever the break never fires. The
    // upstream keeps this branch as a safety net for empty-range edge cases
    // we've already short-circuited above with `compressStart >= compressEnd`.
    /* v8 ignore start */
    if (accumulatedTokens < targetTokensToCompress && compressUntil < compressEnd) {
      compressUntil = compressEnd;
      accumulatedTokens = 0;
      for (let i = compressStart; i < compressEnd; i += 1) {
        accumulatedTokens += turnTokens[i]!;
      }
    }
    /* v8 ignore stop */

    metrics.turnsCompressedStartIdx = compressStart;
    metrics.turnsCompressedEndIdx = compressUntil;
    metrics.turnsInCompressedRegion = compressUntil - compressStart;

    const contentToSummarize = this.extractTurnContentForSummary(
      trajectory,
      compressStart,
      compressUntil,
    );
    const summary = this.generateSummary(contentToSummarize, metrics);

    const compressed = this.assembleCompressed(trajectory, compressStart, compressUntil, summary);

    metrics.compressedTurns = compressed.length;
    metrics.compressedTokens = this.countTrajectoryTokens(compressed);
    metrics.turnsRemoved = metrics.originalTurns - metrics.compressedTurns;
    metrics.tokensSaved = metrics.originalTokens - metrics.compressedTokens;
    metrics.compressionRatio = metrics.compressedTokens / Math.max(metrics.originalTokens, 1);
    metrics.wasCompressed = true;
    metrics.stillOverLimit = metrics.compressedTokens > this.config.targetMaxTokens;

    return { trajectory: compressed, metrics };
  }

  // ── Trajectory compression (async) ─────────────────────────────────────

  /** Async variant of `compressTrajectory` — uses `generateSummaryAsync`. */
  async compressTrajectoryAsync(trajectory: Turn[]): Promise<CompressionResult> {
    const metrics = new TrajectoryMetrics();
    metrics.originalTurns = trajectory.length;

    const turnTokens = this.countTurnTokens(trajectory);
    const totalTokens = turnTokens.reduce((acc, x) => acc + x, 0);
    metrics.originalTokens = totalTokens;

    if (totalTokens <= this.config.targetMaxTokens) {
      metrics.skippedUnderTarget = true;
      metrics.compressedTokens = totalTokens;
      metrics.compressedTurns = trajectory.length;
      metrics.compressionRatio = 1.0;
      return { trajectory, metrics };
    }

    const { compressibleStart: compressStart, compressibleEnd: compressEnd } =
      this.findProtectedIndices(trajectory);

    if (compressStart >= compressEnd) {
      metrics.compressedTokens = totalTokens;
      metrics.compressedTurns = trajectory.length;
      metrics.stillOverLimit = totalTokens > this.config.targetMaxTokens;
      return { trajectory, metrics };
    }

    const tokensToSave = totalTokens - this.config.targetMaxTokens;
    const targetTokensToCompress = tokensToSave + this.config.summaryTargetTokens;

    let accumulatedTokens = 0;
    let compressUntil = compressStart;

    for (let i = compressStart; i < compressEnd; i += 1) {
      accumulatedTokens += turnTokens[i]!;
      compressUntil = i + 1;
      if (accumulatedTokens >= targetTokensToCompress) break;
    }

    // Same safety-net branch as the sync path; see compressTrajectory for rationale.
    /* v8 ignore start */
    if (accumulatedTokens < targetTokensToCompress && compressUntil < compressEnd) {
      compressUntil = compressEnd;
      accumulatedTokens = 0;
      for (let i = compressStart; i < compressEnd; i += 1) {
        accumulatedTokens += turnTokens[i]!;
      }
    }
    /* v8 ignore stop */

    metrics.turnsCompressedStartIdx = compressStart;
    metrics.turnsCompressedEndIdx = compressUntil;
    metrics.turnsInCompressedRegion = compressUntil - compressStart;

    const contentToSummarize = this.extractTurnContentForSummary(
      trajectory,
      compressStart,
      compressUntil,
    );
    const summary = await this.generateSummaryAsync(contentToSummarize, metrics);

    const compressed = this.assembleCompressed(trajectory, compressStart, compressUntil, summary);

    metrics.compressedTurns = compressed.length;
    metrics.compressedTokens = this.countTrajectoryTokens(compressed);
    metrics.turnsRemoved = metrics.originalTurns - metrics.compressedTurns;
    metrics.tokensSaved = metrics.originalTokens - metrics.compressedTokens;
    metrics.compressionRatio = metrics.compressedTokens / Math.max(metrics.originalTokens, 1);
    metrics.wasCompressed = true;
    metrics.stillOverLimit = metrics.compressedTokens > this.config.targetMaxTokens;

    return { trajectory: compressed, metrics };
  }

  /**
   * Build the compressed trajectory: head + summary + tail. Shared between
   * sync and async compression paths.
   */
  private assembleCompressed(
    trajectory: readonly Turn[],
    compressStart: number,
    compressUntil: number,
    summary: string,
  ): Turn[] {
    const compressed: Turn[] = [];

    for (let i = 0; i < compressStart; i += 1) {
      const turn = { ...trajectory[i]! };
      if (turnRole(turn) === "system" && this.config.addSummaryNotice) {
        turn.value = turnValue(turn) + this.config.summaryNoticeText;
      }
      compressed.push(turn);
    }

    compressed.push({ from: "human", value: summary });

    for (let i = compressUntil; i < trajectory.length; i += 1) {
      compressed.push({ ...trajectory[i]! });
    }

    return compressed;
  }

  // ── Entry processing ───────────────────────────────────────────────────

  /** Process a single JSONL entry (sync). */
  processEntry(entry: Entry): ProcessEntryResult {
    if (!("conversations" in entry) || entry.conversations === undefined) {
      return { entry, metrics: new TrajectoryMetrics() };
    }

    const trajectory = entry.conversations;
    const { trajectory: compressed, metrics } = this.compressTrajectory(trajectory);

    const result: Entry = { ...entry, conversations: compressed };

    if (this.config.metricsPerTrajectory && metrics.wasCompressed) {
      result.compression_metrics = metrics.toDict() as unknown as Record<string, unknown>;
    }

    return { entry: result, metrics };
  }

  /** Process a single JSONL entry (async). */
  async processEntryAsync(entry: Entry): Promise<ProcessEntryResult> {
    if (!("conversations" in entry) || entry.conversations === undefined) {
      return { entry, metrics: new TrajectoryMetrics() };
    }

    const trajectory = entry.conversations;
    const { trajectory: compressed, metrics } = await this.compressTrajectoryAsync(trajectory);

    const result: Entry = { ...entry, conversations: compressed };

    if (this.config.metricsPerTrajectory && metrics.wasCompressed) {
      result.compression_metrics = metrics.toDict() as unknown as Record<string, unknown>;
    }

    return { entry: result, metrics };
  }
}

/** Safe accessor for the `from` field — Python returns "" when key missing. */
function turnRole(turn: Turn): string {
  return turn.from ?? "";
}

/** Safe accessor for the `value` field — Python returns "" when key missing. */
function turnValue(turn: Turn): string {
  return turn.value ?? "";
}

/** Format an unknown thrown value into a message for logging. */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
