// Ported from tests/agent/test_moonshot_schema.py

import { describe, expect, test } from "vitest";

import {
  isMoonshotModel,
  sanitizeMoonshotToolParameters,
  sanitizeMoonshotTools,
} from "../src/moonshot-schema.js";

describe("sanitizeMoonshotToolParameters — Rule 1: fill missing type", () => {
  test("property without type defaults to string", () => {
    const input = { type: "object", properties: { foo: { description: "x" } } };
    const out = sanitizeMoonshotToolParameters(input) as {
      properties: { foo: { type: string } };
    };
    expect(out.properties.foo.type).toBe("string");
  });

  test("property with nested properties → object", () => {
    const input = { type: "object", properties: { p: { properties: {} } } };
    const out = sanitizeMoonshotToolParameters(input) as {
      properties: { p: { type: string } };
    };
    expect(out.properties.p.type).toBe("object");
  });

  test("property with items → array", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { l: { items: { type: "string" } } },
    }) as { properties: { l: { type: string } } };
    expect(out.properties.l.type).toBe("array");
  });

  test("enum without type infers from sample type — integer", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { enum: [1, 2, 3] } },
    }) as { properties: { p: { type: string } } };
    expect(out.properties.p.type).toBe("integer");
  });

  test("enum without type infers number for float sample", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { enum: [1.5, 2.5] } },
    }) as { properties: { p: { type: string } } };
    expect(out.properties.p.type).toBe("number");
  });

  test("enum without type infers boolean for bool sample", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { enum: [true, false] } },
    }) as { properties: { p: { type: string } } };
    expect(out.properties.p.type).toBe("boolean");
  });

  test("enum without type or recognized sample defaults to string", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { enum: [{ x: 1 }] } },
    }) as { properties: { p: { type: string } } };
    expect(out.properties.p.type).toBe("string");
  });

  test("required without other shape hints → object", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { required: ["x"] } },
    }) as { properties: { p: { type: string } } };
    expect(out.properties.p.type).toBe("object");
  });

  test("preserves an existing type field", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { type: "boolean", description: "x" } },
    }) as { properties: { p: { type: string } } };
    expect(out.properties.p.type).toBe("boolean");
  });
});

describe("sanitizeMoonshotToolParameters — Rule 2: anyOf collapse", () => {
  test("strips parent type when anyOf present", () => {
    const input = {
      type: "object",
      properties: {
        p: { type: "string", anyOf: [{ type: "string" }, { type: "integer" }] },
      },
    };
    const out = sanitizeMoonshotToolParameters(input) as {
      properties: { p: { type?: string; anyOf?: unknown[] } };
    };
    expect(out.properties.p.type).toBeUndefined();
    expect(out.properties.p.anyOf).toEqual([{ type: "string" }, { type: "integer" }]);
  });

  test("collapses to single non-null branch", () => {
    const input = {
      type: "object",
      properties: {
        p: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    };
    const out = sanitizeMoonshotToolParameters(input) as {
      properties: { p: { type: string; anyOf?: unknown[] } };
    };
    expect(out.properties.p.anyOf).toBeUndefined();
    expect(out.properties.p.type).toBe("string");
  });

  test("keeps multiple non-null branches inside anyOf", () => {
    const input = {
      type: "object",
      properties: {
        p: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
      },
    };
    const out = sanitizeMoonshotToolParameters(input) as {
      properties: { p: { anyOf: Array<Record<string, unknown>> } };
    };
    expect(out.properties.p.anyOf).toHaveLength(2);
  });

  test("all-null anyOf is left intact (no replacement)", () => {
    const input = {
      type: "object",
      properties: {
        p: { anyOf: [{ type: "null" }] },
      },
    };
    const out = sanitizeMoonshotToolParameters(input) as {
      properties: { p: { anyOf: Array<Record<string, unknown>> } };
    };
    expect(out.properties.p.anyOf).toEqual([{ type: "null" }]);
  });
});

describe("sanitizeMoonshotToolParameters — Rule 3: enum cleanup", () => {
  test("strips null and empty-string entries on string type", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { type: "string", enum: ["a", null, "", "b"] } },
    }) as { properties: { p: { enum: unknown[] } } };
    expect(out.properties.p.enum).toEqual(["a", "b"]);
  });

  test("drops enum entirely if it becomes empty", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { type: "string", enum: [null, ""] } },
    }) as { properties: { p: { enum?: unknown[] } } };
    expect(out.properties.p.enum).toBeUndefined();
  });

  test("non-scalar parent type leaves enum alone", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { type: "array", enum: [null, "a"] } },
    }) as { properties: { p: { enum: unknown[] } } };
    expect(out.properties.p.enum).toEqual([null, "a"]);
  });
});

