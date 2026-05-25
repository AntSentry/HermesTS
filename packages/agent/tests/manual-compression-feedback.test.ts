// Ported from upstream manual_compression_feedback tests
// (no dedicated upstream test file — exercised via compression slash
// commands in cli/gateway tests).

import { describe, expect, test } from "vitest";

import { summarizeManualCompression } from "../src/manual-compression-feedback.js";

describe("summarizeManualCompression", () => {
  test("identical before/after with same tokens reports noop unchanged", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const out = summarizeManualCompression(msgs, msgs, 100, 100);
    expect(out.noop).toBe(true);
    expect(out.headline).toBe("No changes from compression: 1 messages");
    expect(out.tokenLine).toBe("Approx request size: ~100 tokens (unchanged)");
    expect(out.note).toBe(null);
  });

  test("identical before/after with different tokens reports noop with delta", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const out = summarizeManualCompression(msgs, msgs, 100, 80);
    expect(out.noop).toBe(true);
    expect(out.tokenLine).toBe("Approx request size: ~100 → ~80 tokens");
  });

  test("compression reports message count delta and token delta", () => {
    const before = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const after = [{ role: "system", content: "summary" }];
    const out = summarizeManualCompression(before, after, 1234, 500);
    expect(out.noop).toBe(false);
    expect(out.headline).toBe("Compressed: 3 → 1 messages");
    expect(out.tokenLine).toBe("Approx request size: ~1,234 → ~500 tokens");
    expect(out.note).toBe(null);
  });

  test("note appears when fewer messages but more tokens", () => {
    const before = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    const after = [{ role: "system", content: "denser summary" }];
    const out = summarizeManualCompression(before, after, 100, 200);
    expect(out.noop).toBe(false);
    expect(out.note).not.toBe(null);
    expect(out.note).toContain("denser summaries");
  });

  test("note does NOT appear when more messages remain (even if tokens rose)", () => {
    const before = [{ role: "user", content: "a" }];
    const after = [
      { role: "system", content: "s" },
      { role: "user", content: "a" },
    ];
    const out = summarizeManualCompression(before, after, 100, 200);
    expect(out.note).toBe(null);
  });

  test("formats thousands separators with comma", () => {
    const out = summarizeManualCompression([{}], [{}], 1_234_567, 999_999);
    // Equal messages, equal tokens? no — different tokens but msgs equal.
    expect(out.noop).toBe(true);
    expect(out.tokenLine).toContain("1,234,567");
    expect(out.tokenLine).toContain("999,999");
  });
});
