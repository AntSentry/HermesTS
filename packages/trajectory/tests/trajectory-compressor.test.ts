// Ported from tests/test_trajectory_compressor.py and tests/test_trajectory_compressor_async.py

import { describe, expect, it, vi } from "vitest";

import { CompressionConfig } from "../src/compression-config.js";
import { TrajectoryMetrics } from "../src/metrics.js";
import {
  TrajectoryCompressor,
  type TrajectoryCompressorOptions,
} from "../src/trajectory-compressor.js";
import { OMIT_TEMPERATURE } from "../src/types.js";
import type {
  AsyncLlmClient,
  ChatCompletionResponse,
  LlmClientPair,
  Logger,
  SyncLlmClient,
  TemperatureResolver,
  Tokenizer,
  Turn,
} from "../src/types.js";

const charsPerToken4: Tokenizer = {
  encode(text: string) {
    return new Array(Math.floor(text.length / 4)).fill(0);
  },
};

function makeStubClient(content: string | null): SyncLlmClient {
  return {
    createChatCompletion: vi.fn(
      () =>
        ({
          choices: [{ message: { content } }],
        }) as ChatCompletionResponse,
    ),
  };
}

function makeAsyncStubClient(content: string | null): AsyncLlmClient {
  return {
    createChatCompletion: vi.fn(
      () =>
        Promise.resolve({
          choices: [{ message: { content } }],
        }) as Promise<ChatCompletionResponse>,
    ),
  };
}

function makeCompressor(
  config: CompressionConfig = new CompressionConfig(),
  overrides: Partial<TrajectoryCompressorOptions> = {},
): TrajectoryCompressor {
  const llmClient: LlmClientPair = {
    sync: overrides.llmClient?.sync ?? makeStubClient("[CONTEXT SUMMARY]: ok"),
    async: overrides.llmClient?.async ?? makeAsyncStubClient("[CONTEXT SUMMARY]: ok"),
  };

  const options: TrajectoryCompressorOptions = {
    tokenizer: overrides.tokenizer ?? charsPerToken4,
    llmClient,
  };
  if (overrides.temperatureResolver !== undefined) {
    options.temperatureResolver = overrides.temperatureResolver;
  }
  if (overrides.logger !== undefined) options.logger = overrides.logger;
  if (overrides.sleep !== undefined) options.sleep = overrides.sleep;
  if (overrides.syncSleep !== undefined) options.syncSleep = overrides.syncSleep;
  if (overrides.backoff !== undefined) options.backoff = overrides.backoff;

  return new TrajectoryCompressor(config, options);
}

describe("TrajectoryCompressor — token counting", () => {
  it("countTokens on empty string returns 0", () => {
    const tc = makeCompressor();
    expect(tc.countTokens("")).toBe(0);
  });

  it("countTokens uses the tokenizer", () => {
    const tc = makeCompressor();
    expect(tc.countTokens("12345678")).toBe(2);
  });

  it("countTrajectoryTokens sums per-turn", () => {
    const tc = makeCompressor();
    const trajectory: Turn[] = [
      { from: "system", value: "12345678" }, // 2
      { from: "human", value: "1234567890ab" }, // 3
    ];
    expect(tc.countTrajectoryTokens(trajectory)).toBe(5);
  });

  it("countTurnTokens returns per-turn", () => {
    const tc = makeCompressor();
    const trajectory: Turn[] = [
      { from: "system", value: "1234" },
      { from: "human", value: "12345678" },
    ];
    expect(tc.countTurnTokens(trajectory)).toEqual([1, 2]);
  });

  it("count_tokens fallback when tokenizer throws", () => {
    const tc = makeCompressor(new CompressionConfig(), {
      tokenizer: {
        encode() {
          throw new Error("fail");
        },
      },
    });
    expect(tc.countTokens("12345678")).toBe(2);
  });

  it("count_tokens works when encode returns object with length", () => {
    const tc = makeCompressor(new CompressionConfig(), {
      tokenizer: {
        encode(text) {
          return { length: Math.floor(text.length / 4) };
        },
      },
    });
    expect(tc.countTokens("12345678")).toBe(2);
  });

  it("countTokens uses length when encode returns a typed array-like", () => {
    const tc = makeCompressor(new CompressionConfig(), {
      tokenizer: {
        encode(text) {
          return { length: Math.floor(text.length / 4) };
        },
      },
    });
    expect(tc.countTokens("abcd")).toBe(1);
  });
});