describe("sanitizeMoonshotToolParameters — Rule 4: $ref sibling strip", () => {
  test("strips siblings of $ref", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { $ref: "#/defs/X", description: "junk" } },
    }) as { properties: { p: Record<string, unknown> } };
    expect(out.properties.p).toEqual({ $ref: "#/defs/X" });
  });
});

describe("sanitizeMoonshotToolParameters — Rule 5: tuple items collapse", () => {
  test("array items as tuple collapses to first element", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { type: "array", items: [{ type: "string" }, { type: "integer" }] } },
    }) as { properties: { p: { items: Record<string, unknown> } } };
    expect(out.properties.p.items).toEqual({ type: "string" });
  });

  test("empty tuple items collapses to a default string-type schema", () => {
    // Upstream `_repair_schema({}, is_schema=True)` walks the empty dict
    // and applies Rule 1 (fill missing type → 'string'). Mirror that.
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { type: "array", items: [] } },
    }) as { properties: { p: { items: { type?: string } } } };
    expect(out.properties.p.items).toEqual({ type: "string" });
  });

  test("non-dict first element passes through unchanged", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { type: "array", items: ["x"] } },
    }) as { properties: { p: { items: unknown } } };
    expect(out.properties.p.items).toBe("x");
  });
});

describe("sanitizeMoonshotToolParameters — top-level shaping", () => {
  test("non-object input returns default", () => {
    expect(sanitizeMoonshotToolParameters(null)).toEqual({ type: "object", properties: {} });
    expect(sanitizeMoonshotToolParameters(42)).toEqual({ type: "object", properties: {} });
  });

  test("forces type: object at top level", () => {
    const out = sanitizeMoonshotToolParameters({ type: "string", properties: {} });
    expect((out as { type: string }).type).toBe("object");
  });

  test("ensures properties field exists", () => {
    const out = sanitizeMoonshotToolParameters({ type: "object" });
    expect(out).toEqual({ type: "object", properties: {} });
  });

  test("nullable keyword is stripped on schema nodes", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { type: "string", nullable: true } },
    }) as { properties: { p: Record<string, unknown> } };
    expect(out.properties.p.nullable).toBeUndefined();
  });

  test("schema-map keys recurse via patternProperties / $defs / definitions", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      $defs: { X: { properties: { a: { description: "x" } } } },
      patternProperties: { "^foo$": { properties: { b: {} } } },
      definitions: { Y: { properties: { c: {} } } },
      properties: {},
    }) as {
      $defs: { X: { properties: { a: { type: string } } } };
      patternProperties: { "^foo$": { properties: { b: { type: string } } } };
      definitions: { Y: { properties: { c: { type: string } } } };
    };
    expect(out.$defs.X.properties.a.type).toBe("string");
    expect(out.patternProperties["^foo$"].properties.b.type).toBe("string");
    expect(out.definitions.Y.properties.c.type).toBe("string");
  });

  test("schema-map non-dict child passes through unchanged", () => {
    // Triggers the `isPlainObject(subVal) ? repair : subVal` else branch.
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      $defs: { Bad: "not-a-schema-dict" },
      properties: {},
    }) as { $defs: { Bad: string } };
    expect(out.$defs.Bad).toBe("not-a-schema-dict");
  });

  test("schema-list non-dict element passes through unchanged", () => {
    // Triggers the `isPlainObject(v) ? repair : v` else branch.
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { p: { oneOf: [{ type: "string" }, "junk"] } },
    }) as { properties: { p: { oneOf: unknown[] } } };
    expect(out.properties.p.oneOf).toEqual([{ type: "string" }, "junk"]);
  });

  test("schema-list keys oneOf/allOf/prefixItems recurse", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        p: {
          oneOf: [{ description: "a" }],
          allOf: [{ description: "b" }],
          prefixItems: [{ description: "c" }],
        },
      },
    }) as {
      properties: {
        p: {
          oneOf: Array<{ type: string }>;
          allOf: Array<{ type: string }>;
          prefixItems: Array<{ type: string }>;
        };
      };
    };
    expect(out.properties.p.oneOf[0]?.type).toBe("string");
    expect(out.properties.p.allOf[0]?.type).toBe("string");
    expect(out.properties.p.prefixItems[0]?.type).toBe("string");
  });

  test("contains / not / additionalProperties recurse", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        p: {
          contains: { description: "c" },
          not: { description: "n" },
          additionalProperties: { description: "ap" },
        },
      },
    }) as {
      properties: {
        p: {
          contains: { type: string };
          not: { type: string };
          additionalProperties: { type: string };
        };
      };
    };
    expect(out.properties.p.contains.type).toBe("string");
    expect(out.properties.p.not.type).toBe("string");
    expect(out.properties.p.additionalProperties.type).toBe("string");
  });

  test("additionalProperties: bool is left alone", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      additionalProperties: true,
      properties: {},
    }) as { additionalProperties: boolean };
    expect(out.additionalProperties).toBe(true);
  });

  test("top-level repaired non-object somehow yields default", () => {
    // Construct via Array which `repairSchema` returns as-is when isSchema=true
    // is mapped over its members. To exercise the `!isPlainObject(repaired)`
    // guard, feed something that survives repair as a non-dict.
    const out = sanitizeMoonshotToolParameters({ anyOf: [{ type: "null" }] });
    // anyOf-only with null branch → stays an object with anyOf, gets
    // type=object forced. So this exercises that overwrite branch.
    expect((out as { type: string }).type).toBe("object");
    expect((out as { properties: Record<string, unknown> }).properties).toEqual({});
  });

  test("anyOf with single non-null branch promotes and enum cleanup still applies", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        p: {
          anyOf: [{ type: "string", enum: ["a", "", null] }, { type: "null" }],
        },
      },
    }) as { properties: { p: { type: string; enum: unknown[] } } };
    expect(out.properties.p.type).toBe("string");
    expect(out.properties.p.enum).toEqual(["a"]);
  });

  test("anyOf with single non-null branch preserves sibling keys via merge loop", () => {
    // Triggers the `if (k !== "anyOf") merge[k] = v` branch — needs a
    // sibling field alongside anyOf that survives into the promoted shape.
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        p: {
          description: "kept across promote",
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
    }) as { properties: { p: { type: string; description: string } } };
    expect(out.properties.p.type).toBe("string");
    expect(out.properties.p.description).toBe("kept across promote");
  });
});

