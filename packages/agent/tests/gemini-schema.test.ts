// Ported from tests/agent/test_gemini_schema.py

import { describe, expect, test } from "vitest";

import {
  sanitizeGeminiSchema,
  sanitizeGeminiToolParameters,
} from "../src/gemini-schema.js";

describe("sanitizeGeminiSchema", () => {
  test("strips disallowed top-level keys ($schema, additionalProperties)", () => {
    const input = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    };
    const out = sanitizeGeminiSchema(input);
    expect(out).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  test("preserves allowed keys", () => {
    const input = {
      type: "string",
      enum: ["a", "b"],
      description: "foo",
      pattern: "^[a-z]+$",
      example: "x",
      default: "a",
    };
    expect(sanitizeGeminiSchema(input)).toEqual(input);
  });

  test("recurses into properties", () => {
    const input = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          additionalProperties: true,
          properties: { x: { type: "integer" } },
        },
      },
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: "object",
      properties: {
        nested: { type: "object", properties: { x: { type: "integer" } } },
      },
    });
  });

  test("rejects non-object properties value", () => {
    expect(sanitizeGeminiSchema({ properties: "not-a-dict" } as unknown as object)).toEqual({});
  });

  test("recurses into items", () => {
    const input = {
      type: "array",
      items: { type: "object", additionalProperties: true, properties: { id: { type: "integer" } } },
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: "array",
      items: { type: "object", properties: { id: { type: "integer" } } },
    });
  });

  test("recurses into anyOf and drops non-dict entries", () => {
    const input = {
      anyOf: [
        { type: "string" },
        "junk",
        { type: "integer", additionalProperties: false },
      ],
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      anyOf: [{ type: "string" }, { type: "integer" }],
    });
  });

  test("rejects non-array anyOf", () => {
    expect(sanitizeGeminiSchema({ anyOf: { type: "string" } } as unknown as object)).toEqual({});
  });

  test("drops integer enum that contains non-string entries", () => {
    const input = { type: "integer", enum: [60, 1440] };
    expect(sanitizeGeminiSchema(input)).toEqual({ type: "integer" });
  });

  test("keeps integer enum when every entry is a string", () => {
    const input = { type: "integer", enum: ["60", "1440"] };
    expect(sanitizeGeminiSchema(input)).toEqual({ type: "integer", enum: ["60", "1440"] });
  });

  test("drops boolean enum with non-string entries", () => {
    expect(sanitizeGeminiSchema({ type: "boolean", enum: [true, false] })).toEqual({
      type: "boolean",
    });
  });

  test("returns {} for non-dict input", () => {
    expect(sanitizeGeminiSchema(null)).toEqual({});
    expect(sanitizeGeminiSchema("string")).toEqual({});
    expect(sanitizeGeminiSchema([])).toEqual({});
    expect(sanitizeGeminiSchema(42)).toEqual({});
  });
});

describe("sanitizeGeminiToolParameters", () => {
  test("non-object input returns default empty-object schema", () => {
    expect(sanitizeGeminiToolParameters(null)).toEqual({ type: "object", properties: {} });
  });

  test("populated schema passes through with disallowed keys stripped", () => {
    const input = { type: "object", additionalProperties: false, properties: {} };
    expect(sanitizeGeminiToolParameters(input)).toEqual({ type: "object", properties: {} });
  });

  test("empty object becomes the default schema", () => {
    expect(sanitizeGeminiToolParameters({})).toEqual({ type: "object", properties: {} });
  });
});
