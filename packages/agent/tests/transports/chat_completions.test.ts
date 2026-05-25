/**
 * Tests for `@hermests/agent/transports/chat_completions`.
 *
 * Ported from upstream `tests/agent/transports/test_chat_completions.py`.
 * Profile-path cases use a local fake `ChatCompletionsProvider` rather
 * than reaching into `@hermests/plugins` (which is sub-task #8 and may
 * not be merged). The fake mirrors the upstream `ProviderProfile`
 * surface — `prepareMessages`, `buildExtraBody`, `buildApiKwargsExtras`.
 */

import { OMIT_TEMPERATURE } from "@hermests/providers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ChatCompletionsTransport,
  DEVELOPER_ROLE_MODELS,
  buildGeminiThinkingConfig,
  isGeminiOpenaiCompatBaseUrl,
  isMoonshotModel,
  resolveLmstudioEffort,
  sanitizeMoonshotToolParameters,
  sanitizeMoonshotTools,
  snakeCaseGeminiThinkingConfig,
  type ChatCompletionsProvider,
} from "../../src/transports/chat_completions.js";
import {
  _resetTransportRegistryForTesting,
  _setDiscoveryHookForTesting,
  getTransport,
  registerTransport,
} from "../../src/transports/registry.js";
import { NormalizedResponse } from "../../src/transports/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

class FakeProvider implements ChatCompletionsProvider {
  readonly name: string;
  readonly fixedTemperature: number | symbol | null;
  readonly defaultMaxTokens: number | null;
  readonly extraBody: Record<string, unknown>;
  readonly apiKwargsExtras: [Record<string, unknown>, Record<string, unknown>];
  prepareMessagesCalls: Array<Array<Record<string, unknown>>> = [];

  constructor(options: {
    name?: string;
    fixedTemperature?: number | symbol | null;
    defaultMaxTokens?: number | null;
    extraBody?: Record<string, unknown>;
    apiKwargsExtras?: [Record<string, unknown>, Record<string, unknown>];
  } = {}) {
    this.name = options.name ?? "fake";
    this.fixedTemperature = options.fixedTemperature ?? null;
    this.defaultMaxTokens = options.defaultMaxTokens ?? null;
    this.extraBody = options.extraBody ?? {};
    this.apiKwargsExtras = options.apiKwargsExtras ?? [{}, {}];
  }

  prepareMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    this.prepareMessagesCalls.push(messages);
    return messages;
  }

  buildExtraBody(): Record<string, unknown> {
    return { ...this.extraBody };
  }

  buildApiKwargsExtras(): [Record<string, unknown>, Record<string, unknown>] {
    return [{ ...this.apiKwargsExtras[0] }, { ...this.apiKwargsExtras[1] }];
  }
}

// Test seam — chat_completions.ts auto-registers on import. We reset
// between tests to keep registry assertions deterministic.
beforeEach(() => {
  _resetTransportRegistryForTesting();
  _setDiscoveryHookForTesting(null);
});

afterEach(() => {
  _resetTransportRegistryForTesting();
  _setDiscoveryHookForTesting(null);
});

// ── Pure helper tests ─────────────────────────────────────────────────

describe("resolveLmstudioEffort", () => {
  test("default effort is 'medium' when no config", () => {
    expect(resolveLmstudioEffort(null, null)).toBe("medium");
    expect(resolveLmstudioEffort(undefined, undefined)).toBe("medium");
  });

  test("enabled=false resolves to 'none'", () => {
    expect(resolveLmstudioEffort({ enabled: false }, null)).toBe("none");
  });

  test("explicit effort wins when in valid set", () => {
    expect(resolveLmstudioEffort({ effort: "high" }, null)).toBe("high");
    expect(resolveLmstudioEffort({ effort: "xhigh" }, null)).toBe("xhigh");
  });

  test("aliased 'on' → 'medium', 'off' → 'none'", () => {
    expect(resolveLmstudioEffort({ effort: "on" }, null)).toBe("medium");
    expect(resolveLmstudioEffort({ effort: "off" }, null)).toBe("none");
  });

  test("invalid effort string falls back to default 'medium'", () => {
    expect(resolveLmstudioEffort({ effort: "wat" }, null)).toBe("medium");
  });

  test("non-string effort silently falls back", () => {
    expect(resolveLmstudioEffort({ effort: 7 }, null)).toBe("medium");
  });

  test("allowedOptions clamps to null when effort not in allowed set", () => {
    expect(resolveLmstudioEffort({ effort: "high" }, ["off", "on"])).toBeNull();
    expect(
      resolveLmstudioEffort({ effort: "high" }, ["off", "minimal", "low"]),
    ).toBeNull();
  });

  test("toggle ['off','on'] aliases survive clamping at default medium", () => {
    expect(resolveLmstudioEffort({ effort: "medium" }, ["off", "on"])).toBe("medium");
  });

  test("disabled stays 'none' when 'off' is allowed", () => {
    expect(resolveLmstudioEffort({ enabled: false }, ["off", "on"])).toBe("none");
  });

  test("empty allowedOptions falsy → no clamping", () => {
    expect(resolveLmstudioEffort({ effort: "high" }, [])).toBe("high");
    expect(resolveLmstudioEffort({ effort: "high" }, null)).toBe("high");
  });

  test("passes through when effort allowed", () => {
    expect(
      resolveLmstudioEffort({ effort: "high" }, ["off", "low", "medium", "high"]),
    ).toBe("high");
  });
});

describe("isMoonshotModel", () => {
  test.each([
    ["kimi-k2", true],
    ["kimi-k2.6", true],
    ["kimi", true],
    ["moonshotai/Kimi-K2.6", true],
    ["nous/moonshotai/kimi-k2.6", true],
    ["openrouter/moonshotai/kimi-foo", true],
    ["MOONSHOT/anything", true],
    ["claude-sonnet-4", false],
    ["gpt-4o", false],
    [null, false],
    [undefined, false],
    ["", false],
  ])("isMoonshotModel(%o) === %s", (model, expected) => {
    expect(isMoonshotModel(model)).toBe(expected);
  });

  test("trailing-slash slug splits with empty tail; bare-startswith branch decides", () => {
    // `"foo/".split("/").pop()` returns `""` (still defined, so `?? bare`
    // is dead). The tail empty-string then misses the kimi-prefix tests;
    // the bare-string tests run next.
    expect(isMoonshotModel("foo/")).toBe(false);
    expect(isMoonshotModel("foo/kimi-bar")).toBe(true);
  });
});

