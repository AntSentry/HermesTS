// Ported from upstream test_hermes_state.py:TestSanitizeTitle.
import { describe, expect, it } from "vitest";
import { MAX_TITLE_LENGTH, sanitizeTitle } from "../src/title.js";

describe("sanitizeTitle", () => {
  it("returns null for falsy input", () => {
    expect(sanitizeTitle(null)).toBe(null);
    expect(sanitizeTitle(undefined)).toBe(null);
    expect(sanitizeTitle("")).toBe(null);
    expect(sanitizeTitle("   \t\n  ")).toBe(null);
  });

  it("normal title is unchanged", () => {
    expect(sanitizeTitle("My Project")).toBe("My Project");
  });

  it("strips and collapses whitespace", () => {
    expect(sanitizeTitle("  hello world  ")).toBe("hello world");
    expect(sanitizeTitle("hello   world")).toBe("hello world");
    expect(sanitizeTitle("hello\t\nworld")).toBe("hello world");
  });

  it("strips ASCII control characters", () => {
    expect(sanitizeTitle("hello\x00world")).toBe("helloworld");
    expect(sanitizeTitle("\x07\x08test\x1b")).toBe("test");
    expect(sanitizeTitle("hello\x7fworld")).toBe("helloworld");
  });

  it("strips zero-width / RTL override / BOM characters", () => {
    expect(sanitizeTitle("hello​world")).toBe("helloworld");
    expect(sanitizeTitle("hello‍world")).toBe("helloworld");
    expect(sanitizeTitle("hello‮world")).toBe("helloworld");
    expect(sanitizeTitle("﻿hello")).toBe("hello");
  });

  it("returns null when only control chars remain", () => {
    expect(sanitizeTitle("\x00\x01\x02​﻿")).toBe(null);
  });

  it("accepts titles at MAX_TITLE_LENGTH", () => {
    const title = "A".repeat(MAX_TITLE_LENGTH);
    expect(sanitizeTitle(title)).toBe(title);
  });

  it("throws when title exceeds MAX_TITLE_LENGTH", () => {
    expect(() => sanitizeTitle("A".repeat(MAX_TITLE_LENGTH + 1))).toThrow(
      /too long/,
    );
  });

  it("preserves emoji, CJK and accented characters", () => {
    expect(sanitizeTitle("🚀 My Project 🎉")).toBe("🚀 My Project 🎉");
    expect(sanitizeTitle("我的项目")).toBe("我的项目");
    expect(sanitizeTitle("Résumé éditing")).toBe("Résumé éditing");
  });

  it("preserves special punctuation that's valid in titles", () => {
    const title = "PR #438 — fixing the 'auth' middleware";
    expect(sanitizeTitle(title)).toBe(title);
  });
});
