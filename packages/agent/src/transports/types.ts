/**
 * Shared types for normalized provider responses.
 *
 * Faithful port of upstream `agent/transports/types.py`.
 *
 * These types define the canonical shape that all provider adapters
 * normalise responses to. The shared surface is intentionally minimal —
 * only fields that every downstream consumer reads are top-level.
 * Protocol-specific state goes in `providerData` records (response-level
 * and per-tool-call) so protocol-aware code paths can access it without
 * polluting the shared type.
 *
 * ── Faithful divergences ──────────────────────────────────────────────
 * 1. Python `@dataclass` with `@property` becomes a TS class with getters
 *    that read `providerData`. Semantics are identical.
 * 2. Python `arguments` is a `str` (JSON-string). TS keeps `arguments` as
 *    `string` for parity; `buildToolCall` JSON-encodes when given an object.
 * 3. Python `field(repr=False)` is purely cosmetic for `repr()`. TS has no
 *    direct analogue — omitted.
 */
/**
 * Per-tool-call protocol metadata.
 *
 * The Python upstream uses an open-ended `dict[str, Any]`; this interface
 * mirrors that — known keys are documented, but adapters may attach
 * provider-specific extras (e.g. Gemini `extra_content` → thought signature).
 */
export interface ToolCallProviderData {
  /** Codex Responses API tool-call id (`call_XXX`). */
  call_id?: string;
  /** Codex Responses API function-call item id (`fc_XXX`). */
  response_item_id?: string;
  /** Gemini 3 thinking model `extra_content` (must be replayed verbatim). */
  extra_content?: unknown;
  /** Open-ended escape hatch for additional provider-specific metadata. */
  [key: string]: unknown;
}

/**
 * A normalised tool call from any provider.
 *
 * Upstream backward-compat properties (`type`, `function`, `call_id`,
 * `response_item_id`, `extra_content`) are exposed as getters so existing
 * `tc.function.name` / `tc.function.arguments` call sites keep working.
 */
export class ToolCall {
  /**
   * Protocol's canonical identifier — used in `tool_call_id` /
   * `tool_use_id` when constructing tool-result messages. `null` when the
   * provider omits it; the agent fills it via `_deterministicCallId()`
   * before storing in history (deferred to integrators sub-task).
   */
  readonly id: string | null;

  /** Tool name as returned by the provider. */
  readonly name: string;

  /** JSON-encoded argument string. */
  readonly arguments: string;

  /** Per-tool-call protocol metadata, or `null` when none was attached. */
  readonly providerData: ToolCallProviderData | null;

  constructor(options: {
    id: string | null;
    name: string;
    arguments: string;
    providerData?: ToolCallProviderData | null;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.arguments = options.arguments;
    this.providerData = options.providerData ?? null;
  }

  /** Upstream backward-compat — always `"function"` for OpenAI tool calls. */
  get type(): "function" {
    return "function";
  }

  /**
   * Upstream backward-compat — returns `this` so `tc.function.name` and
   * `tc.function.arguments` read the same flat fields. Upstream
   * documents this as a property that returns `self`.
   */
  get function(): ToolCall {
    return this;
  }

  /** Codex `call_id` from `providerData`. */
  get call_id(): string | null {
    return (this.providerData?.call_id as string | undefined) ?? null;
  }

  /** Codex `response_item_id` from `providerData`. */
  get response_item_id(): string | null {
    return (this.providerData?.response_item_id as string | undefined) ?? null;
  }

  /**
   * Gemini `extra_content` (thought signature) from `providerData`.
   *
   * Gemini 3 thinking models attach `extra_content` with a
   * `thought_signature` on every tool call; without replay the API
   * rejects the request with HTTP 400. Upstream issue: #14488.
   */
  get extra_content(): unknown {
    return this.providerData?.extra_content ?? null;
  }
}

/** Token usage from an API response. */
export class Usage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly cached_tokens: number;