describe("sanitizeMoonshotToolParameters", () => {
  test("non-record input returns canonical object schema", () => {
    expect(sanitizeMoonshotToolParameters(null)).toEqual({ type: "object", properties: {} });
    expect(sanitizeMoonshotToolParameters("foo")).toEqual({ type: "object", properties: {} });
    expect(sanitizeMoonshotToolParameters(42)).toEqual({ type: "object", properties: {} });
  });

  test("fills missing type on property schemas", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { q: { description: "search query" } },
    });
    const props = (out.properties as Record<string, { type: string }>);
    expect(props.q?.type).toBe("string");
  });

  test("ensures top-level is an object schema", () => {
    const out = sanitizeMoonshotToolParameters({ properties: {} });
    expect(out.type).toBe("object");
  });

  test("non-object top-level is rewritten to object", () => {
    const out = sanitizeMoonshotToolParameters({ type: "string" });
    expect(out.type).toBe("object");
  });

  test("infers type=array from items, type=integer from int enum sample", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        arr: { items: { type: "string" } },
        ints: { enum: [1, 2, 3] },
        flag: { enum: [true] },
        flt: { enum: [1.5] },
      },
    });
    const props = out.properties as Record<string, { type: string }>;
    expect(props.arr?.type).toBe("array");
    expect(props.ints?.type).toBe("integer");
    expect(props.flag?.type).toBe("boolean");
    expect(props.flt?.type).toBe("number");
  });

  test("anyOf with null branch collapses; non-null wins when single", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        nullable_str: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
    });
    const props = out.properties as Record<string, { type: string }>;
    expect(props.nullable_str?.type).toBe("string");
  });

  test("anyOf with multiple non-null branches keeps them and drops parent type", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        multi: {
          type: "ignored",
          anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }],
        },
      },
    });
    const props = out.properties as Record<string, { anyOf?: unknown[]; type?: string }>;
    expect(props.multi?.anyOf).toEqual([{ type: "string" }, { type: "integer" }]);
    expect(props.multi?.type).toBeUndefined();
  });

  test("anyOf collapse to single branch preserves sibling keys like description", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        nullable_str: {
          description: "carry-me",
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
    });
    const props = out.properties as Record<string, { description: string; type: string }>;
    expect(props.nullable_str?.description).toBe("carry-me");
    expect(props.nullable_str?.type).toBe("string");
  });

  test("anyOf with no non-null branches leaves only repaired children", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        weird: { anyOf: [{ type: "null" }] },
      },
    });
    // No non-null branch — drop the parent type but keep the anyOf list.
    const props = out.properties as Record<string, { anyOf?: unknown[]; type?: string }>;
    expect(props.weird?.anyOf).toEqual([{ type: "null" }]);
    expect(props.weird?.type).toBeUndefined();
  });

  test("strips nullable and cleans enum null/empty entries on scalar types", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        s: { type: "string", nullable: true, enum: ["a", "", null] },
        z: { type: "string", enum: [null, ""] },
      },
    });
    const props = out.properties as Record<string, { nullable?: boolean; enum?: unknown[] }>;
    expect(props.s?.nullable).toBeUndefined();
    expect(props.s?.enum).toEqual(["a"]);
    expect(props.z?.enum).toBeUndefined();
  });

  test("$ref node strips siblings", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        ref: { $ref: "#/$defs/Foo", description: "ignored" },
      },
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.ref).toEqual({ $ref: "#/$defs/Foo" });
  });

  test("$defs entries are recursed; items=tuple collapses to first element schema", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        tup: { type: "array", items: [{ description: "first" }, { description: "second" }] },
        empty_tup: { type: "array", items: [] },
        scalar_tup: { type: "array", items: ["not-a-record"] },
      },
      $defs: {
        Foo: { description: "no type" },
      },
    });
    const props = out.properties as Record<string, { items?: unknown }>;
    expect(props.tup?.items).toEqual({ type: "string", description: "first" });
    // Empty tuple `items` collapses to `{}` then _fillMissingType infers
    // string — matches upstream `test_empty_tuple_items_becomes_empty_schema`.
    expect(props.empty_tup?.items).toEqual({ type: "string" });
    expect(props.scalar_tup?.items).toBe("not-a-record");
    const defs = out.$defs as Record<string, { type: string }>;
    expect(defs.Foo?.type).toBe("string");
  });

  test("schema-node keys (items, additionalProperties) recurse for records and pass through bools", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        m: {
          type: "object",
          additionalProperties: { description: "inner" },
        },
        flat: { type: "object", additionalProperties: false },
      },
    });
    const props = out.properties as Record<string, { additionalProperties?: unknown }>;
    expect(props.m?.additionalProperties).toEqual({ type: "string", description: "inner" });
    expect(props.flat?.additionalProperties).toBe(false);
  });

  test("non-record top-level returned as canonical object schema even after repair", () => {
    // Force `_repair_schema` to return something non-record by passing a list at the top.
    expect(sanitizeMoonshotToolParameters([{ type: "string" }])).toEqual({
      type: "object",
      properties: {},
    });
  });

  test("nested array inside anyOf recurses through the array branch of _repairSchema", () => {
    // anyOf entries pass through `_repairSchema(v, true)`. When `v` is itself
    // an array (degenerate schema), the array-branch maps recursively (line
    // hit during `value.map`). The collapse logic then drops the array
    // branch because `isRecord([]) === false`.
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        weird: {
          anyOf: [[{ type: "string" }], { type: "integer" }],
        },
      },
    });
    // Collapse promotes the single non-null record branch — anyOf is gone.
    const props = out.properties as Record<string, { type?: string; anyOf?: unknown }>;
    expect(props.weird?.type).toBe("integer");
    expect(props.weird?.anyOf).toBeUndefined();
  });

  test("non-record array element survives at top of items recursion", () => {
    // `items: [x]` collapses to x; when x is not a record, it bypasses
    // _repairSchema and lands verbatim.
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { scalar: { type: "array", items: [3] } },
    });
    const props = out.properties as Record<string, { items: unknown }>;
    expect(props.scalar?.items).toBe(3);
  });

  test("non-record schema in _SCHEMA_NODE_KEYS (e.g. items=false) passes through unchanged", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { quirk: { type: "object", not: false } },
    });
    const props = out.properties as Record<string, { not: unknown }>;
    expect(props.quirk?.not).toBe(false);
  });

  test("enum with non-number, non-boolean primitive sample stays string", () => {
    // The string-sample fallback at the bottom of _fillMissingType.
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: { tag: { enum: ["only-string"] } },
    });
    const props = out.properties as Record<string, { type: string }>;
    expect(props.tag?.type).toBe("string");
  });

  test("preserves description/title scalars on schema nodes", () => {
    const out = sanitizeMoonshotToolParameters({
      type: "object",
      properties: {
        x: { type: "string", description: "kept", title: "X" },
      },
    });
    const props = out.properties as Record<string, { description: string; title: string }>;
    expect(props.x?.description).toBe("kept");
    expect(props.x?.title).toBe("X");
  });
});