describe("sanitizeMoonshotTools", () => {
  test("rebuilds the array whenever any tool's parameters were deep-cloned", () => {
    // Upstream `_repair_schema` always returns a new object (deep-copy), so
    // any tool with a dict `parameters` triggers `any_change=True` and the
    // sanitized array is re-emitted. Reference equality therefore drops
    // even when the schema content is structurally identical.
    const tools = [
      { type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } },
    ];
    const out = sanitizeMoonshotTools(tools);
    expect(out).not.toBe(tools);
    expect(out).toEqual(tools);
  });

  test("returns same array reference when no tool has a `function` dict", () => {
    // Tools without a function-dict short-circuit the rebuild loop
    // before any_change flips.
    const tools = [
      { type: "function", function: "not-a-dict" },
    ] as unknown as Array<Record<string, unknown>>;
    const out = sanitizeMoonshotTools(tools);
    expect(out).toBe(tools);
  });

  test("empty array returned as-is", () => {
    const tools: Array<{ type: string }> = [];
    expect(sanitizeMoonshotTools(tools)).toBe(tools);
  });

  test("repairs tool whose parameters needed sanitization", () => {
    const tools = [
      {
        type: "function",
        function: { name: "f", parameters: { type: "object", properties: { x: { description: "?" } } } },
      },
    ];
    const out = sanitizeMoonshotTools(tools) as Array<{
      function: { parameters: { properties: { x: { type: string } } } };
    }>;
    expect(out).not.toBe(tools);
    expect(out[0]?.function.parameters.properties.x.type).toBe("string");
  });

  test("preserves non-object entries", () => {
    const tools = [null, "not a tool", { something: "else" }] as unknown as Array<
      Record<string, unknown>
    >;
    const out = sanitizeMoonshotTools(tools);
    expect(out).toBe(tools);
  });

  test("ignores tools without a function dict", () => {
    const tools = [{ type: "function", function: "not a dict" } as unknown as Record<string, unknown>];
    const out = sanitizeMoonshotTools(tools);
    expect(out).toBe(tools);
  });
});

describe("isMoonshotModel", () => {
  test("bare kimi name", () => {
    expect(isMoonshotModel("kimi-k2.6")).toBe(true);
    expect(isMoonshotModel("kimi")).toBe(true);
  });

  test("aggregator-prefixed slugs", () => {
    expect(isMoonshotModel("nous/moonshotai/kimi-k2.6")).toBe(true);
    expect(isMoonshotModel("openrouter/moonshotai/Kimi-K2.6")).toBe(true);
  });

  test("vendor-prefixed forms with /kimi", () => {
    expect(isMoonshotModel("vendor/kimi-foo")).toBe(true);
  });

  test("plain 'moonshot' substring", () => {
    expect(isMoonshotModel("api.moonshot.ai/something")).toBe(true);
  });

  test("non-moonshot models return false", () => {
    expect(isMoonshotModel("gpt-4o")).toBe(false);
    expect(isMoonshotModel("")).toBe(false);
    expect(isMoonshotModel(null)).toBe(false);
    expect(isMoonshotModel(undefined)).toBe(false);
  });
});
