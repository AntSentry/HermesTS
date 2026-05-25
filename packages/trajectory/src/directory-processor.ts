/**
 * Directory processor — faithful port of
 * `TrajectoryCompressor.process_directory` / `_process_directory_async` /
 * `_print_summary` and the `main()` CLI entry-point
 * (upstream `trajectory_compressor.py` lines 975-1508).
 *
 * The compression core itself lives in `trajectory-compressor.ts`. This module
 * adds the JSONL ingest/output, semaphore-bounded async parallelism,
 * per-trajectory timeouts, and the summary console report.
 *
 * Faithful divergences from upstream:
 *
 *  - The Python `Rich` progress bar is replaced with a callback-based progress
 *    reporter so the package stays UI-agnostic. The default is no-op; CLI
 *    callers can wire it to ora, listr2, or whatever bar they like.
 *
 *  - `tempfile.TemporaryDirectory` is replaced with `fs.mkdtempSync` cleanup.
 *
 *  - `random.sample(seed=42)` is replaced with a seeded mulberry32 + Knuth
 *    shuffle so sampling is deterministic across runs.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, parse as parsePath } from "node:path";

import { CompressionConfig } from "./compression-config.js";
import { TrajectoryMetrics } from "./metrics.js";
import type { TrajectoryCompressor } from "./trajectory-compressor.js";
import type { Entry, Logger } from "./types.js";

const NO_OP_LOGGER: Logger = {
  warning: () => undefined,
  error: () => undefined,
};

/** Per-entry progress event emitted by the async directory processor. */
export interface ProgressEvent {
  kind: "progress";
  /** 0-based index of the entry that just completed. */
  processedCount: number;
  totalEntries: number;
  /** Cumulative counters across the whole run. */
  compressedCount: number;
  skippedCount: number;
  timeoutCount: number;
  apiCalls: number;
  inFlight: number;
}

/** Lifecycle event emitted at the start of a directory run. */
export interface StartEvent {
  kind: "start";
  inputDir: string;
  outputDir: string;
  fileCount: number;
  totalEntries: number;
}

/** Lifecycle event emitted once the entire directory has been processed. */
export interface DoneEvent {
  kind: "done";
  totalEntries: number;
  durationSeconds: number;
}

/** Lifecycle event emitted when a per-entry error occurs. */
export interface ErrorEvent {
  kind: "error";
  filePath: string;
  entryIdx: number;
  error: string;
  isTimeout: boolean;
}

export type DirectoryProcessorEvent = StartEvent | ProgressEvent | ErrorEvent | DoneEvent;

/** Optional progress reporter callback — default is no-op. */
export type ProgressReporter = (event: DirectoryProcessorEvent) => void;

/** Options for the directory processor. */
export interface ProcessDirectoryOptions {
  /** Optional progress reporter — defaults to no-op. */
  onProgress?: ProgressReporter | undefined;
  /** Optional logger — defaults to no-op. */
  logger?: Logger | undefined;
}

/**
 * Process all `*.jsonl` files in `inputDir` and write compressed JSONL files
 * to `outputDir`. Mirrors the upstream `process_directory` flow.
 *
 * Returns the resulting aggregate metrics dict (also written to disk when
 * `config.metricsEnabled === true`).
 */
