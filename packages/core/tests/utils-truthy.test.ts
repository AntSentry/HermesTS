// Ported from tests/test_utils_truthy_values.py

import { afterEach, describe, expect, test } from "vitest";
import { envVarEnabled, isTruthyValue } from "../src/utils.js";

const ENV_KEY = "HERMES_TEST_BOOL";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("isTruthyValue", () => {
  test("accepts common truthy strings", () => {
    expect(isTruthyValue("true")).toBe(true);
    expect(isTruthyValue(" YES ")).toBe(true);
    expect(isTruthyValue("on")).toBe(true);
    expect(isTruthyValue("1")).toBe(true);
  });

  test("respects default for null", () => {
    expect(isTruthyValue(null, true)).toBe(true);
    expect(isTruthyValue(null, false)).toBe(false);
  });

  test("respects default for undefined", () => {
    expect(isTruthyValue(undefined, true)).toBe(true);
    expect(isTruthyValue(undefined, false)).toBe(false);
  });

  test("rejects falsey strings", () => {
    expect(isTruthyValue("false")).toBe(false);
    expect(isTruthyValue("0")).toBe(false);
    expect(isTruthyValue("off")).toBe(false);
  });

  test("passes through booleans", () => {
    expect(isTruthyValue(true)).toBe(true);
    expect(isTruthyValue(false)).toBe(false);
  });

  test("coerces other types via Boolean()", () => {
    expect(isTruthyValue(0)).toBe(false);
    expect(isTruthyValue(1)).toBe(true);
    expect(isTruthyValue({})).toBe(true);
  });
});

describe("envVarEnabled", () => {
  test("uses shared truthy rules (mixed case YeS)", () => {
    process.env[ENV_KEY] = "YeS";
    expect(envVarEnabled(ENV_KEY)).toBe(true);
  });

  test("returns false for 'no'", () => {
    process.env[ENV_KEY] = "no";
    expect(envVarEnabled(ENV_KEY)).toBe(false);
  });

  test("respects default when unset", () => {
    delete process.env[ENV_KEY];
    expect(envVarEnabled(ENV_KEY, "")).toBe(false);
    expect(envVarEnabled(ENV_KEY, "true")).toBe(true);
  });
});
