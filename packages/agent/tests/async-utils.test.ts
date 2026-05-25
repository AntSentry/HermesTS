// Ported from tests/agent/test_async_utils.py
//
// The TS version diverges intentionally — Node has no `asyncio` loop,
// no "coroutine was never awaited" warning, and no thread-safe schedule
// API. The shim's contract here is reduced to: "loop===null → null,
// otherwise → Promise". Tests pin both branches.

import { describe, expect, test, vi } from "vitest";

import { safeScheduleThreadsafe } from "../src/async-utils.js";

describe("safeScheduleThreadsafe", () => {
  test("returns null when loop is null", () => {
    const log = { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const result = safeScheduleThreadsafe(async () => 42, null, {
      logger: log as never,
    });
    expect(result).toBe(null);
    expect(log.debug).toHaveBeenCalledOnce();
    const message = log.debug.mock.calls[0]?.[0] as string;
    expect(message).toContain("loop is None");
  });

  test("returns a promise resolving to the task result when loop given", async () => {
    const loop = Symbol("loop");
    const promise = safeScheduleThreadsafe(async () => 7, loop);
    expect(promise).not.toBe(null);
    await expect(promise).resolves.toBe(7);
  });

  test("synchronous throw in task fn becomes a rejected promise", async () => {
    const loop = {} as object;
    const promise = safeScheduleThreadsafe<number>(
      () => {
        throw new Error("sync boom");
      },
      loop,
    );
    expect(promise).not.toBe(null);
    await expect(promise).rejects.toThrow("sync boom");
  });

  test("rejected promise from task fn propagates without logger noise", async () => {
    const loop = Symbol("loop");
    const promise = safeScheduleThreadsafe(async () => {
      throw new Error("async boom");
    }, loop);
    await expect(promise).rejects.toThrow("async boom");
  });

  test("honors custom log message + level on null-loop path", () => {
    const log = { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
    safeScheduleThreadsafe(async () => 0, null, {
      logger: log as never,
      logLevel: "warning",
      logMessage: "custom prefix",
    });
    expect(log.warning).toHaveBeenCalledOnce();
    const msg = log.warning.mock.calls[0]?.[0] as string;
    expect(msg).toContain("custom prefix");
  });

  test("non-Error thrown value logs string representation", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const loop = {} as object;
    const promise = safeScheduleThreadsafe<number>(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "string-thrown";
      },
      loop,
      { logger: log as never },
    );
    await expect(promise).rejects.toEqual("string-thrown");
    expect(log.debug).toHaveBeenCalledOnce();
    expect(log.debug.mock.calls[0]?.[0]).toContain("string-thrown");
  });
});