describe("sanitizeMoonshotTools", () => {
  test("empty list is returned untouched", () => {
    const empty: Array<Record<string, unknown>> = [];
    expect(sanitizeMoonshotTools(empty)).toBe(empty);
  });

  test("non-record entries pass through unchanged", () => {
    const tools = [{ type: "function", function: { name: "ok", parameters: { type: "object" } } }];
    const result = sanitizeMoonshotTools(tools);
    expect(result[0]?.function).toBeDefined();
  });

  test("tools missing the `function` object pass through unchanged", () => {
    const tools = [{ type: "function" }];
    expect(sanitizeMoonshotTools(tools)).toBe(tools);
  });

  test("non-record entries in tools list pass through unchanged", () => {
    const tools = [
      "not-a-record" as unknown as Record<string, unknown>,
      { type: "function" }, // no `function` object
      {
        type: "function",
        function: {
          name: "search",
          parameters: { type: "object", properties: { q: { description: "query" } } },
        },
      },
    ];
    const out = sanitizeMoonshotTools(tools);
    expect(out[0]).toBe("not-a-record");
    // Item 1 has no `function` — passes through unchanged at the early continue.
    expect(out[1]).toBe(tools[1]);
  });

  test("tool with missing-type property gets repaired", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "search",
          description: "Search",
          parameters: { type: "object", properties: { q: { description: "query" } } },
        },
      },
    ];
    const out = sanitizeMoonshotTools(tools);
    expect(out).not.toBe(tools);
    const fn = out[0]?.function as { parameters: { properties: Record<string, { type: string }> } };
    expect(fn.parameters.properties.q?.type).toBe("string");
  });
});

describe("buildGeminiThinkingConfig", () => {
  test("non-gemini model returns null", () => {
    expect(buildGeminiThinkingConfig("gemma-4-31b-it", { effort: "high" })).toBeNull();
    expect(buildGeminiThinkingConfig("google/gemma-foo", { effort: "high" })).toBeNull();
  });

  test("null reasoningConfig returns null", () => {
    expect(buildGeminiThinkingConfig("gemini-3-flash-preview", null)).toBeNull();
    expect(buildGeminiThinkingConfig("gemini-3-flash-preview", undefined)).toBeNull();
  });

  test("enabled=false → includeThoughts:false", () => {
    expect(buildGeminiThinkingConfig("gemini-3-flash-preview", { enabled: false })).toEqual({
      includeThoughts: false,
    });
  });

  test("effort='none' → includeThoughts:false", () => {
    expect(buildGeminiThinkingConfig("gemini-3-flash-preview", { effort: "none" })).toEqual({
      includeThoughts: false,
    });
  });

  test("gemini-2.5 ignores thinking level", () => {
    expect(buildGeminiThinkingConfig("gemini-2.5-flash", { effort: "high" })).toEqual({
      includeThoughts: true,
    });
  });

  test("gemini-3 flash maps low/medium/high (and clamps minimal→low, xhigh→high)", () => {
    expect(
      buildGeminiThinkingConfig("gemini-3-flash-preview", { effort: "minimal" }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "low" });
    expect(
      buildGeminiThinkingConfig("gemini-3-flash-preview", { effort: "low" }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "low" });
    expect(
      buildGeminiThinkingConfig("gemini-3-flash-preview", { effort: "medium" }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "medium" });
    expect(
      buildGeminiThinkingConfig("gemini-3-flash-preview", { effort: "high" }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "high" });
    expect(
      buildGeminiThinkingConfig("gemini-3-flash-preview", { effort: "xhigh" }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "high" });
  });

  test("gemini-3.1 pro accepts only low / high", () => {
    expect(
      buildGeminiThinkingConfig("google/gemini-3.1-pro-preview", { effort: "medium" }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "low" });
    expect(
      buildGeminiThinkingConfig("google/gemini-3.1-pro-preview", { effort: "xhigh" }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "high" });
  });

  test("invalid effort string falls back to 'medium'", () => {
    expect(
      buildGeminiThinkingConfig("gemini-3-flash-preview", { effort: "wat" }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "medium" });
  });

  test("non-string effort silently falls back to 'medium'", () => {
    expect(
      buildGeminiThinkingConfig("gemini-3-flash-preview", { effort: 7 }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "medium" });
  });

  test("default effort (no value) is medium", () => {
    expect(buildGeminiThinkingConfig("gemini-3-flash-preview", { enabled: true })).toEqual({
      includeThoughts: true,
      thinkingLevel: "medium",
    });
  });

  test("null model defensively coalesces to empty string and returns null", () => {
    expect(
      buildGeminiThinkingConfig(null as unknown as string, { effort: "high" }),
    ).toBeNull();
  });

  test("gemini-3 model without flash/pro hint returns base includeThoughts only", () => {
    expect(
      buildGeminiThinkingConfig("gemini-3-foundation", { effort: "high" }),
    ).toEqual({ includeThoughts: true });
  });
});

describe("snakeCaseGeminiThinkingConfig", () => {
  test("null + empty inputs return null", () => {
    expect(snakeCaseGeminiThinkingConfig(null)).toBeNull();
    expect(snakeCaseGeminiThinkingConfig(undefined)).toBeNull();
    expect(snakeCaseGeminiThinkingConfig({})).toBeNull();
  });

  test("includeThoughts boolean translates", () => {
    expect(snakeCaseGeminiThinkingConfig({ includeThoughts: true })).toEqual({
      include_thoughts: true,
    });
    expect(snakeCaseGeminiThinkingConfig({ includeThoughts: false })).toEqual({
      include_thoughts: false,
    });
  });

  test("thinkingLevel + thinkingBudget translate", () => {
    expect(
      snakeCaseGeminiThinkingConfig({ thinkingLevel: "HIGH", thinkingBudget: 1024 }),
    ).toEqual({ thinking_level: "high", thinking_budget: 1024 });
  });

  test("blank thinkingLevel + non-finite budget dropped", () => {
    expect(
      snakeCaseGeminiThinkingConfig({
        thinkingLevel: "   ",
        thinkingBudget: Number.NaN,
        includeThoughts: true,
      }),
    ).toEqual({ include_thoughts: true });
  });

  test("returns null when no translatable keys present", () => {
    expect(snakeCaseGeminiThinkingConfig({ unknown: "x" })).toBeNull();
  });
});

