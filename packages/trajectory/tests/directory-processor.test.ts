import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompressionConfig } from "../src/compression-config.js";
import {
  type DirectoryProcessorEvent,
  type ProcessDirectoryOptions,
  TimeoutError,
  processDirectory,
  runCli,
  withTimeout,
} from "../src/directory-processor.js";
import {
  TrajectoryCompressor,
  type TrajectoryCompressorOptions,
} from "../src/trajectory-compressor.js";
import type { AsyncLlmClient, LlmClientPair, SyncLlmClient, Tokenizer } from "../src/types.js";

const tokenizer: Tokenizer = {
  encode(text) {
    return new Array(Math.floor(text.length / 4)).fill(0);
  },
};

function makeSyncClient(): SyncLlmClient {
  return {
    createChatCompletion: vi.fn(() => ({
      choices: [{ message: { content: "[CONTEXT SUMMARY]: hi" } }],
    })),
  };
}

function makeAsyncClient(content = "[CONTEXT SUMMARY]: hi"): AsyncLlmClient {
  return {
    createChatCompletion: vi.fn(() =>
      Promise.resolve({
        choices: [{ message: { content } }],
      }),
    ),
  };
}

function makeCompressor(
  config: CompressionConfig,
  asyncClient?: AsyncLlmClient,
): TrajectoryCompressor {
  const llmClient: LlmClientPair = {
    sync: makeSyncClient(),
    async: asyncClient ?? makeAsyncClient(),
  };
  const options: TrajectoryCompressorOptions = {
    tokenizer,
    llmClient,
    sleep: async () => undefined,
    backoff: () => 0,
  };
  return new TrajectoryCompressor(config, options);
}

describe("withTimeout", () => {
  it("resolves the inner promise's value", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100)).resolves.toBe("ok");
  });

  it("rejects with TimeoutError after the timeout", async () => {
    await expect(withTimeout(new Promise<string>(() => {}), 5)).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it("propagates inner rejection (Error)", async () => {
    await expect(withTimeout(Promise.reject(new Error("nope")), 100)).rejects.toThrow("nope");
  });

  it("propagates inner rejection (non-Error wraps to Error)", async () => {
    await expect(withTimeout(Promise.reject("stringy"), 100)).rejects.toThrow("stringy");
  });
});

