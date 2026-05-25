// Ported from upstream lmstudio reasoning tests
// (no dedicated upstream test file — covered by chat-completions
// transport tests in tests/agent/transports/test_chat_completions.py
// and the run_agent iteration-limit summary tests).

import { describe, expect, test } from "vitest";

import { resolveLmstudioEffort } from "../src/lmstudio-reasoning.js";

describe("resolveLmstudioEffort", () => {
  test("defaults to medium when reasoning_config is null and probe failed", () => {
    expect(resolveLmstudioEffort(null, null)).toBe("medium");
    expect(resolveLmstudioEffort(undefined, undefined)).toBe("medium");
  });

  test("returns none when reasoning_config disabled", () => {
    expect(resolveLmstudioEffort({ enabled: false }, null)).toBe("none");
  });

  test("uses configured effort when valid", () => {
    expect(resolveLmstudioEffort({ effort: "low" }, null)).toBe("low");
    expect(resolveLmstudioEffort({ effort: "high" }, null)).toBe("high");
    expect(resolveLmstudioEffort({ effort: "xhigh" }, null)).toBe("xhigh");
  });

  test("trims and lowercases effort strings", () => {
    expect(resolveLmstudioEffort({ effort: "  HIGH " }, null)).toBe("high");
  });

  test("maps toggle aliases off/on onto none/medium", () => {
    expect(resolveLmstudioEffort({ effort: "off" }, null)).toBe("none");
    expect(resolveLmstudioEffort({ effort: "on" }, null)).toBe("medium");
  });

  test("invalid effort string falls back to medium default", () => {
    expect(resolveLmstudioEffort({ effort: "extreme" }, null)).toBe("medium");
  });

  test("non-string effort value is ignored", () => {
    expect(resolveLmstudioEffort({ effort: 42 as unknown as string }, null)).toBe("medium");
    expect(resolveLmstudioEffort({ effort: null }, null)).toBe("medium");
  });

  test("clamps to allowed_options — returns null when effort not allowed", () => {
    expect(resolveLmstudioEffort({ effort: "high" }, ["off", "low"])).toBe(null);
  });

  test("clamps to allowed_options — accepts when effort allowed", () => {
    expect(resolveLmstudioEffort({ effort: "low" }, ["off", "low"])).toBe("low");
  });

  test("clamps applies alias mapping to allowed_options", () => {
    // Toggle-style: allowed_options=["off","on"] becomes {"none","medium"}.
    expect(resolveLmstudioEffort({ effort: "medium" }, ["off", "on"])).toBe("medium");
    expect(resolveLmstudioEffort({ effort: "low" }, ["off", "on"])).toBe(null);
  });

  test("empty allowed_options skips clamping", () => {
    expect(resolveLmstudioEffort({ effort: "high" }, [])).toBe("high");
  });

  test("non-object reasoning_config is treated as empty", () => {
    // Sentinel: an empty object is still a dict in Python.
    expect(resolveLmstudioEffort({}, null)).toBe("medium");
  });
});