describe("TrajectoryCompressor — findProtectedIndices", () => {
  it("basic 10-turn trajectory", () => {
    const tc = makeCompressor();
    const trajectory: Turn[] = [
      { from: "system", value: "You are an agent." },
      { from: "human", value: "Do something." },
      { from: "gpt", value: "I will use a tool." },
      { from: "tool", value: "Tool result." },
      { from: "gpt", value: "More work." },
      { from: "tool", value: "Another result." },
      { from: "gpt", value: "Work continues." },
      { from: "tool", value: "Result 3." },
      { from: "gpt", value: "Done." },
      { from: "human", value: "Thanks." },
    ];
    const {
      protected: prot,
      compressibleStart: start,
      compressibleEnd: end,
    } = tc.findProtectedIndices(trajectory);
    expect(prot.has(0)).toBe(true);
    expect(prot.has(1)).toBe(true);
    expect(prot.has(2)).toBe(true);
    expect(prot.has(3)).toBe(true);
    expect(prot.has(6)).toBe(true);
    expect(prot.has(7)).toBe(true);
    expect(prot.has(8)).toBe(true);
    expect(prot.has(9)).toBe(true);
    expect(start).toBeGreaterThanOrEqual(4);
    expect(end).toBeLessThanOrEqual(6);
  });

  it("short trajectory — everything protected", () => {
    const tc = makeCompressor();
    const trajectory: Turn[] = [
      { from: "system", value: "sys" },
      { from: "human", value: "hi" },
      { from: "gpt", value: "hello" },
    ];
    const {
      protected: prot,
      compressibleStart: start,
      compressibleEnd: end,
    } = tc.findProtectedIndices(trajectory);
    expect(prot.size).toBe(3);
    expect(start).toBeGreaterThanOrEqual(end);
  });

  it("protect_last_n=0 disables tail protection", () => {
    const cfg = new CompressionConfig({ protectLastNTurns: 0 });
    const tc = makeCompressor(cfg);
    const trajectory: Turn[] = [
      { from: "system", value: "sys" },
      { from: "human", value: "q" },
      { from: "gpt", value: "a" },
      { from: "tool", value: "r" },
      { from: "gpt", value: "b" },
      { from: "tool", value: "r2" },
      { from: "gpt", value: "c" },
      { from: "tool", value: "r3" },
    ];
    const { protected: prot } = tc.findProtectedIndices(trajectory);
    expect(prot.has(0)).toBe(true);
    expect(prot.has(1)).toBe(true);
    expect(prot.has(2)).toBe(true);
    expect(prot.has(3)).toBe(true);
    expect(prot.has(7)).toBe(false);
  });

  it("no system turn — first human is protected", () => {
    const tc = makeCompressor();
    const trajectory: Turn[] = [
      { from: "human", value: "hi" },
      { from: "gpt", value: "hello" },
      { from: "tool", value: "data" },
      { from: "gpt", value: "result" },
      { from: "human", value: "thanks" },
    ];
    const { protected: prot } = tc.findProtectedIndices(trajectory);
    expect(prot.has(0)).toBe(true);
  });

  it("disable protect_first_system", () => {
    const cfg = new CompressionConfig({ protectFirstSystem: false });
    const tc = makeCompressor(cfg);
    const trajectory: Turn[] = [
      { from: "system", value: "sys" },
      { from: "human", value: "q" },
      { from: "gpt", value: "a" },
      { from: "tool", value: "r" },
      { from: "gpt", value: "b" },
      { from: "tool", value: "r2" },
      { from: "gpt", value: "c" },
      { from: "tool", value: "r3" },
    ];
    const { protected: prot } = tc.findProtectedIndices(trajectory);
    expect(prot.has(0)).toBe(false);
  });

  it("disable each first-protector individually", () => {
    const trajectory: Turn[] = [
      { from: "system", value: "s" },
      { from: "human", value: "h" },
      { from: "gpt", value: "g" },
      { from: "tool", value: "t" },
      { from: "gpt", value: "g2" },
      { from: "tool", value: "t2" },
    ];
    const cfg = new CompressionConfig({
      protectFirstSystem: false,
      protectFirstHuman: false,
      protectFirstGpt: false,
      protectFirstTool: false,
      protectLastNTurns: 0,
    });
    const tc = makeCompressor(cfg);
    const { protected: prot } = tc.findProtectedIndices(trajectory);
    expect(prot.size).toBe(0);
  });

  it("empty trajectory yields empty compressible region", () => {
    const tc = makeCompressor();
    const { protected: prot, compressibleStart, compressibleEnd } = tc.findProtectedIndices([]);
    expect(prot.size).toBe(0);
    expect(compressibleStart).toBe(0);
    expect(compressibleEnd).toBe(0);
  });

  it("treats unknown 'from' values as non-roles", () => {
    const tc = makeCompressor();
    const trajectory: Turn[] = [
      { from: "weird", value: "x" },
      { from: "weird", value: "y" },
    ];
    const { protected: prot } = tc.findProtectedIndices(trajectory);
    // Only last-2-turns (default=4) protection kicks in, all 2 indices are tail.
    expect(prot.has(0)).toBe(true);
    expect(prot.has(1)).toBe(true);
  });
});