export async function processDirectory(
  compressor: TrajectoryCompressor,
  inputDir: string,
  outputDir: string,
  options: ProcessDirectoryOptions = {},
): Promise<void> {
  const onProgress = options.onProgress ?? (() => undefined);
  const logger = options.logger ?? NO_OP_LOGGER;
  const config = compressor.config;

  compressor.aggregateMetrics.processingStartTime = new Date().toISOString();
  const startTimeMs = Date.now();

  const jsonlFiles = listJsonlFiles(inputDir);
  if (jsonlFiles.length === 0) {
    logger.warning(`No JSONL files found in ${inputDir}`);
    return;
  }

  // Load all entries.
  type LoadedEntry = { filePath: string; entryIdx: number; entry: Entry };
  const allEntries: LoadedEntry[] = [];
  for (const filePath of jsonlFiles) {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    for (let lineNum = 0; lineNum < lines.length; lineNum += 1) {
      const line = lines[lineNum]!.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Entry;
        allEntries.push({ filePath, entryIdx: lineNum, entry });
      } catch (err) {
        logger.warning(
          `Skipping invalid JSON at ${filePath}:${lineNum}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const totalEntries = allEntries.length;

  onProgress({
    kind: "start",
    inputDir,
    outputDir,
    fileCount: jsonlFiles.length,
    totalEntries,
  });

  // Results map: filePath -> entryIdx -> processed entry (or null when dropped).
  const results = new Map<string, Map<number, Entry | null>>();
  for (const filePath of jsonlFiles) results.set(filePath, new Map());

  // Counters & semaphore.
  let compressedCount = 0;
  let skippedCount = 0;
  let apiCalls = 0;
  let timeoutCount = 0;
  let inFlight = 0;
  let processedCount = 0;

  const semaphore = new Semaphore(config.maxConcurrentRequests);

  const processOne = async (item: LoadedEntry): Promise<void> => {
    await semaphore.acquire();
    inFlight += 1;
    try {
      const { entry: processedEntry, metrics } = await withTimeout(
        compressor.processEntryAsync(item.entry),
        config.perTrajectoryTimeout * 1000,
      );

      results.get(item.filePath)!.set(item.entryIdx, processedEntry);
      compressor.aggregateMetrics.addTrajectoryMetrics(metrics);

      if (metrics.wasCompressed) {
        compressedCount += 1;
        apiCalls += metrics.summarizationApiCalls;
      }
      if (metrics.skippedUnderTarget) skippedCount += 1;
    } catch (err) {
      if (err instanceof TimeoutError) {
        logger.warning(
          `Timeout processing entry from ${item.filePath}:${item.entryIdx} (>${config.perTrajectoryTimeout}s)`,
        );
        compressor.aggregateMetrics.trajectoriesFailed += 1;
        timeoutCount += 1;
        results.get(item.filePath)!.set(item.entryIdx, null);
        onProgress({
          kind: "error",
          filePath: item.filePath,
          entryIdx: item.entryIdx,
          error: "timeout",
          isTimeout: true,
        });
      } else {
        // `withTimeout` (see below) wraps any non-Error rejection in
        // `new Error(String(err))` before re-throwing, so the `: String(err)`
        // arm of this ternary is unreachable in practice. Kept for parity with
        // upstream `str(e)` and to remain robust if the wrapper is replaced.
        /* v8 ignore next */
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Error processing entry from ${item.filePath}:${item.entryIdx}: ${message}`);
        compressor.aggregateMetrics.trajectoriesFailed += 1;
        // Keep original entry on error — matches upstream.
        results.get(item.filePath)!.set(item.entryIdx, item.entry);
        onProgress({
          kind: "error",
          filePath: item.filePath,
          entryIdx: item.entryIdx,
          error: message,
          isTimeout: false,
        });
      }
    } finally {
      inFlight -= 1;
      processedCount += 1;
      onProgress({
        kind: "progress",
        processedCount,
        totalEntries,
        compressedCount,
        skippedCount,
        timeoutCount,
        apiCalls,
        inFlight,
      });
      semaphore.release();
    }
  };

  await Promise.all(allEntries.map(processOne));

  // Write output files preserving original entry order.
  mkdirSync(outputDir, { recursive: true });
  for (const filePath of jsonlFiles) {
    const outputPath = join(outputDir, basename(filePath));
    const fileResults = results.get(filePath)!;
    const sortedIdx = Array.from(fileResults.keys()).sort((a, b) => a - b);

    const fd = openSync(outputPath, "w");
    try {
      for (const idx of sortedIdx) {
        const entry = fileResults.get(idx);
        if (entry === null || entry === undefined) continue; // dropped on timeout
        writeSync(fd, `${JSON.stringify(entry)}\n`);
      }
    } finally {
      closeSync(fd);
    }
  }

  compressor.aggregateMetrics.processingEndTime = new Date().toISOString();
  compressor.aggregateMetrics.processingDurationSeconds = (Date.now() - startTimeMs) / 1000;

  if (config.metricsEnabled) {
    const metricsPath = join(outputDir, config.metricsOutputFile);
    writeFileSync(
      metricsPath,
      `${JSON.stringify(compressor.aggregateMetrics.toDict(), null, 2)}\n`,
      "utf-8",
    );
  }

  onProgress({
    kind: "done",
    totalEntries,
    durationSeconds: compressor.aggregateMetrics.processingDurationSeconds,
  });
}

// ── CLI-flavored entrypoint (faithful port of `main`) ────────────────────

/** Options for the `runCli` entrypoint. */
export interface RunCliOptions {
  input: string;
  output?: string | null | undefined;
  configPath?: string | null | undefined;
  targetMaxTokens?: number | null | undefined;
  tokenizer?: string | null | undefined;
  samplePercent?: number | null | undefined;
  seed?: number | undefined;
  dryRun?: boolean | undefined;
  /**
   * Factory that constructs a `TrajectoryCompressor` given a config.
   * Required because tokenizer + LLM client implementations live in other
   * packages — the CLI doesn't bind to any concrete one.
   */
  compressorFactory: (config: CompressionConfig) => TrajectoryCompressor;
  /** Output sink for human-facing console messages. */
  console?: Pick<typeof globalThis.console, "log" | "warn"> | undefined;
  /** Progress reporter. */
  onProgress?: ProgressReporter | undefined;
  /** Logger. */
  logger?: Logger | undefined;
}

