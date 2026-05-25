// Direct unit coverage for `_encodeContent` / `_decodeContent`. Round-trip
// behaviour is also exercised end-to-end via session-db.test.ts.
import { describe, expect, it } from "vitest";
import {
  CONTENT_JSON_PREFIX,
  _decodeContent,
  _encodeContent,
} from "../src/content-codec.js";

describe("_encodeContent", () => {
  it("passes scalars through unchanged", () => {
    expect(_encodeContent("plain")).toBe("plain");
    expect(_encodeContent(42)).toBe(42);
    expect(_encodeContent(3.14)).toBe(3.14);
    expect(_encodeContent(null)).toBe(null);
    expect(_encodeContent(undefined)).toBe(null);
    const buf = Buffer.from("bytes");
    expect(_encodeContent(buf)).toBe(buf);
  });

  it("JSON-encodes structured content with sentinel prefix", () => {
    const encoded = _encodeContent([{ type: "text", text: "x" }]);
    expect(typeof encoded).toBe("string");
    expect(String(encoded).startsWith(CONTENT_JSON_PREFIX)).toBe(true);
    expect(String(encoded).slice(CONTENT_JSON_PREFIX.length)).toBe(
      '[{"type":"text","text":"x"}]',
    );
  });

  it("falls back to string when JSON.stringify throws", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = _encodeContent(circular);
    // The fallback uses String(value) — which for cyclic objects becomes
    // "[object Object]" — never throws.
    expect(out).toBe(String(circular));
  });
});

describe("_decodeContent", () => {
  it("returns non-strings unchanged", () => {
    expect(_decodeContent(42)).toBe(42);
    expect(_decodeContent(null)).toBe(null);
  });

  it("returns plain strings unchanged", () => {
    expect(_decodeContent("plain")).toBe("plain");
  });

  it("decodes sentinel-prefixed JSON", () => {
    const original = [{ type: "image_url", image_url: { url: "data:..." } }];
    const encoded = _encodeContent(original);
    expect(_decodeContent(encoded)).toEqual(original);
  });

  it("returns the raw string when JSON.parse fails", () => {
    const bad = `${CONTENT_JSON_PREFIX}{not valid json`;
    expect(_decodeContent(bad)).toBe(bad);
  });
});