describe("TrajectoryCompressor — extractTurnContentForSummary", () => {
  it("basic extraction", () => {
    const tc = makeCompressor();
    const trajectory: Turn[] = [
      { from: "gpt", value: "I will search." },
      { from: "tool", value: "Search result: found it." },
      { from: "gpt", value: "Great, done." },
    ];
    const content = tc.extractTurnContentForSummary(trajectory, 0, 2);
    expect(content).toContain("[Turn 0 - GPT]");
    expect(content).toContain("I will search.");
    expect(content).toContain("[Turn 1 - TOOL]");
    expect(content).toContain("Search result: found it.");
    expect(content).not.toContain("[Turn 2");
  });

  it("truncates long content", () => {
    const tc = makeCompressor();
    const trajectory: Turn[] = [{ from: "tool", value: "x".repeat(5000) }];
    const content = tc.extractTurnContentForSummary(trajectory, 0, 1);
    expect(content).toContain("...[truncated]...");
    expect(content.length).toBeLessThan(5000);
  });

  it("empty range returns empty string", () => {
    const tc = makeCompressor();
    const trajectory: Turn[] = [{ from: "gpt", value: "hello" }];
    expect(tc.extractTurnContentForSummary(trajectory, 0, 0)).toBe("");
  });

  it("uses 'unknown' as role when from missing", () => {
    const tc = makeCompressor();
    const trajectory: Turn[] = [{ from: "", value: "hi" }];
    const content = tc.extractTurnContentForSummary(trajectory, 0, 1);
    expect(content).toContain("[Turn 0 - UNKNOWN]");
  });
});

describe("TrajectoryCompressor — summary helpers", () => {
  it("coerceSummaryContent — strings are trimmed", () => {
    expect(TrajectoryCompressor.coerceSummaryContent("  hello  ")).toBe("hello");
  });

  it("coerceSummaryContent — non-strings become strings", () => {
    expect(TrajectoryCompressor.coerceSummaryContent(42)).toBe("42");
  });

  it("coerceSummaryContent — null/undefined/false → empty", () => {
    expect(TrajectoryCompressor.coerceSummaryContent(null)).toBe("");
    expect(TrajectoryCompressor.coerceSummaryContent(undefined)).toBe("");
    expect(TrajectoryCompressor.coerceSummaryContent(false)).toBe("");
    expect(TrajectoryCompressor.coerceSummaryContent(0)).toBe("");
  });

  it("ensureSummaryPrefix — empty returns the bare prefix", () => {
    expect(TrajectoryCompressor.ensureSummaryPrefix("")).toBe("[CONTEXT SUMMARY]:");
    expect(TrajectoryCompressor.ensureSummaryPrefix("   ")).toBe("[CONTEXT SUMMARY]:");
  });

  it("ensureSummaryPrefix — null/undefined falls through nullish coalescing", () => {
    expect(TrajectoryCompressor.ensureSummaryPrefix(null as unknown as string)).toBe(
      "[CONTEXT SUMMARY]:",
    );
    expect(TrajectoryCompressor.ensureSummaryPrefix(undefined as unknown as string)).toBe(
      "[CONTEXT SUMMARY]:",
    );
  });

  it("ensureSummaryPrefix — leaves already-prefixed text alone", () => {
    expect(TrajectoryCompressor.ensureSummaryPrefix("[CONTEXT SUMMARY]: hi")).toBe(
      "[CONTEXT SUMMARY]: hi",
    );
  });

  it("ensureSummaryPrefix — prepends when missing", () => {
    expect(TrajectoryCompressor.ensureSummaryPrefix("hi")).toBe("[CONTEXT SUMMARY]: hi");
  });
});