describe("isGeminiOpenaiCompatBaseUrl", () => {
  test.each([
    ["https://generativelanguage.googleapis.com/v1beta/openai", true],
    ["https://generativelanguage.googleapis.com/v1beta/openai/", true],
    ["https://generativelanguage.googleapis.com/v1beta", false],
    ["https://api.openai.com/v1", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("isGeminiOpenaiCompatBaseUrl(%o) === %s", (url, expected) => {
    expect(isGeminiOpenaiCompatBaseUrl(url)).toBe(expected);
  });
});

// ── Transport tests ───────────────────────────────────────────────────

function makeTransport(): ChatCompletionsTransport {
  return new ChatCompletionsTransport();
}

describe("ChatCompletionsTransport — basic", () => {
  test("apiMode is 'chat_completions'", () => {
    expect(makeTransport().apiMode).toBe("chat_completions");
  });

  test("convertTools is identity (same reference)", () => {
    const t = makeTransport();
    const tools = [{ type: "function", function: { name: "test", parameters: {} } }];
    expect(t.convertTools(tools)).toBe(tools);
  });

  test("convertMessages is identity when no codex leak fields are present", () => {
    const t = makeTransport();
    const msgs = [{ role: "user", content: "hi" }];
    expect(t.convertMessages(msgs)).toBe(msgs);
  });

  test("convertMessages strips codex fields and tool_name; original untouched", () => {
    const t = makeTransport();
    const msgs = [
      {
        role: "assistant",
        content: "ok",
        codex_reasoning_items: [{ id: "rs_1" }],
        codex_message_items: [{ id: "msg_1", type: "message" }],
        tool_calls: [
          {
            id: "call_1",
            call_id: "call_1",
            response_item_id: "fc_1",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      },
    ];
    const out = t.convertMessages(msgs) as Array<Record<string, unknown>>;
    expect("codex_reasoning_items" in (out[0] as Record<string, unknown>)).toBe(false);
    expect("codex_message_items" in (out[0] as Record<string, unknown>)).toBe(false);
    const tc = (out[0] as { tool_calls: Array<Record<string, unknown>> }).tool_calls[0];
    expect(tc).toBeDefined();
    expect("call_id" in (tc as Record<string, unknown>)).toBe(false);
    expect("response_item_id" in (tc as Record<string, unknown>)).toBe(false);
    // Original list untouched.
    expect("codex_reasoning_items" in msgs[0]!).toBe(true);
  });

  test("convertMessages strips tool_name on tool-result messages", () => {
    const t = makeTransport();
    const msgs = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "execute_code", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", tool_name: "execute_code", content: "result" },
    ];
    const out = t.convertMessages(msgs) as Array<Record<string, unknown>>;
    expect("tool_name" in (out[2] as Record<string, unknown>)).toBe(false);
    expect((out[2] as { content: string }).content).toBe("result");
    // Original list untouched.
    expect((msgs[2] as { tool_name: string }).tool_name).toBe("execute_code");
  });

  test("convertMessages handles non-record entries without crashing", () => {
    const t = makeTransport();
    const msgs = [
      "not-a-record" as unknown as Record<string, unknown>,
      { role: "user", content: "hi", codex_reasoning_items: [] },
      null as unknown as Record<string, unknown>,
    ];
    const out = t.convertMessages(msgs) as Array<Record<string, unknown> | unknown>;
    expect(out[0]).toBe("not-a-record");
    expect("codex_reasoning_items" in (out[1] as Record<string, unknown>)).toBe(false);
  });

  test("convertMessages also strips when only tool_calls (not the message itself) carry codex keys", () => {
    const t = makeTransport();
    const msgs = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "x", type: "function", function: { name: "f", arguments: "{}" }, call_id: "c1" },
        ],
      },
    ];
    const out = t.convertMessages(msgs) as Array<Record<string, unknown>>;
    const tc = (out[0] as { tool_calls: Array<Record<string, unknown>> }).tool_calls[0];
    expect("call_id" in (tc as Record<string, unknown>)).toBe(false);
  });
});

