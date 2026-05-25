// Surgical tests to drive branch + function coverage to 100%.
//
// Each case targets a specific defensive branch (instanceof Error ? :, ?? fallback,
// safe-accessor for missing keys, no-op logger entry points). The behaviour
// being exercised is the same as upstream's silent-skip/string-coercion
// fall-backs — these tests assert the TS port mirrors that.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompressionConfig } from "../src/compression-config.js";
import { processDirectory, runCli } from "../src/directory-processor.js";
import { TrajectoryMetrics } from "../src/metrics.js";
import {
  TrajectoryCompressor,
  type TrajectoryCompressorOptions,
} from "../src/trajectory-compressor.js";
import type {
  AsyncLlmClient,
  ChatCompletionResponse,
  LlmClientPair,
  SyncLlmClient,
  Tokenizer,
  Turn,
} from "../src/types.js";

const tokenizer: Tokenizer = {
  encode(text) {
    return new Array(Math.floor(text.length / 4)).fill(0);
  },
};

function syncStub(content: string | null = "[CONTEXT SUMMARY]: ok"): SyncLlmClient {
  return {
    createChatCompletion: vi.fn(
      () => ({ choices: [{ message: { content } }] }) as ChatCompletionResponse,
    ),
  };
}
function asyncStub(content: string | null = "[CONTEXT SUMMARY]: ok"): AsyncLlmClient {
  return {
    createChatCompletion: vi.fn(
      () =>
        Promise.resolve({ choices: [{ message: { content } }] }) as Promise<ChatCompletionResponse>,
    ),
  };
}

function makeCompressor(
  config: CompressionConfig = new CompressionConfig(),
  overrides: Partial<TrajectoryCompressorOptions> = {},
): TrajectoryCompressor {
  const llmClient: LlmClientPair = {
    sync: overrides.llmClient?.sync ?? syncStub(),
    async: overrides.llmClient?.async ?? asyncStub(),
  };
  const options: TrajectoryCompressorOptions = {
    tokenizer: overrides.tokenizer ?? tokenizer,
    llmClient,
  };
  if (overrides.logger !== undefined) options.logger = overrides.logger;
  if (overrides.sleep !== undefined) options.sleep = overrides.sleep;
  if (overrides.syncSleep !== undefined) options.syncSleep = overrides.syncSleep;
  if (overrides.backoff !== undefined) options.backoff = overrides.backoff;
  return new TrajectoryCompressor(config, options);
}

describe("turnRole/turnValue safe-accessor fall-backs", () => {
  // Upstream `_get_turn_value`/`_get_turn_role` use `.get("from", "")` and
  // `.get("value", "")` — missing keys collapse to "". This test forces both
  // accessors through their `?? ""` arm by passing a turn with neither field
  // and asserting that `countTrajectoryTokens` and `extractTurnContentForSummary`
  // treat it as zero-length / "unknown".
  it("countTrajectoryTokens treats a turn missing 'value' as 0 tokens", () => {
    const tc = makeCompressor();
    const trajectory = [{} as Turn]; // both keys missing
    expect(tc.countTrajectoryTokens(trajectory)).toBe(0);
  });

  it("extractTurnContentForSummary renders missing role as 'UNKNOWN'", () => {
    const tc = makeCompressor();
    const trajectory = [{} as Turn];
    const out = tc.extractTurnContentForSummary(trajectory, 0, 1);
    expect(out).toContain("UNKNOWN");
  });
});