/** Result returned by `runCli` (besides side effects). */
export interface RunCliResult {
  outputPath: string | null;
  /** True when the run was a dry run / aborted early (no output produced). */
  aborted: boolean;
  /** Reason string when aborted; otherwise empty. */
  abortReason: string;
}

/**
 * Faithful port of the upstream `main()` function. Performs the input
 * file/directory branching, optional sampling, and dry-run handling.
 *
 * The compressor is constructed via the injected `compressorFactory` so the
 * CLI binding lives in the caller (typically a `bin/` script in
 * `@hermests/cli` once that package lands).
 */
export async function runCli(options: RunCliOptions): Promise<RunCliResult> {
  const consoleSink = options.console ?? globalThis.console;
  const log = (msg: string): void => consoleSink.log(msg);
  const warn = (msg: string): void => consoleSink.warn(msg);

  log("🗜️  Trajectory Compressor");
  log("=".repeat(60));

  let config: CompressionConfig;
  if (options.configPath && existsSync(options.configPath)) {
    log(`📋 Loading config from ${options.configPath}`);
    config = CompressionConfig.fromYaml(options.configPath);
  } else {
    const fallbackPath = options.configPath ?? "configs/trajectory_compression.yaml";
    log(`⚠️  Config not found at ${fallbackPath}, using defaults`);
    config = new CompressionConfig();
  }

  if (options.targetMaxTokens != null) config.targetMaxTokens = options.targetMaxTokens;
  if (options.tokenizer != null) config.tokenizerName = options.tokenizer;

  const samplePercent = options.samplePercent ?? null;
  if (samplePercent !== null) {
    if (samplePercent <= 0 || samplePercent > 100) {
      log(`❌ sample_percent must be between 1 and 100, got ${samplePercent}`);
      return { outputPath: null, aborted: true, abortReason: "invalid_sample_percent" };
    }
    log(`🎲 Will sample ${samplePercent}% of trajectories (seed=${options.seed ?? 42})`);
  }

  const inputPath = options.input;
  if (!existsSync(inputPath)) {
    log(`❌ Input not found: ${inputPath}`);
    return { outputPath: null, aborted: true, abortReason: "input_not_found" };
  }

  const isFileInput = statSync(inputPath).isFile();
  const seed = options.seed ?? 42;

  if (isFileInput) {
    log("📄 Input mode: Single JSONL file");

    const parsed = parsePath(inputPath);
    const outputPath =
      options.output ?? join(parsed.dir, `${parsed.name}${config.outputSuffix}.jsonl`);

    let entries: Entry[] = [];
    const lines = readFileSync(inputPath, "utf-8").split("\n");
    for (let lineNum = 1; lineNum <= lines.length; lineNum += 1) {
      const line = lines[lineNum - 1]!.trim();
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as Entry);
      } catch (err) {
        warn(
          `⚠️  Skipping invalid JSON at line ${lineNum}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const totalEntries = entries.length;
    log(`   Loaded ${totalEntries.toLocaleString()} trajectories from ${parsed.base}`);

    if (samplePercent !== null) {
      const sampleSize = Math.max(1, Math.floor((totalEntries * samplePercent) / 100));
      entries = seededSample(entries, sampleSize, seed);
      log(
        `   Sampled ${entries.length.toLocaleString()} trajectories (${samplePercent}% of ${totalEntries.toLocaleString()})`,
      );
    }

    if (options.dryRun ?? false) {
      log("\n🔍 DRY RUN MODE - analyzing without writing");
      log(`📄 Would process: ${entries.length.toLocaleString()} trajectories`);
      log(`📄 Would output to: ${outputPath}`);
      return { outputPath, aborted: true, abortReason: "dry_run" };
    }

    const tempDir = mkdtempSync(join(tmpdir(), "trajectory-compressor-"));
    try {
      const tempInputDir = join(tempDir, "input");
      const tempOutputDir = join(tempDir, "output");
      mkdirSync(tempInputDir, { recursive: true });

      const tempInputFile = join(tempInputDir, "trajectories.jsonl");
      const fd = openSync(tempInputFile, "w");
      try {
        for (const entry of entries) {
          writeSync(fd, `${JSON.stringify(entry)}\n`);
        }
      } finally {
        closeSync(fd);
      }

      const compressor = options.compressorFactory(config);
      await processDirectory(compressor, tempInputDir, tempOutputDir, {
        onProgress: options.onProgress,
        logger: options.logger,
      });

      mkdirSync(dirname(outputPath), { recursive: true });
      const outFd = openSync(outputPath, "w");
      try {
        for (const jsonlFile of listJsonlFiles(tempOutputDir)) {
          const data = readFileSync(jsonlFile, "utf-8");
          writeSync(outFd, data);
        }
      } finally {
        closeSync(outFd);
      }

      const metricsFile = join(tempOutputDir, config.metricsOutputFile);
      if (existsSync(metricsFile)) {
        const metricsName = `${parsePath(outputPath).name}_metrics.json`;
        const metricsOutput = join(dirname(outputPath), metricsName);
        writeFileSync(metricsOutput, readFileSync(metricsFile));
        log(`💾 Metrics saved to ${metricsOutput}`);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    log("\n✅ Compression complete!");
    log(`📄 Output: ${outputPath}`);
    return { outputPath, aborted: false, abortReason: "" };
  }

  // Directory input.
  log("📁 Input mode: Directory of JSONL files");

  const outputPath =
    options.output ?? join(dirname(inputPath), basename(inputPath) + config.outputSuffix);

  if (samplePercent !== null) {
    log(`\n⚠️  Sampling from directory: will sample ${samplePercent}% from each file`);

    const tempDir = mkdtempSync(join(tmpdir(), "trajectory-compressor-"));
    try {
      const tempInputDir = join(tempDir, "input");
      mkdirSync(tempInputDir, { recursive: true });

      let totalOriginal = 0;
      let totalSampled = 0;
      let rotatingSeed = seed;

      for (const jsonlFile of listJsonlFiles(inputPath)) {
        const fileEntries: Entry[] = [];
        for (const line of readFileSync(jsonlFile, "utf-8").split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            fileEntries.push(JSON.parse(trimmed) as Entry);
          } catch {
            // matches upstream silent skip
          }
        }
        totalOriginal += fileEntries.length;
        const sampleSize = Math.max(1, Math.floor((fileEntries.length * samplePercent) / 100));
        const sampled = seededSample(
          fileEntries,
          Math.min(sampleSize, fileEntries.length),
          rotatingSeed,
        );
        // Advance the seed per-file so sample order doesn't repeat across files
        // (Python's random.sample shares a global RNG state — this matches the
        // "progresses through the stream" semantics without a global singleton).
        rotatingSeed = mulberry32(rotatingSeed)() * 0xffffffff;
        totalSampled += sampled.length;

        const tempFile = join(tempInputDir, basename(jsonlFile));
        const fd = openSync(tempFile, "w");
        try {
          for (const entry of sampled) {
            writeSync(fd, `${JSON.stringify(entry)}\n`);
          }
        } finally {
          closeSync(fd);
        }
      }

      log(
        `   Sampled ${totalSampled.toLocaleString()} from ${totalOriginal.toLocaleString()} total trajectories`,
      );

      if (options.dryRun ?? false) {
        log("\n🔍 DRY RUN MODE - analyzing without writing");
        log(`📁 Would process: ${tempInputDir}`);
        log(`📁 Would output to: ${outputPath}`);
        return { outputPath, aborted: true, abortReason: "dry_run" };
      }

      const compressor = options.compressorFactory(config);
      await processDirectory(compressor, tempInputDir, outputPath, {
        onProgress: options.onProgress,
        logger: options.logger,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    if (options.dryRun ?? false) {
      log("\n🔍 DRY RUN MODE - analyzing without writing");
      log(`📁 Would process: ${inputPath}`);
      log(`📁 Would output to: ${outputPath}`);
      return { outputPath, aborted: true, abortReason: "dry_run" };
    }
    const compressor = options.compressorFactory(config);
    await processDirectory(compressor, inputPath, outputPath, {
      onProgress: options.onProgress,
      logger: options.logger,
    });
  }

  log("\n✅ Compression complete!");
  return { outputPath, aborted: false, abortReason: "" };
}

// ── Internals ────────────────────────────────────────────────────────────

/** Async semaphore for bounded concurrency. */
class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(initial: number) {
    this.permits = initial;
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits += 1;
  }
}

/** Error type thrown when `withTimeout` fires. */
export class TimeoutError extends Error {
  constructor(message = "timeout") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Wrap `promise` with a timeout. Rejects with `TimeoutError` after `ms`. The
 * underlying promise keeps running — matches Python's `asyncio.wait_for`
 * which cancels the inner task; in JS we can't cancel arbitrary Promises,
 * but the caller drops the reference and the result is discarded.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** List `*.jsonl` files in `dir`, sorted by filename. */
function listJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => extname(name).toLowerCase() === ".jsonl")
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Seeded sample-without-replacement — Fisher-Yates with a mulberry32 PRNG.
 * Mirrors `random.seed(seed); random.sample(xs, k)`.
 */
function seededSample<T>(xs: readonly T[], k: number, seed: number): T[] {
  const arr = xs.slice();
  const rng = mulberry32(seed);
  const n = arr.length;
  const sampleSize = Math.min(k, n);
  for (let i = 0; i < sampleSize; i += 1) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr.slice(0, sampleSize);
}

/** Mulberry32 PRNG — same algorithm as `backoff.ts`'s internal RNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