describe("ChatCompletionsTransport.buildKwargs (legacy path)", () => {
  test("basic kwargs include model/messages/timeout", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("gpt-4o", [{ role: "user", content: "Hello" }], null, {
      timeout: 30,
    });
    expect(kw.model).toBe("gpt-4o");
    expect((kw.messages as Array<{ content: string }>)[0]?.content).toBe("Hello");
    expect(kw.timeout).toBe(30);
  });

  test("null model defensively coalesces to empty in legacy path (no developer swap)", () => {
    const t = makeTransport();
    const kw = t.buildKwargs(null as unknown as string, [{ role: "user", content: "Hi" }], null, {});
    expect(kw.model).toBeNull();
    expect((kw.messages as Array<{ role: string }>)[0]?.role).toBe("user");
  });

  test("developer-role swap fires for GPT-5 / codex model_lower hints", () => {
    const t = makeTransport();
    const kw = t.buildKwargs(
      "gpt-5.4",
      [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
      null,
      { model_lower: "gpt-5.4" },
    );
    expect((kw.messages as Array<{ role: string }>)[0]?.role).toBe("developer");

    const cdx = t.buildKwargs(
      "codex-mini",
      [
        { role: "system", content: "Hi" },
        { role: "user", content: "x" },
      ],
      null,
      { model_lower: "codex-mini" },
    );
    expect((cdx.messages as Array<{ role: string }>)[0]?.role).toBe("developer");
  });

  test("no developer swap for non-GPT-5 models", () => {
    const t = makeTransport();
    const kw = t.buildKwargs(
      "claude-sonnet-4",
      [{ role: "system", content: "x" }, { role: "user", content: "y" }],
      null,
      { model_lower: "claude-sonnet-4" },
    );
    expect((kw.messages as Array<{ role: string }>)[0]?.role).toBe("system");
  });

  test("model_lower defaults to lowercased model when omitted", () => {
    const t = makeTransport();
    const kw = t.buildKwargs(
      "GPT-5",
      [{ role: "system", content: "x" }, { role: "user", content: "y" }],
      null,
      {},
    );
    expect((kw.messages as Array<{ role: string }>)[0]?.role).toBe("developer");
  });

  test("tools pass through (legacy) and OpenRouter Pareto Code emits plugins block", () => {
    const t = makeTransport();
    const tools = [{ type: "function", function: { name: "test", parameters: {} } }];
    expect(t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], tools, {}).tools).toBe(
      tools,
    );

    const kw = t.buildKwargs(
      "openrouter/pareto-code",
      [{ role: "user", content: "Hi" }],
      null,
      { is_openrouter: true, openrouter_min_coding_score: 0.8 },
    );
    expect((kw.extra_body as { plugins: unknown[] }).plugins).toEqual([
      { id: "pareto-router", min_coding_score: 0.8 },
    ]);
  });

  test("Pareto score: out-of-range, non-numeric, and empty string drop the plugin block", () => {
    const t = makeTransport();
    for (const bad of [1.5, -0.1, "not-a-number", ""]) {
      const kw = t.buildKwargs(
        "openrouter/pareto-code",
        [{ role: "user", content: "Hi" }],
        null,
        {
          is_openrouter: true,
          openrouter_min_coding_score: bad as number | string,
        },
      );
      expect((kw.extra_body as undefined | { plugins?: unknown })?.plugins).toBeUndefined();
    }
  });

  test("Pareto score on non-pareto model is not emitted", () => {
    const t = makeTransport();
    const kw = t.buildKwargs(
      "anthropic/claude-sonnet-4.6",
      [{ role: "user", content: "Hi" }],
      null,
      { is_openrouter: true, openrouter_min_coding_score: 0.65 },
    );
    expect((kw.extra_body as undefined | { plugins?: unknown })?.plugins).toBeUndefined();
  });

  test("Pareto score numeric coerces from string", () => {
    const t = makeTransport();
    const kw = t.buildKwargs(
      "openrouter/pareto-code",
      [{ role: "user", content: "Hi" }],
      null,
      {
        is_openrouter: true,
        openrouter_min_coding_score: "0.5",
      },
    );
    expect((kw.extra_body as { plugins: Array<{ min_coding_score: number }> }).plugins[0]?.min_coding_score).toBe(0.5);
  });

  test("OpenRouter provider_preferences sets extra_body.provider", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
      is_openrouter: true,
      provider_preferences: { only: ["openai"] },
    });
    expect((kw.extra_body as { provider: unknown }).provider).toEqual({ only: ["openai"] });
  });

  test("provider_preferences without is_openrouter is not emitted", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
      provider_preferences: { only: ["openai"] },
    });
    expect((kw.extra_body as undefined | { provider?: unknown })?.provider).toBeUndefined();
  });

  test("Kimi: thinking + reasoning_effort = medium top-level + extra_body.thinking enabled", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("kimi-k2", [{ role: "user", content: "Hi" }], null, {
      is_kimi: true,
    });
    expect(kw.reasoning_effort).toBe("medium");
    expect((kw.extra_body as { thinking: { type: string } }).thinking).toEqual({
      type: "enabled",
    });
  });

  test("Kimi: enabled=false suppresses reasoning_effort and sets extra_body.thinking=disabled", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("kimi-k2", [{ role: "user", content: "Hi" }], null, {
      is_kimi: true,
      reasoning_config: { enabled: false },
    });
    expect(kw.reasoning_effort).toBeUndefined();
    expect((kw.extra_body as { thinking: { type: string } }).thinking).toEqual({
      type: "disabled",
    });
  });

  test("Kimi: invalid effort string falls back to medium", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("kimi-k2", [{ role: "user", content: "Hi" }], null, {
      is_kimi: true,
      reasoning_config: { effort: "wat" },
    });
    expect(kw.reasoning_effort).toBe("medium");
  });

  test("Kimi: non-string effort falls back to medium", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("kimi-k2", [{ role: "user", content: "Hi" }], null, {
      is_kimi: true,
      reasoning_config: { effort: 7 },
    });
    expect(kw.reasoning_effort).toBe("medium");
  });

  test("TokenHub: non-string effort falls back to default 'high'", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
      is_tokenhub: true,
      reasoning_config: { effort: null },
    });
    expect(kw.reasoning_effort).toBe("high");
  });

  test("Kimi: valid effort uppercase trims + lowercases", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("kimi-k2", [{ role: "user", content: "Hi" }], null, {
      is_kimi: true,
      reasoning_config: { effort: " HIGH " },
    });
    expect(kw.reasoning_effort).toBe("high");
  });

  test("Tencent TokenHub: default reasoning_effort=high + valid override", () => {
    const t = makeTransport();
    expect(
      t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
        is_tokenhub: true,
      }).reasoning_effort,
    ).toBe("high");

    expect(
      t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
        is_tokenhub: true,
        reasoning_config: { enabled: false },
      }).reasoning_effort,
    ).toBeUndefined();

    expect(
      t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
        is_tokenhub: true,
        reasoning_config: { effort: "low" },
      }).reasoning_effort,
    ).toBe("low");
  });

  test("LM Studio: emits reasoning_effort only when supports_reasoning + effort allowed", () => {
    const t = makeTransport();
    const ok = t.buildKwargs("gpt-oss", [{ role: "user", content: "Hi" }], null, {
      is_lmstudio: true,
      supports_reasoning: true,
      reasoning_config: { effort: "high" },
      lmstudio_reasoning_options: ["off", "low", "medium", "high"],
    });
    expect(ok.reasoning_effort).toBe("high");

    const denied = t.buildKwargs("gpt-oss", [{ role: "user", content: "Hi" }], null, {
      is_lmstudio: true,
      supports_reasoning: true,
      reasoning_config: { effort: "high" },
      lmstudio_reasoning_options: ["off", "on"],
    });
    expect(denied.reasoning_effort).toBeUndefined();
  });

  test("LM Studio: disabled stays 'none' when off is allowed; no allowed_options falls back to legacy", () => {
    const t = makeTransport();
    expect(
      t.buildKwargs("gpt-oss", [{ role: "user", content: "Hi" }], null, {
        is_lmstudio: true,
        supports_reasoning: true,
        reasoning_config: { enabled: false },
        lmstudio_reasoning_options: ["off", "on"],
      }).reasoning_effort,
    ).toBe("none");

    expect(
      t.buildKwargs("gpt-oss", [{ role: "user", content: "Hi" }], null, {
        is_lmstudio: true,
        supports_reasoning: true,
        reasoning_config: { effort: "high" },
        lmstudio_reasoning_options: null,
      }).reasoning_effort,
    ).toBe("high");
  });

  test("supports_reasoning (non-LMStudio) emits extra_body.reasoning {enabled:true, effort:medium}", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
      supports_reasoning: true,
    });
    expect((kw.extra_body as { reasoning: { enabled: boolean; effort: string } }).reasoning).toEqual(
      { enabled: true, effort: "medium" },
    );
  });

  test("GitHub Models: github_reasoning_extra → extra_body.reasoning", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
      is_github_models: true,
      supports_reasoning: true,
      github_reasoning_extra: { foo: "bar" },
    });
    expect((kw.extra_body as { reasoning: Record<string, unknown> }).reasoning).toEqual({
      foo: "bar",
    });
  });

  test("GitHub Models without extras and supports_reasoning emits no reasoning extra_body", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
      is_github_models: true,
      supports_reasoning: true,
    });
    expect((kw.extra_body as undefined | Record<string, unknown>)?.reasoning).toBeUndefined();
  });

  test("Gemini provider native flash maps to top-level thinking_config", () => {
    const t = makeTransport();
    const kw = t.buildKwargs(
      "gemini-3-flash-preview",
      [{ role: "user", content: "Hi" }],
      null,
      {
        provider_name: "gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta",
        reasoning_config: { enabled: true, effort: "high" },
      },
    );
    expect((kw.extra_body as { thinking_config: unknown }).thinking_config).toEqual({
      includeThoughts: true,
      thinkingLevel: "high",
    });
  });

  test("Gemini provider OpenAI-compat base url nests under extra_body.extra_body.google", () => {
    const t = makeTransport();
    const kw = t.buildKwargs(
      "gemini-3-flash-preview",
      [{ role: "user", content: "Hi" }],
      null,
      {
        provider_name: "gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        reasoning_config: { enabled: true, effort: "high" },
      },
    );
    const eb = kw.extra_body as { extra_body?: { google?: { thinking_config?: unknown } } };
    expect(eb.extra_body?.google?.thinking_config).toEqual({
      include_thoughts: true,
      thinking_level: "high",
    });
  });

  test("Gemini OpenAI-compat with no thinking config (gemma) emits nothing", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("gemma-4-31b-it", [{ role: "user", content: "Hi" }], null, {
      provider_name: "gemini",
      base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
      reasoning_config: { enabled: true, effort: "high" },
    });
    expect((kw.extra_body as undefined | Record<string, unknown>)?.extra_body).toBeUndefined();
  });

  test("Gemini provider with no reasoning_config leaves extra_body untouched", () => {
    const t = makeTransport();
    const kw = t.buildKwargs(
      "gemini-3-flash-preview",
      [{ role: "user", content: "Hi" }],
      null,
      { provider_name: "gemini", base_url: "https://generativelanguage.googleapis.com/v1beta" },
    );
    expect(kw.extra_body).toBeUndefined();
  });

  test("google-gemini-cli provider keeps top-level thinking_config", () => {
    const t = makeTransport();
    const kw = t.buildKwargs(
      "gemini-3-flash-preview",
      [{ role: "user", content: "Hi" }],
      null,
      {
        provider_name: "google-gemini-cli",
        reasoning_config: { enabled: true, effort: "high" },
      },
    );
    const eb = kw.extra_body as { thinking_config: unknown; google?: unknown };
    expect(eb.thinking_config).toEqual({ includeThoughts: true, thinkingLevel: "high" });
    expect(eb.google).toBeUndefined();
  });

  test("google-gemini-cli with thinking-config=null emits no extra_body", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("gemma-foo", [{ role: "user", content: "Hi" }], null, {
      provider_name: "google-gemini-cli",
      reasoning_config: { enabled: true, effort: "high" },
    });
    expect(kw.extra_body).toBeUndefined();
  });

  test("max_tokens with fn vs ephemeral priority vs anthropic_max_output fallback", () => {
    const t = makeTransport();
    const fn = (n: number) => ({ max_tokens: n });

    expect(
      t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
        max_tokens: 4096,
        max_tokens_param_fn: fn,
      }).max_tokens,
    ).toBe(4096);

    expect(
      t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
        max_tokens: 4096,
        ephemeral_max_output_tokens: 2048,
        max_tokens_param_fn: fn,
      }).max_tokens,
    ).toBe(2048);

    // anthropic-out only used when no fn or no max
    expect(
      t.buildKwargs("anthropic/claude-sonnet-4.6", [{ role: "user", content: "Hi" }], null, {
        is_openrouter: true,
        anthropic_max_output: 64000,
      }).max_tokens,
    ).toBe(64000);
  });

  test("request_overrides apply last (e.g. service_tier)", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
      request_overrides: { service_tier: "priority" },
    });
    expect(kw.service_tier).toBe("priority");
  });

  test("extra_body_additions merge into final extra_body", () => {
    const t = makeTransport();
    const kw = t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
      extra_body_additions: { custom_extra: 1 },
    });
    expect((kw.extra_body as { custom_extra: number }).custom_extra).toBe(1);
  });

  test("kimi tool sanitization fires inside legacy path via model name", () => {
    const t = makeTransport();
    const tools = [
      {
        type: "function",
        function: {
          name: "search",
          parameters: { type: "object", properties: { q: { description: "query" } } },
        },
      },
    ];
    const kw = t.buildKwargs(
      "moonshotai/kimi-k2.6",
      [{ role: "user", content: "Hi" }],
      tools,
      { max_tokens_param_fn: (n) => ({ max_tokens: n }) },
    );
    const fn = (kw.tools as Array<{ function: { parameters: { properties: Record<string, { type: string }> } } }>)[0]?.function;
    expect(fn?.parameters.properties.q?.type).toBe("string");
  });
});

