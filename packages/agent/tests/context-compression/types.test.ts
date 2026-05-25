import { describe, expect, it } from "vitest";

import {
  MINIMUM_CONTEXT_LENGTH,
  accountUsageAvailable,
  defaultToolError,
} from "../../src/context-compression/types.js";
import type { AccountUsageSnapshot } from "../../src/context-compression/types.js";

// Import the two barrels too so v8 counts their `export *` lines as
// covered. The barrels are otherwise dead-code from a coverage perspective.
import * as packageBarrel from "../../src/index.js";
import * as subpackageBarrel from "../../src/context-compression/index.js";

const fixedFetchedAt = new Date("2026-05-25T00:00:00.000Z");

const snapshot = (
  overrides: Partial<AccountUsageSnapshot> = {},
): AccountUsageSnapshot => ({
  provider: "openai-codex",
  source: "usage_api",
  fetchedAt: fixedFetchedAt,
  title: "Account limits",
  windows: [],
  details: [],
  ...overrides,
});

describe("barrel re-exports", () => {
  it("re-exports the contract from the package root", () => {
    expect(packageBarrel.MINIMUM_CONTEXT_LENGTH).toBe(MINIMUM_CONTEXT_LENGTH);
    expect(packageBarrel.defaultToolError).toBe(defaultToolError);
    expect(packageBarrel.accountUsageAvailable).toBe(accountUsageAvailable);
  });

  it("re-exports the contract from the context-compression sub-barrel", () => {
    expect(subpackageBarrel.MINIMUM_CONTEXT_LENGTH).toBe(MINIMUM_CONTEXT_LENGTH);
    expect(subpackageBarrel.defaultToolError).toBe(defaultToolError);
    expect(subpackageBarrel.accountUsageAvailable).toBe(accountUsageAvailable);
  });
});

describe("MINIMUM_CONTEXT_LENGTH", () => {
  it("equals the upstream hard floor of 64 000 tokens", () => {
    // Upstream agent/model_metadata.py:MINIMUM_CONTEXT_LENGTH is the
    // hard floor every Hermes-supported model must satisfy. Pinning this
    // here is load-bearing: the auxiliary-compression-model feasibility
    // probe (conversation_compression.py:check_compression_model_feasibility)
    // hard-rejects any aux model below this value.
    expect(MINIMUM_CONTEXT_LENGTH).toBe(64000);
  });

  it("is a finite positive integer", () => {
    expect(Number.isInteger(MINIMUM_CONTEXT_LENGTH)).toBe(true);
    expect(MINIMUM_CONTEXT_LENGTH).toBeGreaterThan(0);
    expect(Number.isFinite(MINIMUM_CONTEXT_LENGTH)).toBe(true);
  });
});

describe("defaultToolError", () => {
  it("wraps the message in the upstream {\"error\": …} envelope", () => {
    expect(defaultToolError("boom")).toBe('{"error":"boom"}');
  });

  it("escapes JSON-significant characters in the message", () => {
    // Upstream tools.registry.tool_error returns JSON; double-quote /
    // backslash / control characters must be escaped so the wire format
    // round-trips through JSON.parse.
    const raw = 'has "quotes" and \\ backslash and \n newline';
    const wire = defaultToolError(raw);
    expect(JSON.parse(wire)).toEqual({ error: raw });
  });

  it("handles the empty string without producing invalid JSON", () => {
    expect(defaultToolError("")).toBe('{"error":""}');
    expect(JSON.parse(defaultToolError(""))).toEqual({ error: "" });
  });

  it("handles unicode + surrogate pairs faithfully", () => {
    const emoji = "🗜️ compress — résumé 你好";
    const wire = defaultToolError(emoji);
    expect(JSON.parse(wire)).toEqual({ error: emoji });
  });
});

describe("accountUsageAvailable", () => {
  it("returns false when there are no windows AND no details", () => {
    expect(accountUsageAvailable(snapshot())).toBe(false);
  });

  it("returns true when at least one window is present", () => {
    const s = snapshot({
      windows: [
        {
          label: "Session",
          usedPercent: 12.5,
          resetAt: fixedFetchedAt,
        },
      ],
    });
    expect(accountUsageAvailable(s)).toBe(true);
  });

  it("returns true when at least one detail line is present", () => {
    const s = snapshot({ details: ["Credits balance: $42.00"] });
    expect(accountUsageAvailable(s)).toBe(true);
  });

  it("returns true when both windows and details are present", () => {
    const s = snapshot({
      windows: [{ label: "Weekly", usedPercent: 50 }],
      details: ["Credits balance: unlimited"],
    });
    expect(accountUsageAvailable(s)).toBe(true);
  });

  it("returns false when unavailableReason is set, even if windows exist", () => {
    // Mirrors upstream AccountUsageSnapshot.available property — a
    // truthy unavailable_reason overrides the windows/details check
    // so callers don't render stale partial data.
    const s = snapshot({
      windows: [{ label: "Session", usedPercent: 10 }],
      unavailableReason: "auth refresh failed",
    });
    expect(accountUsageAvailable(s)).toBe(false);
  });

  it("returns false when unavailableReason is set, even if details exist", () => {
    const s = snapshot({
      details: ["X: Y"],
      unavailableReason: "no credentials",
    });
    expect(accountUsageAvailable(s)).toBe(false);
  });

  it("treats an empty-string unavailableReason as available", () => {
    // Upstream Python `bool(window/details) and not snapshot.unavailable_reason`
    // — Python `bool("")` is False, so the empty string does NOT block
    // availability. Mirror that exactly so the integrator can pass
    // "" / null / undefined interchangeably.
    const s = snapshot({
      details: ["X: Y"],
      unavailableReason: "",
    });
    expect(accountUsageAvailable(s)).toBe(true);
  });

  it("treats a null unavailableReason as available", () => {
    const s = snapshot({
      windows: [{ label: "Session", usedPercent: 10 }],
      unavailableReason: null,
    });
    expect(accountUsageAvailable(s)).toBe(true);
  });
});