  constructor(options: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
  } = {}) {
    this.prompt_tokens = options.prompt_tokens ?? 0;
    this.completion_tokens = options.completion_tokens ?? 0;
    this.total_tokens = options.total_tokens ?? 0;
    this.cached_tokens = options.cached_tokens ?? 0;
  }
}

/** Response-level protocol metadata. */
export interface NormalizedResponseProviderData {
  /** Anthropic thinking blocks dump (replayed on subsequent turns). */
  reasoning_details?: unknown;
  /** Codex Responses API reasoning items (replayed across turns). */
  codex_reasoning_items?: unknown;
  /** Codex Responses API assistant message items (replayed across turns). */
  codex_message_items?: unknown;
  /** DeepSeek / Moonshot scratchpad text (distinct from `reasoning`). */
  reasoning_content?: unknown;
  /** Open-ended escape hatch for additional provider-specific metadata. */
  [key: string]: unknown;
}

/**
 * Finish reason as normalised across providers.
 *
 * The agent loop reads this as a free string; we keep it typed loose to
 * stay faithful to upstream which accepts arbitrary provider-emitted
 * reasons via `mapFinishReason`'s `"stop"` fallback.
 */
export type FinishReason = string;

/**
 * Normalised API response from any provider.
 *
 * Shared fields are truly cross-provider; protocol-specific state goes
 * in `providerData` so only protocol-aware code paths read it.
 */
export class NormalizedResponse {
  readonly content: string | null;
  readonly tool_calls: ToolCall[] | null;
  readonly finish_reason: FinishReason;
  readonly reasoning: string | null;
  readonly usage: Usage | null;
  readonly providerData: NormalizedResponseProviderData | null;

  constructor(options: {
    content: string | null;
    tool_calls: ToolCall[] | null;
    finish_reason: FinishReason;
    reasoning?: string | null;
    usage?: Usage | null;
    providerData?: NormalizedResponseProviderData | null;
  }) {
    this.content = options.content;
    this.tool_calls = options.tool_calls;
    this.finish_reason = options.finish_reason;
    this.reasoning = options.reasoning ?? null;
    this.usage = options.usage ?? null;
    this.providerData = options.providerData ?? null;
  }

  /** DeepSeek / Moonshot `reasoning_content` scratchpad. */
  get reasoning_content(): unknown {
    return this.providerData?.reasoning_content ?? null;
  }

  /** Anthropic thinking-block dump for cross-turn replay. */
  get reasoning_details(): unknown {
    return this.providerData?.reasoning_details ?? null;
  }

  /** Codex reasoning items for cross-turn replay. */
  get codex_reasoning_items(): unknown {
    return this.providerData?.codex_reasoning_items ?? null;
  }

  /** Codex assistant-message items for cross-turn replay. */
  get codex_message_items(): unknown {
    return this.providerData?.codex_message_items ?? null;
  }
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Factory helpers                                                         */
/* ─────────────────────────────────────────────────────────────────────── */

/**
 * Build a `ToolCall`, auto-serialising `arguments` when given a plain
 * record (mirrors upstream `isinstance(arguments, dict)`). Strings pass
 * through verbatim. Extra fields collect into `providerData`.
 */
export function buildToolCall(
  id: string | null,
  name: string,
  args: unknown,
  providerFields: ToolCallProviderData = {},
): ToolCall {
  let argsStr: string;
  if (isPlainRecord(args)) {
    argsStr = JSON.stringify(args);
  } else {
    argsStr = String(args);
  }
  const providerData = Object.keys(providerFields).length > 0 ? { ...providerFields } : null;
  return new ToolCall({ id, name, arguments: argsStr, providerData });
}

/**
 * Translate a provider-specific stop reason via a mapping table. Falls
 * back to `"stop"` for unknown or null reasons. Matches upstream
 * `map_finish_reason()`.
 */
export function mapFinishReason(
  reason: string | null | undefined,
  mapping: Record<string, FinishReason>,
): FinishReason {
  if (reason === null || reason === undefined) {
    return "stop";
  }
  return mapping[reason] ?? "stop";
}

/** Internal helper — true for `{}`-shape objects (not arrays, not null). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