describe("ChatCompletionsTransport.buildKwargs (profile path)", () => {
  test("profile.prepareMessages is called; developer-role swap still applies", () => {
    const profile = new FakeProvider();
    const t = makeTransport();
    const kw = t.buildKwargs(
      "gpt-5.4",
      [{ role: "system", content: "Hi" }, { role: "user", content: "x" }],
      null,
      { provider_profile: profile },
    );
    expect(profile.prepareMessagesCalls.length).toBe(1);
    expect((kw.messages as Array<{ role: string }>)[0]?.role).toBe("developer");
  });

  test("fixedTemperature numeric sets temperature; OMIT_TEMPERATURE drops it", () => {
    const t = makeTransport();
    const fixed = new FakeProvider({ fixedTemperature: 0.6 });
    const kw = t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
      provider_profile: fixed,
    });
    expect(kw.temperature).toBe(0.6);

    const omit = new FakeProvider({ fixedTemperature: OMIT_TEMPERATURE });
    const kw2 = t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
      provider_profile: omit,
    });
    expect("temperature" in kw2).toBe(false);
  });

  test("no fixedTemperature falls back to params.temperature, else omitted", () => {
    const t = makeTransport();
    const none = new FakeProvider({ fixedTemperature: null });
    expect(
      t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
        provider_profile: none,
        temperature: 0.2,
      }).temperature,
    ).toBe(0.2);
    expect(
      "temperature" in
        t.buildKwargs("gpt-4o", [{ role: "user", content: "Hi" }], null, {
          provider_profile: none,
        }),
    ).toBe(false);
  });

  test("max_tokens priority on profile path: ephemeral > user > profile default > anthropic_max_output", () => {
    const t = makeTransport();
    const profile = new FakeProvider({ defaultMaxTokens: 65536 });
    const fn = (n: number) => ({ max_tokens: n });

    expect(
      t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
        provider_profile: profile,
        max_tokens_param_fn: fn,
        ephemeral_max_output_tokens: 2048,
      }).max_tokens,
    ).toBe(2048);

    expect(
      t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
        provider_profile: profile,
        max_tokens_param_fn: fn,
        max_tokens: 1024,
      }).max_tokens,
    ).toBe(1024);

    expect(
      t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
        provider_profile: profile,
        max_tokens_param_fn: fn,
      }).max_tokens,
    ).toBe(65536);

    const noDefault = new FakeProvider({ defaultMaxTokens: null });
    expect(
      t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
        provider_profile: noDefault,
        anthropic_max_output: 4096,
      }).max_tokens,
    ).toBe(4096);
  });

  test("profile.buildExtraBody + buildApiKwargsExtras are merged; additions and overrides apply last", () => {
    const t = makeTransport();
    const profile = new FakeProvider({
      extraBody: { tags: ["base"] },
      apiKwargsExtras: [{ reasoning: { effort: "high" } }, { reasoning_effort: "high" }],
    });
    const kw = t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
      provider_profile: profile,
      extra_body_additions: { extra_top: 1 },
      request_overrides: { service_tier: "priority", extra_body: { final: true } },
    });
    expect(kw.service_tier).toBe("priority");
    expect(kw.reasoning_effort).toBe("high");
    const eb = kw.extra_body as Record<string, unknown>;
    expect(eb.tags).toEqual(["base"]);
    expect(eb.reasoning).toEqual({ effort: "high" });
    expect(eb.extra_top).toBe(1);
    expect(eb.final).toBe(true);
  });

  test("profile path also applies Moonshot tool sanitization by model name", () => {
    const t = makeTransport();
    const profile = new FakeProvider();
    const tools = [
      {
        type: "function",
        function: {
          name: "search",
          parameters: { type: "object", properties: { q: { description: "query" } } },
        },
      },
    ];
    const kw = t.buildKwargs(
      "moonshotai/kimi-k2.6",
      [{ role: "user", content: "Hi" }],
      tools,
      { provider_profile: profile },
    );
    const fn = (kw.tools as Array<{ function: { parameters: { properties: Record<string, { type: string }> } } }>)[0]?.function;
    expect(fn?.parameters.properties.q?.type).toBe("string");
  });

  test("profile path: timeout, extra_body_additions, and request_overrides all coexist", () => {
    const t = makeTransport();
    const profile = new FakeProvider({ extraBody: {} });
    const kw = t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
      provider_profile: profile,
      timeout: 60,
      request_overrides: { extra_body: { only_in_overrides: true }, top_key: 1 },
    });
    expect(kw.timeout).toBe(60);
    expect(kw.top_key).toBe(1);
    expect((kw.extra_body as { only_in_overrides: boolean }).only_in_overrides).toBe(true);
  });

  test("profile path: empty profileBody and empty extras keep extra_body absent", () => {
    const t = makeTransport();
    const profile = new FakeProvider();
    const kw = t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
      provider_profile: profile,
    });
    expect("extra_body" in kw).toBe(false);
  });

  test("profile path: defaultMaxTokens=0 falls through and uses anthropic_max_output", () => {
    const t = makeTransport();
    const profile = new FakeProvider({ defaultMaxTokens: 0 });
    const kw = t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
      provider_profile: profile,
      max_tokens_param_fn: (n) => ({ max_tokens: n }),
      anthropic_max_output: 2048,
    });
    expect(kw.max_tokens).toBe(2048);
  });

  test("profile path: null model coalesces to empty for the developer-swap check", () => {
    const t = makeTransport();
    const profile = new FakeProvider();
    const kw = t.buildKwargs(null as unknown as string, [{ role: "user", content: "Hi" }], null, {
      provider_profile: profile,
    });
    expect(kw.model).toBeNull();
    expect((kw.messages as Array<{ role: string }>)[0]?.role).toBe("user");
  });

  test("profile path: messages list without system role doesn't trigger developer swap", () => {
    const t = makeTransport();
    const profile = new FakeProvider();
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], null, {
      provider_profile: profile,
    });
    expect((kw.messages as Array<{ role: string }>)[0]?.role).toBe("user");
  });
});

