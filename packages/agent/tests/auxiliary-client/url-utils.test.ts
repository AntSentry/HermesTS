import { describe, expect, it } from "vitest";
import {
  extractUrlQueryParams,
  safeInstanceof,
  toOpenAIBaseUrl,
} from "../../src/auxiliary-client/url-utils.js";

describe("safeInstanceof", () => {
  class A {}
  class B extends A {}

  it("returns true when obj is an instance of ctor", () => {
    expect(safeInstanceof(new A(), A)).toBe(true);
    expect(safeInstanceof(new B(), A)).toBe(true);
    expect(safeInstanceof(new B(), B)).toBe(true);
  });

  it("returns false when obj is not an instance", () => {
    expect(safeInstanceof({}, A)).toBe(false);
    expect(safeInstanceof(null, A)).toBe(false);
    expect(safeInstanceof(new A(), B)).toBe(false);
  });

  it("returns false (no throw) when ctor is not a function", () => {
    expect(safeInstanceof(new A(), null)).toBe(false);
    expect(safeInstanceof(new A(), undefined)).toBe(false);
    expect(safeInstanceof(new A(), {})).toBe(false);
    expect(safeInstanceof(new A(), "not a class")).toBe(false);
    expect(safeInstanceof(new A(), 42)).toBe(false);
  });

  it("returns false when ctor has a throwing [Symbol.hasInstance]", () => {
    const bad = () => {};
    Object.defineProperty(bad, Symbol.hasInstance, {
      value: () => {
        throw new TypeError("nope");
      },
    });
    expect(safeInstanceof({}, bad)).toBe(false);
  });
});

describe("extractUrlQueryParams", () => {
  it("returns the URL unchanged when there is no query string", () => {
    expect(extractUrlQueryParams("https://api.example.com/v1")).toEqual({
      cleanUrl: "https://api.example.com/v1",
      defaultQuery: null,
    });
  });

  it("returns an empty default-query dict when ?foo= has empty values", () => {
    const result = extractUrlQueryParams("https://api.example.com/v1?foo=&bar=1");
    expect(result.cleanUrl).toBe("https://api.example.com/v1");
    expect(result.defaultQuery).toEqual({ foo: "", bar: "1" });
  });

  it("keeps only the first value when a key is repeated", () => {
    const result = extractUrlQueryParams("https://api.example.com/v1?k=a&k=b&k=c");
    expect(result.cleanUrl).toBe("https://api.example.com/v1");
    expect(result.defaultQuery).toEqual({ k: "a" });
  });

  it("preserves path and fragment, removes only the query", () => {
    const result = extractUrlQueryParams("https://api.example.com/v1/foo?x=1#frag");
    expect(result.cleanUrl).toBe("https://api.example.com/v1/foo#frag");
    expect(result.defaultQuery).toEqual({ x: "1" });
  });

  it("returns the input unchanged for unparseable URLs", () => {
    expect(extractUrlQueryParams("not a url")).toEqual({
      cleanUrl: "not a url",
      defaultQuery: null,
    });
  });
});

describe("toOpenAIBaseUrl", () => {
  it("returns empty string for null/undefined/whitespace", () => {
    expect(toOpenAIBaseUrl(null)).toBe("");
    expect(toOpenAIBaseUrl(undefined)).toBe("");
    expect(toOpenAIBaseUrl("   ")).toBe("");
  });

  it("strips trailing slashes from non-special URLs", () => {
    expect(toOpenAIBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(toOpenAIBaseUrl("https://api.example.com/v1///")).toBe("https://api.example.com/v1");
  });

  it("rewrites generic /anthropic → /v1", () => {
    expect(toOpenAIBaseUrl("https://api.minimax.chat/anthropic")).toBe(
      "https://api.minimax.chat/v1",
    );
    expect(toOpenAIBaseUrl("https://api.minimax.cn/anthropic/")).toBe("https://api.minimax.cn/v1");
  });

  it("rewrites ZAI bigmodel.cn /anthropic → /paas/v4", () => {
    expect(toOpenAIBaseUrl("https://open.bigmodel.cn/api/anthropic")).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
    expect(toOpenAIBaseUrl("https://other-bigmodel.example/api/anthropic")).toBe(
      "https://other-bigmodel.example/api/paas/v4",
    );
  });

  it("appends /v1 for Kimi Code /coding base URLs", () => {
    expect(toOpenAIBaseUrl("https://api.kimi.com/coding")).toBe("https://api.kimi.com/coding/v1");
    expect(toOpenAIBaseUrl("https://api.kimi.com/coding/")).toBe("https://api.kimi.com/coding/v1");
  });

  it("passes through unrelated URLs", () => {
    expect(toOpenAIBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(toOpenAIBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com");
    // Hosts mentioning 'anthropic' but not as a suffix segment must not rewrite.
    expect(toOpenAIBaseUrl("https://api.anthropic.example/v1")).toBe(
      "https://api.anthropic.example/v1",
    );
  });
});
