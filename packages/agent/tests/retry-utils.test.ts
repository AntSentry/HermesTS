// Ported from tests/test_retry_utils.py

import { afterEach, describe, expect, test } from "vitest";

import { _resetJitterCounter, jitteredBackoff } from "../src/retry-utils.js";

afterEach(() => {
  _resetJitterCounter();
});

describe("jitteredBackoff", () => {
  test("attempt 1 with defaults stays in [base, base + base*jitter]", () => {
    const d = jitteredBackoff(1, { timeNs: () => 0n });
    expect(d).toBeGreaterThanOrEqual(5);
    expect(d).toBeLessThanOrEqual(5 + 5 * 0.5);
  });

  test("exponent grows: attempt 4 base*8 with jitter", () => {
    const d = jitteredBackoff(4, { timeNs: () => 0n });
    expect(d).toBeGreaterThanOrEqual(40); // 5 * 2^3
    expect(d).toBeLessThanOrEqual(40 + 40 * 0.5);
  });

  test("clamps to maxDelay when 2^(attempt-1) exceeds cap", () => {
    const d = jitteredBackoff(10, { timeNs: () => 0n, maxDelay: 30 });
    expect(d).toBeGreaterThanOrEqual(30);
    expect(d).toBeLessThanOrEqual(30 + 30 * 0.5);
  });

  test("attempt 0 floors exponent at 0 — still returns base + jitter", () => {
    const d = jitteredBackoff(0, { timeNs: () => 0n });
    expect(d).toBeGreaterThanOrEqual(5);
    expect(d).toBeLessThanOrEqual(5 + 5 * 0.5);
  });

  test("absurdly large attempt (>=63) uses maxDelay short-circuit", () => {
    const d = jitteredBackoff(100, { timeNs: () => 0n, maxDelay: 7.5 });
    expect(d).toBeGreaterThanOrEqual(7.5);
    expect(d).toBeLessThanOrEqual(7.5 + 7.5 * 0.5);
  });

  test("zero baseDelay short-circuits to maxDelay", () => {
    const d = jitteredBackoff(2, { timeNs: () => 0n, baseDelay: 0, maxDelay: 11 });
    expect(d).toBeGreaterThanOrEqual(11);
    expect(d).toBeLessThanOrEqual(11 + 11 * 0.5);
  });

  test("jitterRatio 0 yields no jitter", () => {
    const d = jitteredBackoff(1, { timeNs: () => 0n, jitterRatio: 0 });
    expect(d).toBe(5);
  });

  test("decorrelation: successive calls with same time produce different jitter", () => {
    const a = jitteredBackoff(1, { timeNs: () => 0n });
    const b = jitteredBackoff(1, { timeNs: () => 0n });
    expect(a).not.toBe(b);
  });

  test("default timeNs reachable when not supplied", () => {
    // Just probe the default branch executes without throwing.
    const d = jitteredBackoff(1);
    expect(d).toBeGreaterThanOrEqual(5);
  });
});