describe("ChatCompletionsTransport.normalizeResponse", () => {
  test("tool_call with no id falls back to null", () => {
    const t = makeTransport();
    const r = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { function: { name: "noid", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const nr = t.normalizeResponse(r);
    expect(nr.tool_calls?.[0]?.id).toBeNull();
  });

  test("usage with missing fields defaults to zero on NormalizedResponse.Usage", () => {
    const t = makeTransport();
    const nr = t.normalizeResponse({
      choices: [{ message: { content: "x" }, finish_reason: "stop" }],
      usage: {},
    });
    expect(nr.usage?.prompt_tokens).toBe(0);
    expect(nr.usage?.completion_tokens).toBe(0);
    expect(nr.usage?.total_tokens).toBe(0);
  });

  test("cache stats: details with missing fields default to zero, returns null", () => {
    const t = makeTransport();
    expect(t.extractCacheStats({ usage: { prompt_tokens_details: {} } })).toBeNull();
  });

  test("model_extra.extra_content present but key missing → tcProviderData stays empty", () => {
    const t = makeTransport();
    const nr = t.normalizeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "x",
                function: { name: "f", arguments: "{}" },
                model_extra: { unrelated: 7 },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(nr.tool_calls?.[0]?.providerData).toBeNull();
  });

  test("text response surfaces content + usage + finish_reason", () => {
    const t = makeTransport();
    const r = {
      choices: [
        {
          message: { content: "Hello", tool_calls: null, reasoning_content: null },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const nr = t.normalizeResponse(r);
    expect(nr).toBeInstanceOf(NormalizedResponse);
    expect(nr.content).toBe("Hello");
    expect(nr.finish_reason).toBe("stop");
    expect(nr.tool_calls).toBeNull();
    expect(nr.usage?.total_tokens).toBe(15);
  });

  test("tool_calls populate ToolCall list with id + name + arguments", () => {
    const t = makeTransport();
    const r = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_123",
                function: { name: "terminal", arguments: '{"command": "ls"}' },
              },
            ],
            reasoning_content: null,
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: null,
    };
    const nr = t.normalizeResponse(r);
    expect(nr.tool_calls?.length).toBe(1);
    expect(nr.tool_calls?.[0]?.id).toBe("call_123");
    expect(nr.tool_calls?.[0]?.name).toBe("terminal");
  });

  test("extra_content on tool_call surfaces via providerData", () => {
    const t = makeTransport();
    const nr = t.normalizeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_gem",
                function: { name: "terminal", arguments: '{"command": "ls"}' },
                extra_content: { google: { thought_signature: "SIG_ABC123" } },
              },
            ],
            reasoning_content: null,
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: null,
    });
    expect(nr.tool_calls?.[0]?.providerData).toEqual({
      extra_content: { google: { thought_signature: "SIG_ABC123" } },
    });
  });

  test("tool_call extra_content falls back to model_extra.extra_content", () => {
    const t = makeTransport();
    const nr = t.normalizeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_gem",
                function: { name: "terminal", arguments: "{}" },
                model_extra: { extra_content: { google: { thought_signature: "Y" } } },
              },
            ],
            reasoning_content: null,
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: null,
    });
    expect(nr.tool_calls?.[0]?.providerData?.extra_content).toEqual({
      google: { thought_signature: "Y" },
    });
  });

  test("tool_call extra_content with model_dump() is invoked when present", () => {
    const t = makeTransport();
    const nr = t.normalizeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "x",
                function: { name: "f", arguments: "{}" },
                extra_content: { model_dump: () => ({ dumped: true }) },
              },
            ],
            reasoning_content: null,
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(nr.tool_calls?.[0]?.providerData?.extra_content).toEqual({ dumped: true });
  });

  test("tool_call extra_content model_dump() that throws keeps the original value", () => {
    const t = makeTransport();
    const original = {
      model_dump: () => {
        throw new Error("nope");
      },
      keep: "me",
    };
    const nr = t.normalizeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "x", function: { name: "f", arguments: "{}" }, extra_content: original },
            ],
            reasoning_content: null,
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(nr.tool_calls?.[0]?.providerData?.extra_content).toBe(original);
  });

  test("reasoning_content (DeepSeek) preserved separately from reasoning", () => {
    const t = makeTransport();
    const nr = t.normalizeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: null,
            reasoning: "summary text",
            reasoning_content: "detailed scratchpad",
          },
          finish_reason: "stop",
        },
      ],
      usage: null,
    });
    expect(nr.reasoning).toBe("summary text");
    expect(nr.providerData).toEqual({ reasoning_content: "detailed scratchpad" });
  });

  test("empty reasoning_content preserved (DeepSeek replay)", () => {
    const t = makeTransport();
    const nr = t.normalizeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: null,
            reasoning: null,
            reasoning_content: "",
          },
          finish_reason: "stop",
        },
      ],
      usage: null,
    });
    expect(nr.providerData).toEqual({ reasoning_content: "" });
    expect(nr.reasoning_content).toBe("");
  });

  test("reasoning_content from model_extra surfaces when message.reasoning_content is null", () => {
    const t = makeTransport();
    const nr = t.normalizeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: null,
            reasoning: null,
            model_extra: { reasoning_content: "model-extra scratchpad" },
          },
          finish_reason: "stop",
        },
      ],
      usage: null,
    });
    expect(nr.providerData).toEqual({ reasoning_content: "model-extra scratchpad" });
  });

  test("reasoning_details survive in providerData", () => {
    const t = makeTransport();
    const details = [{ type: "thinking", text: "hmm" }];
    const nr = t.normalizeResponse({
      choices: [
        {
          message: {
            content: "x",
            tool_calls: null,
            reasoning_content: null,
            reasoning_details: details,
          },
          finish_reason: "stop",
        },
      ],
      usage: null,
    });
    expect(nr.providerData?.reasoning_details).toEqual(details);
  });

  test("empty reasoning_details array is dropped", () => {
    const t = makeTransport();
    const nr = t.normalizeResponse({
      choices: [
        {
          message: {
            content: "x",
            tool_calls: null,
            reasoning_content: null,
            reasoning_details: [],
          },
          finish_reason: "stop",
        },
      ],
      usage: null,
    });
    expect(nr.providerData).toBeNull();
  });

  test("missing finish_reason defaults to 'stop'", () => {
    const t = makeTransport();
    const nr = t.normalizeResponse({
      choices: [{ message: { content: "x" } }],
    });
    expect(nr.finish_reason).toBe("stop");
  });

  test("throws when first choice is missing entirely", () => {
    const t = makeTransport();
    expect(() => t.normalizeResponse({ choices: [] })).toThrow(/missing choice/);
  });

  test("throws when first choice has no message", () => {
    const t = makeTransport();
    expect(() => t.normalizeResponse({ choices: [{ finish_reason: "stop" }] })).toThrow(/missing message/);
  });

  test("throws when a tool_call is missing its function field", () => {
    const t = makeTransport();
    expect(() =>
      t.normalizeResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "x" }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ).toThrow(/missing function/);
  });
});