describe("TrajectoryCompressor — generateSummary (sync)", () => {
  it("handles null content from the model", () => {
    const sync = makeStubClient(null);
    const llmClient: LlmClientPair = { sync, async: makeAsyncStubClient(null) };
    const tc = makeCompressor(new CompressionConfig(), { llmClient });
    const metrics = new TrajectoryMetrics();
    const result = tc.generateSummary("turn content", metrics);
    expect(result).toBe("[CONTEXT SUMMARY]:");
    expect(metrics.summarizationApiCalls).toBe(1);
  });

  it("returns provided summary text with prefix already present", () => {
    const sync = makeStubClient("[CONTEXT SUMMARY]: real summary");
    const llmClient: LlmClientPair = {
      sync,
      async: makeAsyncStubClient("[CONTEXT SUMMARY]: x"),
    };
    const tc = makeCompressor(new CompressionConfig(), { llmClient });
    const metrics = new TrajectoryMetrics();
    const result = tc.generateSummary("turn content", metrics);
    expect(result).toBe("[CONTEXT SUMMARY]: real summary");
  });

  it("retries with backoff and ultimately falls back after exhausting attempts", () => {
    const sync: SyncLlmClient = {
      createChatCompletion: vi.fn(() => {
        throw new Error("nope");
      }),
    };
    const llmClient: LlmClientPair = { sync, async: makeAsyncStubClient("x") };
    const cfg = new CompressionConfig({ maxRetries: 2, retryDelay: 0 });
    const sleepCalls: number[] = [];
    const tc = makeCompressor(cfg, {
      llmClient,
      syncSleep: (ms) => sleepCalls.push(ms),
      backoff: () => 0,
    });
    const metrics = new TrajectoryMetrics();
    const result = tc.generateSummary("turn content", metrics);
    expect(result).toContain("Summary generation failed");
    expect(metrics.summarizationApiCalls).toBe(2);
    expect(metrics.summarizationErrors).toBe(2);
    expect(sleepCalls.length).toBe(1);
  });

  it("logs and stops at the configured maxRetries", () => {
    const sync: SyncLlmClient = {
      createChatCompletion: vi.fn(() => {
        throw "string-thrown";
      }),
    };
    const llmClient: LlmClientPair = { sync, async: makeAsyncStubClient("x") };
    const log: string[] = [];
    const logger: Logger = {
      warning: (m) => log.push(`warn ${m}`),
      error: (m) => log.push(`err ${m}`),
    };
    const cfg = new CompressionConfig({ maxRetries: 1, retryDelay: 0 });
    const tc = makeCompressor(cfg, { llmClient, logger, syncSleep: () => undefined });
    const metrics = new TrajectoryMetrics();
    const result = tc.generateSummary("c", metrics);
    expect(result).toContain("Summary generation failed");
    expect(log.some((l) => l.includes("string-thrown"))).toBe(true);
  });

  it("returns successfully after a transient error retry", () => {
    let calls = 0;
    const sync: SyncLlmClient = {
      createChatCompletion: vi.fn(() => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return {
          choices: [{ message: { content: "[CONTEXT SUMMARY]: ok" } }],
        };
      }),
    };
    const llmClient: LlmClientPair = { sync, async: makeAsyncStubClient("x") };
    const cfg = new CompressionConfig({ maxRetries: 3, retryDelay: 0 });
    const tc = makeCompressor(cfg, {
      llmClient,
      syncSleep: () => undefined,
      backoff: () => 0,
    });
    const metrics = new TrajectoryMetrics();
    const result = tc.generateSummary("c", metrics);
    expect(result).toBe("[CONTEXT SUMMARY]: ok");
    expect(metrics.summarizationErrors).toBe(1);
  });
});

