/**
 * MockClock — deterministic clock for tests.
 *
 * Compatible with the @hermests/core time interface (the `now()` exported
 * from @hermests/core/time returns a Date). Tests inject `clock.now` in
 * place of the real `now` and use `advance(ms)` / `setNow(date)` to drive
 * time forward.
 *
 * Coupling note: if @hermests/core/time ever exposes a higher-level Clock
 * object (e.g. with a monotonic counter), add it here and document the
 * upstream symbol next to it.
 */

export interface ClockSurface {
  now(): Date;
}

const DEFAULT_EPOCH = new Date("2024-01-01T00:00:00.000Z");

export class MockClock implements ClockSurface {
  private current: Date;
  private readonly initial: Date;

  constructor(start: Date = DEFAULT_EPOCH) {
    this.initial = new Date(start.getTime());
    this.current = new Date(start.getTime());
  }

  /** Return the current frozen Date — new instance each call so callers can mutate freely. */
  now = (): Date => new Date(this.current.getTime());

  /**
   * Advance the clock by *ms* milliseconds.
   * Negative values are rejected — time only moves forward.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms)) {
      throw new RangeError(`MockClock.advance: ms must be finite, got ${ms}`);
    }
    if (ms < 0) {
      throw new RangeError(`MockClock.advance: ms must be >= 0, got ${ms}`);
    }
    this.current = new Date(this.current.getTime() + ms);
  }

  /** Jump the clock to a specific Date (may move backward — explicit override). */
  setNow(date: Date): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new TypeError(`MockClock.setNow: invalid Date`);
    }
    this.current = new Date(date.getTime());
  }

  /** Restore the clock to the value it had at construction. */
  reset(): void {
    this.current = new Date(this.initial.getTime());
  }
}
