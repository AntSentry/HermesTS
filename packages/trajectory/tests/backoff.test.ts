import { describe, expect, it } from "vitest";
import { _resetJitterCounter, defaultSleep, jitteredBackoff } from "../src/backoff.js";

describe("jitteredBackoff", () => {
  it("first attempt returns base ± jitter", () => {
    _resetJitterCounter();
    const delay = jitteredBackoff(1, { baseDelay: 5, maxDelay: 30 });
    expect(delay).toBeGreaterThanOrEqual(5);
    expect(delay).toBeLessThanOrEqual(5 + 5 * 0.5);
  });

  it("exponentially grows up to maxDelay", () => {
    _resetJitterCounter();
    const d1 = jitteredBackoff(1, { baseDelay: 1, maxDelay: 100 });
    const d10 = jitteredBackoff(10, { baseDelay: 1, maxDelay: 100 });
    expect(d10).toBeGreaterThan(d1);
    // attempt=10 → 1 * 2^9 = 512 > 100, capped at 100. plus up to 50% jitter
    expect(d10).toBeGreaterThanOrEqual(100);
    expect(d10).toBeLessThanOrEqual(150);
  });

  it("returns maxDelay when exponent >= 63", () => {
    _resetJitterCounter();
    const d = jitteredBackoff(64, { baseDelay: 1, maxDelay: 30 });
    expect(d).toBeGreaterThanOrEqual(30);
    expect(d).toBeLessThanOrEqual(45);
  });

  it("returns maxDelay when baseDelay <= 0", () => {
    _resetJitterCounter();
    const d = jitteredBackoff(2, { baseDelay: 0, maxDelay: 20 });
    expect(d).toBeGreaterThanOrEqual(20);
    expect(d).toBeLessThanOrEqual(30);
  });

  it("zero attempt is clamped (exponent floors at 0)", () => {
    _resetJitterCounter();
    const d = jitteredBackoff(0, { baseDelay: 4, maxDelay: 30 });
    expect(d).toBeGreaterThanOrEqual(4);
    expect(d).toBeLessThanOrEqual(6);
  });

  it("uses defaults when no options provided", () => {
    _resetJitterCounter();
    const d = jitteredBackoff(1);
    expect(d).toBeGreaterThanOrEqual(5);
    expect(d).toBeLessThanOrEqual(7.5);
  });

  it("jitterRatio of 0 yields no jitter (delay == base)", () => {
    _resetJitterCounter();
    const d = jitteredBackoff(1, { baseDelay: 5, maxDelay: 30, jitterRatio: 0 });
    expect(d).toBe(5);
  });
});

describe("defaultSleep", () => {
  it("resolves after at least the requested duration", async () => {
    const start = Date.now();
    await defaultSleep(15);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(10);
  });
});