describe("TrajectoryCompressor — defaultSyncSleep", () => {
  it("default syncSleep blocks briefly inside the retry path", () => {
    const sync: SyncLlmClient = {
      createChatCompletion: vi.fn(() => {
        throw new Error("nope");
      }),
    };
    const llmClient: LlmClientPair = { sync, async: makeAsyncStubClient("x") };
    // maxRetries=2 forces one syncSleep call between attempts; backoff returns 0
    // so the default Atomics.wait blocks for ~0 ms.
    const cfg = new CompressionConfig({ maxRetries: 2, retryDelay: 0 });
    const tc = makeCompressor(cfg, { llmClient, backoff: () => 0 });
    const start = Date.now();
    const m = new TrajectoryMetrics();
    const result = tc.generateSummary("c", m);
    const elapsed = Date.now() - start;
    expect(result).toContain("Summary generation failed");
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});

describe("TrajectoryCompressor — temperature resolver", () => {
  it("default resolver passes through requested temperature", () => {
    const sync = makeStubClient("[CONTEXT SUMMARY]: ok");
    const llmClient: LlmClientPair = { sync, async: makeAsyncStubClient("x") };
    const cfg = new CompressionConfig({ temperature: 0.7 });
    const tc = makeCompressor(cfg, { llmClient });
    expect(tc.effectiveTemperatureForModel()).toBe(0.7);
  });

  it("custom resolver returning null = omit temperature (matches OMIT_TEMPERATURE contract)", () => {
    const sync = makeStubClient("[CONTEXT SUMMARY]: ok");
    const llmClient: LlmClientPair = { sync, async: makeAsyncStubClient("x") };
    const resolver: TemperatureResolver = () => null;
    const tc = makeCompressor(new CompressionConfig(), {
      llmClient,
      temperatureResolver: resolver,
    });
    const metrics = new TrajectoryMetrics();
    tc.generateSummary("hi", metrics);
    const calls = (sync.createChatCompletion as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0].temperature).toBeNull();
  });

  it("custom resolver returning a number is forwarded", () => {
    const sync = makeStubClient("[CONTEXT SUMMARY]: ok");
    const llmClient: LlmClientPair = { sync, async: makeAsyncStubClient("x") };
    const resolver: TemperatureResolver = () => 0.5;
    const tc = makeCompressor(new CompressionConfig(), {
      llmClient,
      temperatureResolver: resolver,
    });
    const metrics = new TrajectoryMetrics();
    tc.generateSummary("hi", metrics);
    const calls = (sync.createChatCompletion as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0].temperature).toBe(0.5);
  });

  it("OMIT_TEMPERATURE export is a unique symbol", () => {
    expect(typeof OMIT_TEMPERATURE).toBe("symbol");
  });
});

