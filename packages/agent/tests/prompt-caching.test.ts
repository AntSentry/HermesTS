// Ported from tests/agent/test_prompt_caching.py

import { describe, expect, test } from "vitest";

import { applyAnthropicCacheControl } from "../src/prompt-caching.js";

describe("applyAnthropicCacheControl", () => {
  test("empty messages → empty result", () => {
    expect(applyAnthropicCacheControl([])).toEqual([]);
  });

  test("system + 3 messages: marks all four with 5m ephemeral", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const out = applyAnthropicCacheControl(msgs);
    // system was string → became content[0]
    expect(out[0]?.content).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    // remaining three each transformed identically (last 3 non-system)
    for (let i = 1; i <= 3; i += 1) {
      const c = (out[i]?.content as Array<{ cache_control: unknown }>)[0];
      expect(c?.cache_control).toEqual({ type: "ephemeral" });
    }
  });

  test("uses 1h marker when cacheTtl is 1h", () => {
    const out = applyAnthropicCacheControl([{ role: "user", content: "x" }], "1h");
    expect((out[0]?.content as Array<{ cache_control: unknown }>)[0]?.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  test("does not mutate the caller's input", () => {
    const msgs = [{ role: "user", content: "hi" }];
    applyAnthropicCacheControl(msgs);
    expect(msgs[0]?.content).toBe("hi");
  });

  test("uses last 4 non-system breakpoints when no system message", () => {
    // No system → 4 breakpoints remain → last 4 non-system messages
    // are rewritten. With 5 messages, the first stays a string.
    const msgs = [
      { role: "user", content: "0" },
      { role: "user", content: "1" },
      { role: "user", content: "2" },
      { role: "user", content: "3" },
      { role: "user", content: "4" },
    ];
    const out = applyAnthropicCacheControl(msgs);
    expect(typeof out[0]?.content).toBe("string");
    for (let i = 1; i < 5; i += 1) {
      expect(Array.isArray(out[i]?.content)).toBe(true);
    }
  });

  test("tool role with nativeAnthropic=true gets top-level cache_control", () => {
    const out = applyAnthropicCacheControl(
      [{ role: "tool", content: "result" }],
      "5m",
      true,
    );
    expect(out[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(out[0]?.content).toBe("result");
  });

  test("tool role with nativeAnthropic=false does not get cache_control", () => {
    const out = applyAnthropicCacheControl([{ role: "tool", content: "result" }], "5m", false);
    expect(out[0]?.cache_control).toBeUndefined();
  });

  test("empty-content message receives top-level cache_control", () => {
    const out = applyAnthropicCacheControl([{ role: "user", content: "" }]);
    expect(out[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("null-content message receives top-level cache_control", () => {
    const out = applyAnthropicCacheControl([{ role: "user", content: null }]);
    expect(out[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("list-content message gets marker on last content part", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ];
    const out = applyAnthropicCacheControl(msgs);
    const parts = out[0]?.content as Array<{ cache_control?: unknown }>;
    expect(parts[0]?.cache_control).toBeUndefined();
    expect(parts[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("list-content with non-object last part is left untouched", () => {
    const msgs = [{ role: "user", content: ["plain string"] }];
    const out = applyAnthropicCacheControl(msgs);
    // No cache_control added on a non-dict last; message itself also not marked.
    expect(out[0]?.cache_control).toBeUndefined();
  });

  test("empty-list content is treated as 'no last part' (no marker added)", () => {
    const msgs = [{ role: "user", content: [] }];
    const out = applyAnthropicCacheControl(msgs);
    expect(out[0]?.cache_control).toBeUndefined();
  });

  test("system-only messages: only the system gets a breakpoint, no others", () => {
    const out = applyAnthropicCacheControl([{ role: "system", content: "sys" }]);
    expect(Array.isArray(out[0]?.content)).toBe(true);
  });
});
