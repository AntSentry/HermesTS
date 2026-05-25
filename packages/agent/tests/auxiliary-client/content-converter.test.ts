import { describe, expect, it } from "vitest";
import { convertContentForResponses } from "../../src/auxiliary-client/content-converter.js";

describe("convertContentForResponses", () => {
  it("returns plain strings unchanged", () => {
    expect(convertContentForResponses("hello")).toBe("hello");
    expect(convertContentForResponses("")).toBe("");
  });

  it("returns empty string for null/undefined/false/0/empty-string non-strings", () => {
    expect(convertContentForResponses(null)).toBe("");
    expect(convertContentForResponses(undefined)).toBe("");
    expect(convertContentForResponses(false)).toBe("");
    expect(convertContentForResponses(0)).toBe("");
  });

  it("stringifies truthy non-array, non-string content", () => {
    expect(convertContentForResponses(42)).toBe("42");
    expect(convertContentForResponses(true)).toBe("true");
  });

  it("translates text parts to input_text", () => {
    const result = convertContentForResponses([{ type: "text", text: "hello" }]);
    expect(result).toEqual([{ type: "input_text", text: "hello" }]);
  });

  it("translates image_url parts (object form) to input_image with url+detail", () => {
    const result = convertContentForResponses([
      { type: "image_url", image_url: { url: "data:image/png;base64,XYZ", detail: "high" } },
    ]);
    expect(result).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,XYZ", detail: "high" },
    ]);
  });

  it("translates image_url parts (object form) without detail", () => {
    const result = convertContentForResponses([
      { type: "image_url", image_url: { url: "data:image/png;base64,XYZ" } },
    ]);
    expect(result).toEqual([{ type: "input_image", image_url: "data:image/png;base64,XYZ" }]);
  });

  it("translates image_url parts (string form) to input_image", () => {
    const result = convertContentForResponses([
      // upstream tolerates a bare string in `image_url`
      { type: "image_url", image_url: "data:image/png;base64,STRING" as unknown as never },
    ]);
    expect(result).toEqual([{ type: "input_image", image_url: "data:image/png;base64,STRING" }]);
  });

  it("passes through items already in Responses shape", () => {
    const parts = [
      { type: "input_text", text: "ready" },
      { type: "input_image", image_url: "data:image/png;base64,RDY" },
    ];
    expect(convertContentForResponses(parts)).toEqual(parts);
  });

  it("preserves the text field on unknown part types when present", () => {
    const result = convertContentForResponses([{ type: "future_kind", text: "fallback" }]);
    expect(result).toEqual([{ type: "input_text", text: "fallback" }]);
  });

  it("drops unknown part types without a text field", () => {
    const result = convertContentForResponses([{ type: "future_kind", random: 1 }]);
    expect(result).toBe("");
  });

  it("skips non-object entries inside the list", () => {
    const result = convertContentForResponses([null, "string", 0, { type: "text", text: "x" }]);
    expect(result).toEqual([{ type: "input_text", text: "x" }]);
  });

  it("collapses an empty result list to the empty string", () => {
    expect(convertContentForResponses([])).toBe("");
    expect(convertContentForResponses([{ type: "future_kind" }])).toBe("");
  });

  it("treats missing text on text parts as empty string", () => {
    expect(convertContentForResponses([{ type: "text" }])).toEqual([
      { type: "input_text", text: "" },
    ]);
  });

  it("treats null/undefined type as empty string (falls through to text-extract branch)", () => {
    // type=null is unknown, no text → drop
    expect(convertContentForResponses([{ type: null }])).toBe("");
    // type=undefined ditto
    expect(convertContentForResponses([{ type: undefined as unknown as string }])).toBe("");
    // type missing entirely, with a text field → preserved via the unknown-kind fallback
    expect(convertContentForResponses([{ text: "fallback" }])).toEqual([
      { type: "input_text", text: "fallback" },
    ]);
  });

  it("treats missing url on image_url parts as empty string", () => {
    expect(convertContentForResponses([{ type: "image_url", image_url: {} }])).toEqual([
      { type: "input_image", image_url: "" },
    ]);
    expect(convertContentForResponses([{ type: "image_url" }])).toEqual([
      { type: "input_image", image_url: "" },
    ]);
  });

  it("drops the detail field when it is an empty string or null on object form", () => {
    expect(
      convertContentForResponses([{ type: "image_url", image_url: { url: "u", detail: "" } }]),
    ).toEqual([{ type: "input_image", image_url: "u" }]);
    expect(
      convertContentForResponses([{ type: "image_url", image_url: { url: "u", detail: null } }]),
    ).toEqual([{ type: "input_image", image_url: "u" }]);
  });
});