describe("TrajectoryCompressor — async summary generation", () => {
  it("handles null content from the model (async)", async () => {
    const sync = makeStubClient("");
    const asyncClient = makeAsyncStubClient(null);
    const llmClient: LlmClientPair = { sync, async: asyncClient };
    const tc = makeCompressor(new CompressionConfig(), { llmClient });
    const metrics = new TrajectoryMetrics();
    const result = await tc.generateSummaryAsync("hi", metrics);
    expect(result).toBe("[CONTEXT SUMMARY]:");
  });

  it("retries with backoff and falls back after exhausting attempts (async)", async () => {
    const sync = makeStubClient("x");
    const asyncClient: AsyncLlmClient = {
      createChatCompletion: vi.fn(() => Promise.reject(new Error("transient"))),
    };
    const llmClient: LlmClientPair = { sync, async: asyncClient };
    const cfg = new CompressionConfig({ maxRetries: 2, retryDelay: 0 });
    const sleepCalls: number[] = [];
    const tc = makeCompressor(cfg, {
      llmClient,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      backoff: () => 0,
    });
    const metrics = new TrajectoryMetrics();
    const result = await tc.generateSummaryAsync("c", metrics);
    expect(result).toContain("Summary generation failed");
    expect(metrics.summarizationApiCalls).toBe(2);
    expect(metrics.summarizationErrors).toBe(2);
    expect(sleepCalls.length).toBe(1);
  });

  it("returns successfully after a transient async error retry", async () => {
    let calls = 0;
    const asyncClient: AsyncLlmClient = {
      createChatCompletion: vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("transient"));
        return Promise.resolve({
          choices: [{ message: { content: "[CONTEXT SUMMARY]: ok" } }],
        });
      }),
    };
    const llmClient: LlmClientPair = { sync: makeStubClient("x"), async: asyncClient };
    const cfg = new CompressionConfig({ maxRetries: 3, retryDelay: 0 });
    const tc = makeCompressor(cfg, {
      llmClient,
      sleep: async () => undefined,
      backoff: () => 0,
    });
    const metrics = new TrajectoryMetrics();
    const result = await tc.generateSummaryAsync("c", metrics);
    expect(result).toBe("[CONTEXT SUMMARY]: ok");
    expect(metrics.summarizationErrors).toBe(1);
  });

  it("logs string-thrown errors in async path", async () => {
    const asyncClient: AsyncLlmClient = {
      createChatCompletion: vi.fn(() => Promise.reject("oops")),
    };
    const llmClient: LlmClientPair = { sync: makeStubClient("x"), async: asyncClient };
    const log: string[] = [];
    const cfg = new CompressionConfig({ maxRetries: 1, retryDelay: 0 });
    const tc = makeCompressor(cfg, {
      llmClient,
      logger: { warning: (m) => log.push(m), error: () => undefined },
      sleep: async () => undefined,
    });
    const metrics = new TrajectoryMetrics();
    await tc.generateSummaryAsync("c", metrics);
    expect(log.some((l) => l.includes("oops"))).toBe(true);
  });

  it("detect_provider instance method matches free function", () => {
    const cfg = new CompressionConfig({ baseUrl: "https://api.arcee.ai/api/v1" });
    const tc = makeCompressor(cfg);
    expect(tc.detectProvider()).toBe("arcee");
    expect(tc.llmProvider).toBe("arcee");
    expect(tc.useCallLlm).toBe(true);
  });

  it("detect_provider null-guard does not throw", () => {
    const cfg = new CompressionConfig();
    cfg.baseUrl = null;
    const tc = makeCompressor(cfg);
    expect(tc.detectProvider()).toBe("");
    expect(tc.useCallLlm).toBe(false);
  });
});