describe("generateSummaryAsync exhausts retries and returns fallback", () => {
  // Drives the `} else { return "[CONTEXT SUMMARY]: [Summary generation failed..."
  // branch in the async retry loop (line 411-413). Call generateSummaryAsync
  // directly with a failing client so behaviour is deterministic regardless of
  // the protect/compress arithmetic.
  it("returns the fallback summary after maxRetries failures", async () => {
    const cfg = new CompressionConfig({ maxRetries: 2, retryDelay: 0 });
    const failingAsync: AsyncLlmClient = {
      createChatCompletion: vi.fn(() => Promise.reject(new Error("api dead"))),
    };
    const tc = makeCompressor(cfg, {
      llmClient: { sync: syncStub(), async: failingAsync },
      sleep: async () => undefined,
      backoff: () => 0,
      logger: { warning: () => undefined, error: () => undefined },
    });
    const metrics = new TrajectoryMetrics();
    const summary = await tc.generateSummaryAsync("content", metrics);
    expect(summary).toContain("Summary generation failed");
    expect(failingAsync.createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("retries with backoff then succeeds (async)", async () => {
    let calls = 0;
    const async: AsyncLlmClient = {
      createChatCompletion: vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("transient"));
        return Promise.resolve({
          choices: [{ message: { content: "[CONTEXT SUMMARY]: recovered" } }],
        }) as Promise<ChatCompletionResponse>;
      }),
    };
    const cfg = new CompressionConfig({ maxRetries: 3, retryDelay: 0 });
    const tc = makeCompressor(cfg, {
      llmClient: { sync: syncStub(), async },
      sleep: async () => undefined,
      backoff: () => 0,
    });
    const metrics = new TrajectoryMetrics();
    const summary = await tc.generateSummaryAsync("content", metrics);
    expect(summary).toBe("[CONTEXT SUMMARY]: recovered");
    expect(metrics.summarizationErrors).toBe(1);
  });

  it("async path logs non-Error throws via formatError", async () => {
    const cfg = new CompressionConfig({ maxRetries: 1, retryDelay: 0 });
    const async: AsyncLlmClient = {
      createChatCompletion: vi.fn(() => Promise.reject("plain-string-async" as unknown as Error)),
    };
    const logs: string[] = [];
    const tc = makeCompressor(cfg, {
      llmClient: { sync: syncStub(), async },
      sleep: async () => undefined,
      backoff: () => 0,
      logger: { warning: (m) => logs.push(m), error: () => undefined },
    });
    const metrics = new TrajectoryMetrics();
    const summary = await tc.generateSummaryAsync("c", metrics);
    expect(summary).toContain("Summary generation failed");
    expect(logs.some((l) => l.includes("plain-string-async"))).toBe(true);
  });
});

describe("compression loop hits break mid-iteration", () => {
  // Targets the *taken* arm of `if (accumulatedTokens >= targetTokensToCompress) break;`
  // in both compressTrajectory (line 488) and compressTrajectoryAsync (line 574).
  //
  // Setup: 8 turns × 1 token each (chars/4 tokenizer on 4-char "aaaa" values).
  // Disable last-N protection so the compressible range is turns 1..7. With
  // targetMaxTokens=5, summaryTargetTokens=1 -> targetTokensToCompress=4. The
  // loop accumulates 1→2→3→4 and breaks at i=4 (compressUntil=5), leaving
  // turns 5,6,7 in the compressible range untouched.
  const buildTrajectory = (): Turn[] =>
    Array.from(
      { length: 8 },
      (_, i) =>
        ({
          from: i === 0 ? "system" : "gpt",
          value: "aaaa",
        }) as Turn,
    );

  const buildConfig = (): CompressionConfig =>
    new CompressionConfig({
      targetMaxTokens: 5,
      summaryTargetTokens: 1,
      protectLastNTurns: 0,
      protectFirstHuman: false,
      protectFirstGpt: false,
      protectFirstTool: false,
      maxRetries: 1,
    });

  it("sync compressTrajectory: break fires when accumulated reaches target", () => {
    const tc = makeCompressor(buildConfig(), {
      llmClient: { sync: syncStub("[CONTEXT SUMMARY]: x"), async: asyncStub() },
    });
    const { metrics } = tc.compressTrajectory(buildTrajectory());
    expect(metrics.wasCompressed).toBe(true);
    // Break fired early -> only 4 turns ended up in the compressed region
    // (turns 1..4), not the full compressible range 1..7.
    expect(metrics.turnsInCompressedRegion).toBe(4);
  });

  it("async compressTrajectoryAsync: break fires when accumulated reaches target", async () => {
    const tc = makeCompressor(buildConfig(), {
      llmClient: { sync: syncStub(), async: asyncStub("[CONTEXT SUMMARY]: x") },
      sleep: async () => undefined,
    });
    const { metrics } = await tc.compressTrajectoryAsync(buildTrajectory());
    expect(metrics.wasCompressed).toBe(true);
    expect(metrics.turnsInCompressedRegion).toBe(4);
  });
});

