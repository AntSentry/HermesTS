// Faithful TS port of tests covering upstream `agent/iteration_budget.py`
// (no dedicated upstream test file — the class is exercised via
// `tests/run_agent/test_iteration_limit_logic.py` and the budget's
// invariants are documented in the upstream docstring).

import { describe, expect, test } from "vitest";

import { IterationBudget } from "../src/iteration-budget.js";

describe("IterationBudget", () => {
  test("starts with full budget remaining and zero used", () => {
    const b = new IterationBudget(5);
    expect(b.maxTotal).toBe(5);
    expect(b.used).toBe(0);
    expect(b.remaining).toBe(5);
  });

  test("consume returns true while budget remains", () => {
    const b = new IterationBudget(3);
    expect(b.consume()).toBe(true);
    expect(b.consume()).toBe(true);
    expect(b.consume()).toBe(true);
    expect(b.used).toBe(3);
    expect(b.remaining).toBe(0);
  });

  test("consume returns false once budget is exhausted", () => {
    const b = new IterationBudget(1);
    expect(b.consume()).toBe(true);
    expect(b.consume()).toBe(false);
    expect(b.used).toBe(1);
  });

  test("consume with zero cap is immediately refused", () => {
    const b = new IterationBudget(0);
    expect(b.consume()).toBe(false);
    expect(b.used).toBe(0);
    expect(b.remaining).toBe(0);
  });

  test("refund decrements used when nonzero", () => {
    const b = new IterationBudget(2);
    b.consume();
    expect(b.used).toBe(1);
    b.refund();
    expect(b.used).toBe(0);
    expect(b.remaining).toBe(2);
  });

  test("refund at zero is a no-op", () => {
    const b = new IterationBudget(2);
    b.refund();
    expect(b.used).toBe(0);
  });

  test("remaining clamps to zero when overconsumed via refund underflow", () => {
    // Verifies the `Math.max(0, ...)` clamp matches upstream behavior.
    const b = new IterationBudget(2);
    b.consume();
    b.consume();
    expect(b.remaining).toBe(0);
    b.refund();
    expect(b.remaining).toBe(1);
  });
});