describe("TrajectoryCompressor — compressTrajectory (sync)", () => {
  it("returns unchanged trajectory under target — sets skipped flag", () => {
    const cfg = new CompressionConfig({ targetMaxTokens: 100_000 });
    const tc = makeCompressor(cfg);
    const trajectory: Turn[] = [{ from: "system", value: "small" }];
    const { trajectory: result, metrics } = tc.compressTrajectory(trajectory);
    expect(result).toBe(trajectory);
    expect(metrics.skippedUnderTarget).toBe(true);
    expect(metrics.compressionRatio).toBe(1.0);
  });

  it("returns unchanged trajectory when nothing is compressible", () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 0,
      protectLastNTurns: 10,
    });
    const tc = makeCompressor(cfg);
    const trajectory: Turn[] = [
      { from: "system", value: "abcd" },
      { from: "human", value: "abcd" },
    ];
    const { trajectory: result, metrics } = tc.compressTrajectory(trajectory);
    expect(result).toBe(trajectory);
    expect(metrics.stillOverLimit).toBe(true);
    expect(metrics.wasCompressed).toBe(false);
  });

  it("compresses an over-target trajectory and writes summary in the middle", () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 8,
      summaryTargetTokens: 2,
      protectLastNTurns: 2,
      maxRetries: 1,
    });
    const tc = makeCompressor(cfg);
    // 10 turns so head-protected={0,1,2,3} all sit < halfPoint=5 and middle stays compressible.
    const trajectory: Turn[] = [
      { from: "system", value: "sys-content" }, // 2 tokens
      { from: "human", value: "human-content" }, // 3
      { from: "gpt", value: "gpt-content-aa" }, // 3
      { from: "tool", value: "tool-content-aa" }, // 3
      { from: "gpt", value: "mid-content-1" }, // 3
      { from: "tool", value: "mid-content-2" }, // 3
      { from: "gpt", value: "mid-content-3" }, // 3
      { from: "tool", value: "mid-content-4" }, // 3
      { from: "gpt", value: "tail-gpt-content" }, // 4
      { from: "gpt", value: "final-gpt-content" }, // 4
    ];
    const { trajectory: result, metrics } = tc.compressTrajectory(trajectory);
    expect(metrics.wasCompressed).toBe(true);
    expect(metrics.originalTurns).toBe(10);
    expect(metrics.compressedTurns).toBeLessThan(metrics.originalTurns);
    // The summary turn should be a `human` turn.
    expect(result.some((t) => t.value.startsWith("[CONTEXT SUMMARY]:"))).toBe(true);
    // System notice should be appended when addSummaryNotice = true.
    expect(result[0]?.value.endsWith(cfg.summaryNoticeText)).toBe(true);
  });

  it("compress falls through compress_until = compress_end when savings insufficient", () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 0,
      summaryTargetTokens: 1_000_000,
      protectLastNTurns: 2,
      maxRetries: 1,
    });
    const tc = makeCompressor(cfg);
    // 10 turns, head protected = {0,1,2,3} all < halfPoint=5; tail = {8,9}.
    const trajectory: Turn[] = [
      { from: "system", value: "sys-content" },
      { from: "human", value: "human-content" },
      { from: "gpt", value: "gpt-content" },
      { from: "tool", value: "tool-content" },
      { from: "gpt", value: "mid-1-content" },
      { from: "tool", value: "mid-2-content" },
      { from: "gpt", value: "mid-3-content" },
      { from: "tool", value: "mid-4-content" },
      { from: "gpt", value: "tail-1-content" },
      { from: "gpt", value: "tail-2-content" },
    ];
    const { metrics } = tc.compressTrajectory(trajectory);
    expect(metrics.wasCompressed).toBe(true);
    expect(metrics.turnsInCompressedRegion).toBeGreaterThan(0);
  });

  it("does not add summary notice when addSummaryNotice is false", () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 4,
      summaryTargetTokens: 2,
      protectLastNTurns: 2,
      addSummaryNotice: false,
      maxRetries: 1,
    });
    const tc = makeCompressor(cfg);
    const trajectory: Turn[] = [
      { from: "system", value: "sys-content" },
      { from: "human", value: "human-content" },
      { from: "gpt", value: "gpt-content-x" },
      { from: "tool", value: "tool-content-x" },
      { from: "gpt", value: "mid-content-1" },
      { from: "tool", value: "mid-content-2" },
      { from: "gpt", value: "mid-content-3" },
      { from: "tool", value: "mid-content-4" },
      { from: "gpt", value: "tail-1-content" },
      { from: "gpt", value: "tail-2-content" },
    ];
    const { trajectory: result } = tc.compressTrajectory(trajectory);
    expect(result[0]?.value).toBe("sys-content");
  });
});

describe("TrajectoryCompressor — compressTrajectoryAsync (async)", () => {
  it("skip under target", async () => {
    const cfg = new CompressionConfig({ targetMaxTokens: 100_000 });
    const tc = makeCompressor(cfg);
    const trajectory: Turn[] = [{ from: "system", value: "small" }];
    const { trajectory: result, metrics } = await tc.compressTrajectoryAsync(trajectory);
    expect(result).toBe(trajectory);
    expect(metrics.skippedUnderTarget).toBe(true);
  });

  it("nothing-compressible early-return", async () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 0,
      protectLastNTurns: 10,
    });
    const tc = makeCompressor(cfg);
    const trajectory: Turn[] = [
      { from: "system", value: "abcd" },
      { from: "human", value: "abcd" },
    ];
    const { metrics } = await tc.compressTrajectoryAsync(trajectory);
    expect(metrics.stillOverLimit).toBe(true);
  });

  it("compresses with async summary path", async () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 8,
      summaryTargetTokens: 2,
      protectLastNTurns: 2,
      maxRetries: 1,
    });
    const tc = makeCompressor(cfg);
    const trajectory: Turn[] = [
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
    ];
    const { trajectory: result, metrics } = await tc.compressTrajectoryAsync(trajectory);
    expect(metrics.wasCompressed).toBe(true);
    expect(result.some((t) => t.value.startsWith("[CONTEXT SUMMARY]:"))).toBe(true);
  });

  it("async — savings insufficient falls back to compress_until = compress_end", async () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 0,
      summaryTargetTokens: 1_000_000,
      protectLastNTurns: 2,
      maxRetries: 1,
    });
    const tc = makeCompressor(cfg);
    const trajectory: Turn[] = [
      { from: "system", value: "sys-content" },
      { from: "human", value: "human-content" },
      { from: "gpt", value: "gpt-content" },
      { from: "tool", value: "tool-content" },
      { from: "gpt", value: "mid-1-content" },
      { from: "tool", value: "mid-2-content" },
      { from: "gpt", value: "mid-3-content" },
      { from: "tool", value: "mid-4-content" },
      { from: "gpt", value: "tail-1-content" },
      { from: "gpt", value: "tail-2-content" },
    ];
    const { metrics } = await tc.compressTrajectoryAsync(trajectory);
    expect(metrics.wasCompressed).toBe(true);
  });

  it("async — addSummaryNotice false leaves system unchanged", async () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 4,
      summaryTargetTokens: 2,
      protectLastNTurns: 2,
      addSummaryNotice: false,
      maxRetries: 1,
    });
    const tc = makeCompressor(cfg);
    const trajectory: Turn[] = [
      { from: "system", value: "sys-content" },
      { from: "human", value: "human-content" },
      { from: "gpt", value: "gpt-content-x" },
      { from: "tool", value: "tool-content-x" },
      { from: "gpt", value: "mid-content-1" },
      { from: "tool", value: "mid-content-2" },
      { from: "gpt", value: "mid-content-3" },
      { from: "tool", value: "mid-content-4" },
      { from: "gpt", value: "tail-1-content" },
      { from: "gpt", value: "tail-2-content" },
    ];
    const { trajectory: result } = await tc.compressTrajectoryAsync(trajectory);
    expect(result[0]?.value).toBe("sys-content");
  });
});