describe("processDirectory", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "trajectory-dir-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeJsonl(path: string, entries: Array<Record<string, unknown>>): void {
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  }

  it("logs and bails when no JSONL files present", async () => {
    const cfg = new CompressionConfig();
    const compressor = makeCompressor(cfg);
    const warnings: string[] = [];
    await processDirectory(compressor, tmp, join(tmp, "out"), {
      logger: { warning: (m) => warnings.push(m), error: () => undefined },
    });
    expect(warnings.some((m) => m.includes("No JSONL files found"))).toBe(true);
  });

  it("processes a single small JSONL file end-to-end", async () => {
    const inputDir = join(tmp, "in");
    const outputDir = join(tmp, "out");
    mkdirSync(inputDir, { recursive: true });
    const file = join(inputDir, "small.jsonl");
    writeJsonl(file, [
      { id: 1, conversations: [{ from: "system", value: "small" }] },
      { id: 2 }, // entry without conversations
    ]);

    const cfg = new CompressionConfig({ targetMaxTokens: 100_000 });
    const compressor = makeCompressor(cfg);

    const events: DirectoryProcessorEvent[] = [];
    const opts: ProcessDirectoryOptions = { onProgress: (e) => events.push(e) };
    await processDirectory(compressor, inputDir, outputDir, opts);

    expect(events.find((e) => e.kind === "start")?.kind).toBe("start");
    expect(events.find((e) => e.kind === "done")?.kind).toBe("done");

    const outFile = join(outputDir, "small.jsonl");
    const outText = readFileSync(outFile, "utf-8").trim().split("\n");
    expect(outText.length).toBe(2);

    const metricsPath = join(outputDir, "compression_metrics.json");
    expect(existsSync(metricsPath)).toBe(true);
    const m = JSON.parse(readFileSync(metricsPath, "utf-8"));
    expect(m.summary.total_trajectories).toBe(2);
  });

  it("skips invalid JSON lines and logs a warning", async () => {
    const inputDir = join(tmp, "in");
    const outputDir = join(tmp, "out");
    mkdirSync(inputDir, { recursive: true });
    const file = join(inputDir, "x.jsonl");
    writeFileSync(file, `not-valid-json\n${JSON.stringify({ id: 1 })}\n`, "utf-8");

    const cfg = new CompressionConfig();
    const compressor = makeCompressor(cfg);
    const warnings: string[] = [];
    await processDirectory(compressor, inputDir, outputDir, {
      logger: { warning: (m) => warnings.push(m), error: () => undefined },
    });
    expect(warnings.some((m) => m.includes("Skipping invalid JSON"))).toBe(true);
  });

  it("times out long-running entries and drops them from output", async () => {
    const inputDir = join(tmp, "in");
    const outputDir = join(tmp, "out");
    mkdirSync(inputDir, { recursive: true });
    const file = join(inputDir, "x.jsonl");
    // 10-turn trajectory so middle is compressible — forces async LLM call.
    writeJsonl(file, [
      {
        id: 1,
        conversations: [
          { from: "system", value: "sys-content" },
          { from: "human", value: "human-content" },
          { from: "gpt", value: "gpt-content-aa" },
          { from: "tool", value: "tool-content-aa" },
          { from: "gpt", value: "mid-1-content" },
          { from: "tool", value: "mid-2-content" },
          { from: "gpt", value: "mid-3-content" },
          { from: "tool", value: "mid-4-content" },
          { from: "gpt", value: "tail-1-content" },
          { from: "gpt", value: "tail-2-content" },
        ],
      },
    ]);

    // Async client that never resolves
    const slowAsync: AsyncLlmClient = {
      createChatCompletion: vi.fn(
        () => new Promise<never>(() => {}) as ReturnType<AsyncLlmClient["createChatCompletion"]>,
      ),
    };
    const cfg = new CompressionConfig({
      targetMaxTokens: 8,
      summaryTargetTokens: 2,
      protectLastNTurns: 2,
      maxRetries: 1,
      perTrajectoryTimeout: 0.02, // 20 ms
    });
    const compressor = makeCompressor(cfg, slowAsync);
    const events: DirectoryProcessorEvent[] = [];
    await processDirectory(compressor, inputDir, outputDir, {
      onProgress: (e) => events.push(e),
      logger: { warning: () => undefined, error: () => undefined },
    });

    const outFile = join(outputDir, "x.jsonl");
    expect(readFileSync(outFile, "utf-8")).toBe("");
    expect(events.some((e) => e.kind === "error" && e.isTimeout === true)).toBe(true);
  });

  it("keeps the original entry on a non-timeout error", async () => {
    const inputDir = join(tmp, "in");
    const outputDir = join(tmp, "out");
    mkdirSync(inputDir, { recursive: true });
    const file = join(inputDir, "x.jsonl");
    writeJsonl(file, [{ id: 1, conversations: [{ from: "system", value: "abcd" }] }]);

    // Async client that always throws — but only after maxRetries exhaust, the
    // compressor returns a fallback summary. Cause failure in processEntryAsync by
    // throwing from countTokens via a broken tokenizer instead.
    const badTokenizer: Tokenizer = {
      encode() {
        throw new Error("boom");
      },
    };
    const cfg = new CompressionConfig({ targetMaxTokens: 100_000 });
    const llmClient: LlmClientPair = { sync: makeSyncClient(), async: makeAsyncClient() };
    const compressor = new TrajectoryCompressor(cfg, {
      tokenizer: badTokenizer,
      llmClient,
    });

    // Force processEntryAsync to throw by stubbing it.
    vi.spyOn(compressor, "processEntryAsync").mockRejectedValue(new Error("explode"));

    const events: DirectoryProcessorEvent[] = [];
    const errors: string[] = [];
    await processDirectory(compressor, inputDir, outputDir, {
      onProgress: (e) => events.push(e),
      logger: { warning: () => undefined, error: (m) => errors.push(m) },
    });

    const outText = readFileSync(join(outputDir, "x.jsonl"), "utf-8").trim();
    expect(outText).toContain('"id":1');
    expect(events.some((e) => e.kind === "error" && e.isTimeout === false)).toBe(true);
    expect(errors.some((m) => m.includes("explode"))).toBe(true);
  });

  it("does not write metrics file when metricsEnabled is false", async () => {
    const inputDir = join(tmp, "in");
    const outputDir = join(tmp, "out");
    mkdirSync(inputDir, { recursive: true });
    const file = join(inputDir, "x.jsonl");
    writeJsonl(file, [{ id: 1 }]);

    const cfg = new CompressionConfig({ metricsEnabled: false });
    const compressor = makeCompressor(cfg);
    await processDirectory(compressor, inputDir, outputDir);

    expect(existsSync(join(outputDir, "compression_metrics.json"))).toBe(false);
  });

  it("counts compressed trajectories and propagates api_calls in progress events", async () => {
    const inputDir = join(tmp, "in");
    const outputDir = join(tmp, "out");
    mkdirSync(inputDir, { recursive: true });
    writeJsonl(join(inputDir, "x.jsonl"), [
      {
        id: 1,
        conversations: [
          { from: "system", value: "sys-content" },
          { from: "human", value: "human-content" },
          { from: "gpt", value: "gpt-content-aa" },
          { from: "tool", value: "tool-content-aa" },
          { from: "gpt", value: "mid-1-content" },
          { from: "tool", value: "mid-2-content" },
          { from: "gpt", value: "mid-3-content" },
          { from: "tool", value: "mid-4-content" },
          { from: "gpt", value: "tail-1-content" },
          { from: "gpt", value: "tail-2-content" },
        ],
      },
    ]);
    const cfg = new CompressionConfig({
      targetMaxTokens: 8,
      summaryTargetTokens: 2,
      protectLastNTurns: 2,
      maxRetries: 1,
    });
    const compressor = makeCompressor(cfg);
    const events: DirectoryProcessorEvent[] = [];
    await processDirectory(compressor, inputDir, outputDir, {
      onProgress: (e) => events.push(e),
    });
    const lastProgress = events.filter((e) => e.kind === "progress").at(-1) as Extract<
      DirectoryProcessorEvent,
      { kind: "progress" }
    >;
    expect(lastProgress.compressedCount).toBe(1);
    expect(lastProgress.apiCalls).toBeGreaterThanOrEqual(1);
  });

  it("propagates non-Error throws from the entry processor", async () => {
    const inputDir = join(tmp, "in");
    const outputDir = join(tmp, "out");
    mkdirSync(inputDir, { recursive: true });
    writeJsonl(join(inputDir, "x.jsonl"), [
      { id: 1, conversations: [{ from: "system", value: "abcd" }] },
    ]);

    const cfg = new CompressionConfig({ targetMaxTokens: 100_000 });
    const compressor = makeCompressor(cfg);
    // Stub processEntryAsync to reject with a non-Error (string)
    vi.spyOn(compressor, "processEntryAsync").mockRejectedValue("string-thrown");

    const errors: string[] = [];
    await processDirectory(compressor, inputDir, outputDir, {
      logger: { warning: () => undefined, error: (m) => errors.push(m) },
    });
    expect(errors.some((m) => m.includes("string-thrown"))).toBe(true);
  });

  it("respects maxConcurrentRequests semaphore (queues beyond limit)", async () => {
    const inputDir = join(tmp, "in");
    const outputDir = join(tmp, "out");
    mkdirSync(inputDir, { recursive: true });
    const file = join(inputDir, "x.jsonl");
    writeJsonl(
      file,
      Array.from({ length: 4 }, (_, i) => ({
        id: i,
        conversations: [{ from: "system", value: "abcd" }],
      })),
    );

    const cfg = new CompressionConfig({
      targetMaxTokens: 100_000,
      maxConcurrentRequests: 1,
    });
    const compressor = makeCompressor(cfg);

    let maxInFlight = 0;
    await processDirectory(compressor, inputDir, outputDir, {
      onProgress: (e) => {
        if (e.kind === "progress") {
          maxInFlight = Math.max(maxInFlight, e.inFlight);
        }
      },
    });
    // We can't enforce strict ordering, but the semaphore should prevent
    // arbitrarily many simultaneous in-flight tasks.
    expect(maxInFlight).toBeLessThanOrEqual(1);
  });
});

