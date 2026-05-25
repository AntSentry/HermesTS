import { describe, it, expect } from "vitest";
import { MockClock } from "../src/mock-clock.js";

describe("MockClock", () => {
  it("defaults to 2024-01-01T00:00:00Z", () => {
    const c = new MockClock();
    expect(c.now().toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("accepts a starting Date", () => {
    const c = new MockClock(new Date("2025-12-31T23:59:59Z"));
    expect(c.now().toISOString()).toBe("2025-12-31T23:59:59.000Z");
  });

  it("now() returns a fresh Date each call (caller may mutate)", () => {
    const c = new MockClock();
    const a = c.now();
    const b = c.now();
    expect(a).not.toBe(b);
    a.setUTCFullYear(1999);
    expect(c.now().getUTCFullYear()).toBe(2024);
  });

  it("advance(ms) moves the clock forward", () => {
    const c = new MockClock(new Date("2024-01-01T00:00:00Z"));
    c.advance(1500);
    expect(c.now().toISOString()).toBe("2024-01-01T00:00:01.500Z");
    c.advance(0);
    expect(c.now().toISOString()).toBe("2024-01-01T00:00:01.500Z");
  });

  it("advance rejects negative deltas", () => {
    const c = new MockClock();
    expect(() => c.advance(-1)).toThrow(RangeError);
    expect(() => c.advance(-1)).toThrow(/>= 0/);
  });

  it("advance rejects non-finite deltas", () => {
    const c = new MockClock();
    expect(() => c.advance(Number.NaN)).toThrow(RangeError);
    expect(() => c.advance(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it("setNow jumps to an arbitrary Date", () => {
    const c = new MockClock();
    c.setNow(new Date("1999-12-31T23:59:59Z"));
    expect(c.now().toISOString()).toBe("1999-12-31T23:59:59.000Z");
  });

  it("setNow rejects invalid Date inputs", () => {
    const c = new MockClock();
    expect(() => c.setNow(new Date("not-a-date"))).toThrow(TypeError);
    expect(() => c.setNow("nope" as unknown as Date)).toThrow(TypeError);
  });

  it("reset returns to the construction-time value", () => {
    const start = new Date("2024-06-15T12:00:00Z");
    const c = new MockClock(start);
    c.advance(60_000);
    c.setNow(new Date("2030-01-01T00:00:00Z"));
    c.reset();
    expect(c.now().toISOString()).toBe(start.toISOString());
  });

  it("matches the ClockSurface contract", () => {
    const c = new MockClock();
    const surface: { now(): Date } = c;
    expect(surface.now()).toBeInstanceOf(Date);
  });
});
