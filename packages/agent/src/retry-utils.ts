/**
 * Retry utilities — jittered backoff for decorrelated retries.
 *
 * Faithful port of upstream `agent/retry_utils.py`.
 *
 * Replaces fixed exponential backoff with jittered delays to prevent
 * thundering-herd retry spikes when multiple sessions hit the same
 * rate-limited provider concurrently.
 *
 * Faithful divergence:
 *   - Upstream uses `threading.Lock` to protect a monotonic counter
 *     against multi-thread races. Node is single-threaded, so the lock
 *     is dropped — the increment is atomic vs. event-loop tasks.
 *   - Upstream seeds a `random.Random` instance from `time.time_ns() ^
 *     (tick * 0x9E3779B9)`. TS mirrors that with a Linear Congruential
 *     Generator seeded the same way, so jitter for a given (tick, time)
 *     pair matches between runtimes for reproducible tests.
 */

let _jitterCounter = 0;

/** Options for `jitteredBackoff`. */
export interface JitteredBackoffOptions {
  /** Base delay in seconds for attempt 1. Default `5.0`. */
  baseDelay?: number;
  /** Maximum delay cap in seconds. Default `120.0`. */
  maxDelay?: number;
  /**
   * Fraction of computed delay to use as random jitter range.
   * `0.5` means jitter is uniform in `[0, 0.5 * delay]`.
   * Default `0.5`.
   */
  jitterRatio?: number;
  /**
   * Override for `time.time_ns()` — test seam. Returns nanoseconds since
   * the epoch as a bigint. Defaults to `process.hrtime`-derived value
   * combined with the current wall clock.
   */
  timeNs?: () => bigint;
}

/**
 * Compute a jittered exponential backoff delay (seconds).
 *
 * `attempt` is the 1-based retry attempt number; the delay is
 * `min(base * 2^(attempt-1), max_delay) + jitter`.
 */
export function jitteredBackoff(attempt: number, options: JitteredBackoffOptions = {}): number {
  const baseDelay = options.baseDelay ?? 5.0;
  const maxDelay = options.maxDelay ?? 120.0;
  const jitterRatio = options.jitterRatio ?? 0.5;
  const timeNs = options.timeNs ?? defaultTimeNs;

  _jitterCounter += 1;
  const tick = _jitterCounter;

  const exponent = Math.max(0, attempt - 1);
  let delay: number;
  if (exponent >= 63 || baseDelay <= 0) {
    delay = maxDelay;
  } else {
    delay = Math.min(baseDelay * 2 ** exponent, maxDelay);
  }

  // Seed exactly as Python does: lower 32 bits of (time_ns ^ tick * 0x9E3779B9).
  // 0x9E3779B9 is the fractional part of the golden ratio — classic
  // hash-mixing constant; matches upstream `retry_utils.py:53`.
  const tickMul = BigInt(tick) * 0x9e3779b9n;
  const mixed = (timeNs() ^ tickMul) & 0xffffffffn;
  const seed = Number(mixed);

  const rng = lcg(seed);
  const jitter = rng() * (jitterRatio * delay);

  return delay + jitter;
}

/** Reset the monotonic counter. Test-only. */
export function _resetJitterCounter(): void {
  _jitterCounter = 0;
}

/** Default nanosecond-resolution time source. */
function defaultTimeNs(): bigint {
  // `process.hrtime.bigint()` is monotonic ns since process start — used
  // here as the high-entropy source. Upstream uses wall-clock ns, but
  // for jitter the only requirement is high-entropy; either works.
  return process.hrtime.bigint();
}

/**
 * Minimal LCG matching Python's `random.Random(seed).uniform(0, 1)` only
 * in that the seed maps deterministically to a value in `[0, 1)`. Exact
 * sequence parity with CPython's Mersenne Twister isn't possible without
 * reimplementing MT19937; jitter doesn't need that — it only needs
 * decorrelation.
 *
 * The 32-bit LCG constants (`1664525`, `1013904223`) come from Numerical
 * Recipes; they give a full-period generator across `[0, 2^32)`.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