describe("runCli", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "trajectory-cli-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function silentConsole(): {
    log: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  } {
    return { log: vi.fn(), warn: vi.fn() };
  }

  it("file input — dry run aborts without writing", async () => {
    const inputFile = join(tmp, "input.jsonl");
    writeFileSync(inputFile, `${JSON.stringify({ id: 1 })}\n`, "utf-8");

    const result = await runCli({
      input: inputFile,
      dryRun: true,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console: silentConsole(),
    });
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe("dry_run");
  });

  it("file input — invalid samplePercent aborts", async () => {
    const inputFile = join(tmp, "input.jsonl");
    writeFileSync(inputFile, "{}\n", "utf-8");
    const result = await runCli({
      input: inputFile,
      samplePercent: 200,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console: silentConsole(),
    });
    expect(result.abortReason).toBe("invalid_sample_percent");
  });

  it("returns input_not_found when the input path does not exist", async () => {
    const result = await runCli({
      input: join(tmp, "does-not-exist"),
      compressorFactory: (cfg) => makeCompressor(cfg),
      console: silentConsole(),
    });
    expect(result.abortReason).toBe("input_not_found");
  });

  it("file input — loads config when path exists", async () => {
    const cfgFile = join(tmp, "config.yaml");
    writeFileSync(cfgFile, "compression:\n  target_max_tokens: 50000\n", "utf-8");
    const inputFile = join(tmp, "input.jsonl");
    writeFileSync(inputFile, `${JSON.stringify({ id: 1 })}\n`, "utf-8");

    const result = await runCli({
      input: inputFile,
      configPath: cfgFile,
      compressorFactory: (cfg) => {
        expect(cfg.targetMaxTokens).toBe(50000);
        return makeCompressor(cfg);
      },
      console: silentConsole(),
    });
    expect(result.aborted).toBe(false);
  });

  it("file input — fallback config message when config not found", async () => {
    const inputFile = join(tmp, "input.jsonl");
    writeFileSync(inputFile, `${JSON.stringify({ id: 1 })}\n`, "utf-8");
    const console = silentConsole();
    await runCli({
      input: inputFile,
      configPath: join(tmp, "missing.yaml"),
      compressorFactory: (cfg) => makeCompressor(cfg),
      console,
    });
    const logs = console.log.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toContain("Config not found");
  });

  it("file input — overrides targetMaxTokens and tokenizer", async () => {
    const inputFile = join(tmp, "input.jsonl");
    writeFileSync(inputFile, `${JSON.stringify({ id: 1 })}\n`, "utf-8");
    await runCli({
      input: inputFile,
      targetMaxTokens: 99,
      tokenizer: "tk",
      compressorFactory: (cfg) => {
        expect(cfg.targetMaxTokens).toBe(99);
        expect(cfg.tokenizerName).toBe("tk");
        return makeCompressor(cfg);
      },
      console: silentConsole(),
    });
  });

  it("file input — samplePercent reduces entry count", async () => {
    const inputFile = join(tmp, "input.jsonl");
    const entries = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    writeFileSync(inputFile, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");
    const outputFile = join(tmp, "out.jsonl");
    let factoryCalled = false;
    await runCli({
      input: inputFile,
      output: outputFile,
      samplePercent: 20,
      seed: 1,
      compressorFactory: (cfg) => {
        factoryCalled = true;
        return makeCompressor(cfg);
      },
      console: silentConsole(),
    });
    expect(factoryCalled).toBe(true);
    expect(existsSync(outputFile)).toBe(true);
    const lines = readFileSync(outputFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2); // 20% of 10
  });

  it("file input — skips invalid JSON lines and logs a warning", async () => {
    const inputFile = join(tmp, "input.jsonl");
    writeFileSync(inputFile, "broken\n{}\n", "utf-8");
    const console = silentConsole();
    await runCli({
      input: inputFile,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console,
    });
    const warns = console.warn.mock.calls.map((c) => c[0]).join("\n");
    expect(warns).toContain("Skipping invalid JSON");
  });

  it("file input — writes metrics-summary file when present in temp output", async () => {
    const inputFile = join(tmp, "input.jsonl");
    writeFileSync(inputFile, `${JSON.stringify({ id: 1 })}\n`, "utf-8");
    const outputFile = join(tmp, "compressed.jsonl");
    const console = silentConsole();
    await runCli({
      input: inputFile,
      output: outputFile,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console,
    });
    const metricsFile = join(tmp, "compressed_metrics.json");
    expect(existsSync(metricsFile)).toBe(true);
  });

  it("directory input — dry run aborts", async () => {
    const inputDir = join(tmp, "in");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "x.jsonl"), `${JSON.stringify({ id: 1 })}\n`, "utf-8");
    const result = await runCli({
      input: inputDir,
      dryRun: true,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console: silentConsole(),
    });
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe("dry_run");
  });

  it("directory input — happy path writes compressed dir", async () => {
    const inputDir = join(tmp, "in");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "x.jsonl"), `${JSON.stringify({ id: 1 })}\n`, "utf-8");
    const result = await runCli({
      input: inputDir,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console: silentConsole(),
    });
    expect(result.aborted).toBe(false);
    expect(result.outputPath).toBeTruthy();
    expect(existsSync(join(result.outputPath as string, "x.jsonl"))).toBe(true);
  });

  it("directory input — sampling writes a reduced output", async () => {
    const inputDir = join(tmp, "in");
    mkdirSync(inputDir);
    const entries = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    writeFileSync(
      join(inputDir, "x.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n"),
      "utf-8",
    );
    const outDir = join(tmp, "out");
    const result = await runCli({
      input: inputDir,
      output: outDir,
      samplePercent: 10,
      seed: 7,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console: silentConsole(),
    });
    expect(result.aborted).toBe(false);
    const lines = readFileSync(join(outDir, "x.jsonl"), "utf-8").trim().split("\n");
    expect(lines.length).toBe(2); // 10% of 20
  });

  it("directory input — sampling dry-run aborts", async () => {
    const inputDir = join(tmp, "in");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "x.jsonl"), `${JSON.stringify({ id: 1 })}\n`, "utf-8");
    const result = await runCli({
      input: inputDir,
      samplePercent: 50,
      dryRun: true,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console: silentConsole(),
    });
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe("dry_run");
  });

  it("directory input — sampling silently skips invalid JSON", async () => {
    const inputDir = join(tmp, "in");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "x.jsonl"), "broken\n{}\n", "utf-8");
    const result = await runCli({
      input: inputDir,
      samplePercent: 100,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console: silentConsole(),
    });
    expect(result.aborted).toBe(false);
  });

  it("file input — uses default output path when none provided", async () => {
    const inputFile = join(tmp, "input.jsonl");
    writeFileSync(inputFile, `${JSON.stringify({ id: 1 })}\n`, "utf-8");
    const result = await runCli({
      input: inputFile,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console: silentConsole(),
    });
    expect(result.outputPath).toBe(join(tmp, "input_compressed.jsonl"));
  });

  it("uses default seed (42) when seed unspecified with sampling", async () => {
    const inputFile = join(tmp, "input.jsonl");
    const entries = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    writeFileSync(inputFile, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");
    const console = silentConsole();
    await runCli({
      input: inputFile,
      samplePercent: 50,
      compressorFactory: (cfg) => makeCompressor(cfg),
      console,
    });
    const logs = console.log.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toContain("seed=42");
  });
});