describe("ChatCompletionsTransport.validateResponse", () => {
  const t = makeTransport();
  test.each([
    [null, false],
    [undefined, false],
    ["str", false],
    [{ choices: null }, false],
    [{ choices: [] }, false],
    [{}, false],
    [{ choices: [{ message: { content: "hi" } }] }, true],
  ])("validateResponse(%j) === %s", (input, expected) => {
    expect(t.validateResponse(input)).toBe(expected);
  });
});

describe("ChatCompletionsTransport.extractCacheStats", () => {
  const t = makeTransport();
  test("null + missing usage + null details all return null", () => {
    expect(t.extractCacheStats(null)).toBeNull();
    expect(t.extractCacheStats({ usage: null })).toBeNull();
    expect(t.extractCacheStats({ usage: {} })).toBeNull();
    expect(t.extractCacheStats({ usage: { prompt_tokens_details: null } })).toBeNull();
  });

  test("non-record details return null", () => {
    expect(t.extractCacheStats({ usage: { prompt_tokens_details: "weird" } })).toBeNull();
  });

  test("non-record usage returns null", () => {
    expect(t.extractCacheStats({ usage: "weird" })).toBeNull();
  });

  test("populated details map to canonical shape", () => {
    expect(
      t.extractCacheStats({
        usage: { prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 100 } },
      }),
    ).toEqual({ cached_tokens: 500, creation_tokens: 100 });
  });

  test("zero-only details return null", () => {
    expect(
      t.extractCacheStats({
        usage: { prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
      }),
    ).toBeNull();
  });
});

describe("auto-registration + registerChatCompletionsTransport", () => {
  test("DEVELOPER_ROLE_MODELS constant is the expected tuple", () => {
    expect(DEVELOPER_ROLE_MODELS).toEqual(["gpt-5", "codex"]);
  });

  test("an explicit register call via registry succeeds", async () => {
    const { registerChatCompletionsTransport } = await import(
      "../../src/transports/chat_completions.js"
    );
    // Reset and re-register; this exercises the function in addition to
    // the import-time side effect that ran when the module first loaded.
    _resetTransportRegistryForTesting();
    expect(getTransport("chat_completions")).toBeNull();
    registerChatCompletionsTransport();
    expect(getTransport("chat_completions")?.apiMode).toBe("chat_completions");
  });

  test("registry retains a separately-registered chat_completions factory", () => {
    registerTransport(
      "chat_completions",
      () => new (class extends ChatCompletionsTransport {})(),
    );
    expect(getTransport("chat_completions")?.apiMode).toBe("chat_completions");
  });
});
