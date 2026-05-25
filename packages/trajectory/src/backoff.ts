/**
 * Jittered backoff utility — faithful port of
 * `agent.retry_utils.jittered_backoff` (upstream `agent/retry_utils.py`).
 *
 * The function is duplicated here (rather than imported from
 * `@hermests/agent`) because trajectory_compressor.py is the only upstream
 * caller besides the agent module itself, and importing it would create a
 * cyclic dep between trajectory and agent. When the agent porter (task #5)
 * lands, both modules will continue to use the same algorithm — re-export
 * from there or hoist to `@hermests/core` at that time.
 */

import { randomInt } from "node:crypto";

/**
 * Process-monotonic counter for jitter seed uniqueness. Protected by no lock
 * in TS (Node.js is single-threaded for JS execution) — the Python lock guards
 * against concurrent threads bumping the counter; in Node, an increment is
 * atomic w.r.t. JS-level concurrency.
 *
 * The seed mixes `process.hrtime.bigint()` with this counter to keep
 * decorrelated jitter even with coarse-grained clocks.
 */
let _jitterCounter = 0;

/**
 * Compute a jittered exponential backoff delay in seconds (matches the
 * upstream `jittered_backoff` semantics — units in seconds, not ms).
 *
 * @param attempt - 1-based retry attempt number.
 * @param options.baseDelay - Base delay in seconds for attempt 1 (default 5.0).
 * @param options.maxDelay - Maximum delay cap in seconds (default 120.0).
 * @param options.jitterRatio - Fraction of computed delay used as random
 *   jitter range. 0.5 means jitter is uniform in [0, 0.5 * delay]. Default 0.5.
 *
 * Returns delay in seconds: min(base * 2^(attempt-1), max_delay) + jitter.
 */
export function jitteredBackoff(
  attempt: number,
  options: {
    baseDelay?: number;
    maxDelay?: number;
    jitterRatio?: number;
  } = {},
): number {
  const baseDelay = options.baseDelay ?? 5.0;
  const maxDelay = options.maxDelay ?? 120.0;
  const jitterRatio = options.jitterRatio ?? 0.5;

  _jitterCounter += 1;
  const tick = _jitterCounter;

  const exponent = Math.max(0, attempt - 1);
  let delay: number;
  if (exponent >= 63 || baseDelay <= 0) {
    delay = maxDelay;
  } else {
    delay = Math.min(baseDelay * 2 ** exponent, maxDelay);
  }

  // Seed mixes hrtime with the counter (upstream uses time.time_ns()).
  const timeNs = process.hrtime.bigint();
  const seed = Number((timeNs ^ (BigInt(tick) * 0x9e3779b9n)) & 0xffffffffn);
  const jitter = mulberry32(seed)() * jitterRatio * delay;

  return delay + jitter;
}

/**
 * Mulberry32 PRNG — deterministic, seedable, lightweight. The upstream uses
 * Python's `random.Random(seed).uniform(0, x)`. We need a seeded PRNG with
 * uniform output in [0,1) to match the per-call decorrelation property.
 *
 * Algorithm reference: https://stackoverflow.com/a/47593316 — a well-known
 * fast 32-bit PRNG that is statistically uniform enough for jitter.
 */
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

/**
 * Reset the internal jitter counter. Test-only utility to make jitter
 * deterministic between cases — not part of the upstream public surface.
 */
export function _resetJitterCounter(): void {
  _jitterCounter = 0;
}

/**
 * Default sleep utility — converts seconds to ms and resolves after the
 * timer fires. Mirrors Python's `time.sleep(seconds)` / `asyncio.sleep(seconds)`.
 */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Silence unused-import warning for randomInt — kept available for callers
// that want a crypto-grade jitter override.
void randomInt;