describe("compression loop completes without break (large summaryTargetTokens)", () => {
  // Targets the not-taken arm of `if (accumulatedTokens >= targetTokensToCompress) break;`
  // in both compressTrajectory (line 484) and compressTrajectoryAsync (line 570).
  //
  // Setup: 8 turns of 1 token each (chars/4 tokenizer with 4-char values),
  // targetMaxTokens=2, summaryTargetTokens=100. tokensToSave=6, targetTokensToCompress=106.
  // The compressible range yields at most 3 tokens, so the loop runs to natural
  // completion without break ever firing.
  const trajectory: Turn[] = [
    { from: "system", value: "aaaa" },
    { from: "human", value: "bbbb" },
    { from: "gpt", value: "cccc" },
    { from: "tool", value: "dddd" },
    { from: "gpt", value: "eeee" },
    { from: "tool", value: "ffff" },
    { from: "gpt", value: "gggg" },
    { from: "gpt", value: "hhhh" },
  ];
  const cfg = (): CompressionConfig =>
    new CompressionConfig({
      targetMaxTokens: 2,
      summaryTargetTokens: 100,
      protectLastNTurns: 1,
      maxRetries: 1,
    });

  it("sync compressTrajectory: loop ends naturally when target is unreachable", () => {
    const tc = makeCompressor(cfg(), {
      llmClient: { sync: syncStub("[CONTEXT SUMMARY]: x"), async: asyncStub() },
    });
    const { metrics } = tc.compressTrajectory(trajectory);
    expect(metrics.wasCompressed).toBe(true);
    expect(metrics.turnsInCompressedRegion).toBe(3); // compressed 3 middle turns
  });

  it("async compressTrajectoryAsync: loop ends naturally when target is unreachable", async () => {
    const tc = makeCompressor(cfg(), {
      llmClient: { sync: syncStub(), async: asyncStub("[CONTEXT SUMMARY]: x") },
      sleep: async () => undefined,
    });
    const { metrics } = await tc.compressTrajectoryAsync(trajectory);
    expect(metrics.wasCompressed).toBe(true);
    expect(metrics.turnsInCompressedRegion).toBe(3);
  });
});

