// Ported from upstream test_hermes_state.py:TestCJKSearchFallback class
// (cjk codepoint / contains / count parts only).
import { describe, expect, it } from "vitest";
import { _containsCjk, _countCjk, _isCjkCodepoint } from "../src/cjk.js";

describe("_isCjkCodepoint", () => {
  it("classifies CJK Unified Ideographs", () => {
    expect(_isCjkCodepoint(0x4e00)).toBe(true);
    expect(_isCjkCodepoint(0x9fff)).toBe(true);
  });

  it("classifies CJK Extension A", () => {
    expect(_isCjkCodepoint(0x3400)).toBe(true);
    expect(_isCjkCodepoint(0x4dbf)).toBe(true);
  });

  it("classifies CJK Extension B (astral)", () => {
    expect(_isCjkCodepoint(0x20000)).toBe(true);
    expect(_isCjkCodepoint(0x2a6df)).toBe(true);
  });

  it("classifies CJK Symbols + Hiragana + Katakana", () => {
    expect(_isCjkCodepoint(0x3000)).toBe(true);
    expect(_isCjkCodepoint(0x303f)).toBe(true);
    expect(_isCjkCodepoint(0x3040)).toBe(true);
    expect(_isCjkCodepoint(0x309f)).toBe(true);
    expect(_isCjkCodepoint(0x30a0)).toBe(true);
    expect(_isCjkCodepoint(0x30ff)).toBe(true);
  });

  it("classifies Hangul syllables", () => {
    expect(_isCjkCodepoint(0xac00)).toBe(true);
    expect(_isCjkCodepoint(0xd7af)).toBe(true);
  });

  it("rejects Latin and surrounding ranges", () => {
    expect(_isCjkCodepoint(0x0041)).toBe(false); // 'A'
    expect(_isCjkCodepoint(0x4dff)).toBe(false); // between Ext-A and Unified
    expect(_isCjkCodepoint(0xd7b0)).toBe(false); // just past Hangul
  });
});

describe("_containsCjk", () => {
  it("detects all major script ranges", () => {
    expect(_containsCjk("记忆断裂")).toBe(true);
    expect(_containsCjk("こんにちは")).toBe(true);
    expect(_containsCjk("カタカナ")).toBe(true);
    expect(_containsCjk("안녕하세요")).toBe(true);
    expect(_containsCjk("기억")).toBe(true);
  });

  it("returns true when mixed with ASCII", () => {
    expect(_containsCjk("日本語mixedwithenglish")).toBe(true);
  });

  it("returns false for pure ASCII and empty strings", () => {
    expect(_containsCjk("hello world")).toBe(false);
    expect(_containsCjk("")).toBe(false);
  });
});

describe("_countCjk", () => {
  it("counts only CJK codepoints", () => {
    expect(_countCjk("hello")).toBe(0);
    expect(_countCjk("hi 大别山")).toBe(3);
    expect(_countCjk("広西 OR 桂林")).toBe(4);
  });

  it("returns 0 for the empty string", () => {
    expect(_countCjk("")).toBe(0);
  });
});