describe("TrajectoryCompressor — processEntry", () => {
  it("returns entry unchanged when no conversations field", () => {
    const tc = makeCompressor();
    const entry = { id: 1, other: "field" };
    const { entry: result, metrics } = tc.processEntry(entry);
    expect(result).toBe(entry);
    expect(metrics.wasCompressed).toBe(false);
  });

  it("compresses an entry and attaches compression_metrics when configured", () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 8,
      summaryTargetTokens: 2,
      protectLastNTurns: 2,
      maxRetries: 1,
      metricsPerTrajectory: true,
    });
    const tc = makeCompressor(cfg);
    const entry = {
      id: "x",
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
    };
    const { entry: result, metrics } = tc.processEntry(entry);
    expect(metrics.wasCompressed).toBe(true);
    expect(result.compression_metrics).toBeDefined();
    expect((result.compression_metrics as { was_compressed: boolean }).was_compressed).toBe(true);
  });

  it("does not attach compression_metrics when metricsPerTrajectory is false", () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 8,
      summaryTargetTokens: 2,
      protectLastNTurns: 2,
      maxRetries: 1,
      metricsPerTrajectory: false,
    });
    const tc = makeCompressor(cfg);
    const entry = {
      id: "x",
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
    };
    const { entry: result } = tc.processEntry(entry);
    expect(result.compression_metrics).toBeUndefined();
  });
});

describe("TrajectoryCompressor — processEntryAsync", () => {
  it("returns entry unchanged when no conversations field", async () => {
    const tc = makeCompressor();
    const entry = { id: 1 };
    const { entry: result, metrics } = await tc.processEntryAsync(entry);
    expect(result).toBe(entry);
    expect(metrics.wasCompressed).toBe(false);
  });

  it("compresses entry and attaches metrics dict (async)", async () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 8,
      summaryTargetTokens: 2,
      protectLastNTurns: 2,
      maxRetries: 1,
      metricsPerTrajectory: true,
    });
    const tc = makeCompressor(cfg);
    const entry = {
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
    };
    const { entry: result, metrics } = await tc.processEntryAsync(entry);
    expect(metrics.wasCompressed).toBe(true);
    expect(result.compression_metrics).toBeDefined();
  });

  it("does not attach compression_metrics when metricsPerTrajectory is false (async)", async () => {
    const cfg = new CompressionConfig({
      targetMaxTokens: 8,
      summaryTargetTokens: 2,
      protectLastNTurns: 2,
      maxRetries: 1,
      metricsPerTrajectory: false,
    });
    const tc = makeCompressor(cfg);
    const entry = {
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
    };
    const { entry: result } = await tc.processEntryAsync(entry);
    expect(result.compression_metrics).toBeUndefined();
  });
});