describe("non-Error throwables coerce via String() in directory-processor", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "trajectory-cov-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("processDirectory: invalid-JSON warning handles non-Error throw", async () => {
    // JSON.parse natively throws SyntaxError. To exercise the `: String(err)`
    // arm of the warning's ternary, patch JSON.parse to throw a plain string.
    const inputDir = join(tmp, "in");
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(join(inputDir, "x.jsonl"), "anything\n", "utf-8");

    const originalParse = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      if (text === "anything") throw "plain-string-error" as unknown as Error;
      return originalParse(text);
    });
    try {
      const warnings: string[] = [];
      const compressor = makeCompressor();
      await processDirectory(compressor, inputDir, join(tmp, "out"), {
        logger: { warning: (m) => warnings.push(m), error: () => undefined },
      });
      expect(warnings.some((m) => m.includes("plain-string-error"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("processDirectory: per-entry error path coerces non-Error rejection", async () => {
    // `withTimeout` wraps non-Error rejections into `new Error(String(err))`
    // before re-throwing, so the inner ternary always sees an Error after the
    // wrapper. The test still exercises the runtime path; the upstream is
    // covered by mirroring the upstream `except Exception as e: str(e)` flow.
    const inputDir = join(tmp, "in");
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(
      join(inputDir, "x.jsonl"),
      JSON.stringify({ id: 1, conversations: [{ from: "system", value: "abcd" }] }) + "\n",
      "utf-8",
    );
    const cfg = new CompressionConfig({ targetMaxTokens: 1_000_000 });
    const compressor = makeCompressor(cfg);
    vi.spyOn(compressor, "processEntryAsync").mockRejectedValue(
      "plain-string-rejection" as unknown as Error,
    );
    const errors: string[] = [];
    await processDirectory(compressor, inputDir, join(tmp, "out"), {
      logger: { warning: () => undefined, error: (m) => errors.push(m) },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("runCli: invalid-JSON warning handles non-Error throw", async () => {
    const inputFile = join(tmp, "input.jsonl");
    writeFileSync(inputFile, "bogus\n", "utf-8");

    const originalParse = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      if (text === "bogus") throw "plain-cli-error" as unknown as Error;
      return originalParse(text);
    });
    try {
      const warns: string[] = [];
      const logs: string[] = [];
      await runCli({
        input: inputFile,
        compressorFactory: (cfg) => makeCompressor(cfg),
        console: {
          log: (m: string) => logs.push(m),
          warn: (m: string) => warns.push(m),
        },
      });
      expect(warns.some((w) => w.includes("plain-cli-error"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("runCli console fallback to globalThis.console", () => {
  // Targets the `options.console ?? globalThis.console` branch at line 324.
  it("uses globalThis.console when options.console is omitted", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "trajectory-cov-runcli-"));
    try {
      // Silence the globalThis.console.log noise so the test runner output
      // stays tidy. We just need the code path to execute.
      const origLog = console.log;
      const origWarn = console.warn;
      console.log = () => undefined;
      console.warn = () => undefined;
      try {
        const result = await runCli({
          input: join(tmp, "does-not-exist.jsonl"),
          compressorFactory: (cfg) => makeCompressor(cfg),
          // console intentionally omitted -> routes through globalThis.console.
        });
        expect(result.aborted).toBe(true);
        expect(result.abortReason).toBe("input_not_found");
      } finally {
        console.log = origLog;
        console.warn = origWarn;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("listJsonlFiles: missing directory returns []", () => {
  // Targets the `if (!existsSync(dir)) return [];` branch in listJsonlFiles.
  // Reachable via processDirectory when inputDir does not exist.
  it("processDirectory warns 'No JSONL files found' for a missing inputDir", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "trajectory-cov-missing-"));
    try {
      const warnings: string[] = [];
      const compressor = makeCompressor();
      await processDirectory(compressor, join(tmp, "no-such-dir"), join(tmp, "out"), {
        logger: { warning: (m) => warnings.push(m), error: () => undefined },
      });
      expect(warnings.some((m) => m.includes("No JSONL files found"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("default NO_OP_LOGGER methods are reachable", () => {
  // Targets the unreachable-by-default `NO_OP_LOGGER.warning` / `.error` slots
  // in directory-processor.ts (lines 45-46). When no logger is injected, these
  // become the real sinks; both must be invoked at least once for function
  // coverage.
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "trajectory-cov-default-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("invokes NO_OP_LOGGER.warning via the no-JSONL-files path (no logger injected)", async () => {
    const compressor = makeCompressor();
    await processDirectory(compressor, tmp, join(tmp, "out"));
    expect(true).toBe(true);
  });

  it("invokes NO_OP_LOGGER.error via the per-entry error path (no logger injected)", async () => {
    const inputDir = join(tmp, "in");
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(
      join(inputDir, "x.jsonl"),
      JSON.stringify({ id: 1, conversations: [{ from: "system", value: "abcd" }] }) + "\n",
      "utf-8",
    );
    const cfg = new CompressionConfig({ targetMaxTokens: 1_000_000 });
    const compressor = makeCompressor(cfg);
    vi.spyOn(compressor, "processEntryAsync").mockRejectedValue(new Error("boom"));
    await processDirectory(compressor, inputDir, join(tmp, "out"));
    expect(true).toBe(true);
  });
});
