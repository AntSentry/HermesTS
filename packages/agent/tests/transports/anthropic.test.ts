/**
 * Tests for `@hermests/agent/transports/anthropic`.
 *
 * Ported from upstream `tests/agent/transports/test_transport.py`
 * (`TestAnthropicTransport` class). The adapter sits in sub-task #5h,
 * so we inject a stub adapter that returns predictable shapes — the
 * transport's job is to wire the adapter's outputs into the transport
 * contract, and that wiring is what we test here.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ANTHROPIC_STOP_REASON_MAP,
  AnthropicTransport,
  type AnthropicAdapter,
  registerAnthropicTransport,
} from "../../src/transports/anthropic.js";
import {
  _resetTransportRegistryForTesting,
  getTransport,
} from "../../src/transports/registry.js";
import { NormalizedResponse } from "../../src/transports/types.js";

function stubAdapter(overrides: Partial<AnthropicAdapter> = {}): AnthropicAdapter {
  return {
    convertMessagesToAnthropic: vi.fn(
      (messages: Array<Record<string, unknown>>) => [null, messages],
    ),
    convertToolsToAnthropic: vi.fn((tools: Array<Record<string, unknown>>) =>
      tools.map((t) => ({
        name: (t.function as { name?: string } | undefined)?.name ?? "",
        input_schema: (t.function as { parameters?: unknown } | undefined)?.parameters ?? {},
      })),
    ),
    buildAnthropicKwargs: vi.fn((args) => ({
      model: args.model,
      messages: args.messages,
      max_tokens: args.max_tokens,
    })),
    toPlainData: vi.fn((v) => v),
    ...overrides,
  };
}

beforeEach(() => {
  _resetTransportRegistryForTesting();
});

afterEach(() => {
  _resetTransportRegistryForTesting();
});

describe("AnthropicTransport", () => {
  test("apiMode is 'anthropic_messages'", () => {
    const t = new AnthropicTransport(stubAdapter());
    expect(t.apiMode).toBe("anthropic_messages");
  });

  test("convertMessages forwards base_url option to the adapter", () => {
    const adapter = stubAdapter();
    const t = new AnthropicTransport(adapter);
    t.convertMessages([{ role: "user", content: "hi" }], { base_url: "https://x" });
    expect(adapter.convertMessagesToAnthropic).toHaveBeenCalledWith(
      [{ role: "user", content: "hi" }],
      { baseUrl: "https://x" },
    );
  });

  test("convertMessages defaults base_url to null when omitted", () => {
    const adapter = stubAdapter();
    const t = new AnthropicTransport(adapter);
    t.convertMessages([{ role: "user", content: "hi" }]);
    expect(adapter.convertMessagesToAnthropic).toHaveBeenCalledWith(
      [{ role: "user", content: "hi" }],
      { baseUrl: null },
    );
  });

  test("convertTools forwards to the adapter", () => {
    const adapter = stubAdapter();
    const t = new AnthropicTransport(adapter);
    const tools = [
      {
        type: "function",
        function: {
          name: "test_tool",
          description: "A test",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const out = t.convertTools(tools) as Array<Record<string, unknown>>;
    expect(out.length).toBe(1);
    expect(out[0]?.name).toBe("test_tool");
    expect(out[0]?.input_schema).toEqual({ type: "object", properties: {} });
  });

  test("buildKwargs delegates to adapter with the documented defaults", () => {
    const adapter = stubAdapter();
    const t = new AnthropicTransport(adapter);
    const kw = t.buildKwargs("claude-sonnet-4-6", [{ role: "user", content: "Hi" }], null, {});
    expect(kw.model).toBe("claude-sonnet-4-6");
    expect(kw.max_tokens).toBe(16384);

    const args = (adapter.buildAnthropicKwargs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(args?.is_oauth).toBe(false);
    expect(args?.preserve_dots).toBe(false);
    expect(args?.fast_mode).toBe(false);
    expect(args?.drop_context_1m_beta).toBe(false);
    expect(args?.tool_choice).toBeNull();
    expect(args?.reasoning_config).toBeNull();
    expect(args?.context_length).toBeNull();
    expect(args?.base_url).toBeNull();
  });

  test("buildKwargs honours overrides for max_tokens and reasoning_config", () => {
    const adapter = stubAdapter();
    const t = new AnthropicTransport(adapter);
    t.buildKwargs("claude-sonnet-4-6", [{ role: "user", content: "Hi" }], null, {
      max_tokens: 8000,
      reasoning_config: { effort: "high" },
      tool_choice: "auto",
      is_oauth: true,
      preserve_dots: true,
      context_length: 200000,
      base_url: "https://api.anthropic.com",
      fast_mode: true,
      drop_context_1m_beta: true,
    });
    const args = (adapter.buildAnthropicKwargs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(args?.max_tokens).toBe(8000);
    expect(args?.reasoning_config).toEqual({ effort: "high" });
    expect(args?.tool_choice).toBe("auto");
    expect(args?.is_oauth).toBe(true);
    expect(args?.preserve_dots).toBe(true);
    expect(args?.context_length).toBe(200000);
    expect(args?.base_url).toBe("https://api.anthropic.com");
    expect(args?.fast_mode).toBe(true);
    expect(args?.drop_context_1m_beta).toBe(true);
  });

  test("validateResponse rejects null, non-array content, and tool_use with empty content", () => {
    const t = new AnthropicTransport(stubAdapter());
    expect(t.validateResponse(null)).toBe(false);
    expect(t.validateResponse({ content: "not-an-array" })).toBe(false);
    expect(t.validateResponse({ content: [], stop_reason: "tool_use" })).toBe(false);
  });

  test("validateResponse accepts empty content with end_turn (canonical 'nothing to add')", () => {
    const t = new AnthropicTransport(stubAdapter());
    expect(t.validateResponse({ content: [], stop_reason: "end_turn" })).toBe(true);
  });

  test("validateResponse accepts non-empty content", () => {
    const t = new AnthropicTransport(stubAdapter());
    expect(t.validateResponse({ content: [{ type: "text", text: "hi" }] })).toBe(true);
  });

  test("mapFinishReason returns canonical mapping with 'stop' fallback", () => {
    const t = new AnthropicTransport(stubAdapter());
    expect(t.mapFinishReason("end_turn")).toBe("stop");
    expect(t.mapFinishReason("tool_use")).toBe("tool_calls");
    expect(t.mapFinishReason("max_tokens")).toBe("length");
    expect(t.mapFinishReason("stop_sequence")).toBe("stop");
    expect(t.mapFinishReason("refusal")).toBe("content_filter");
    expect(t.mapFinishReason("model_context_window_exceeded")).toBe("length");
    expect(t.mapFinishReason("unknown")).toBe("stop");
    // Constant export matches the live mapping.
    expect(ANTHROPIC_STOP_REASON_MAP.end_turn).toBe("stop");
  });

  test("extractCacheStats handles null usage, zero counts, and positive counts", () => {
    const t = new AnthropicTransport(stubAdapter());
    expect(t.extractCacheStats(null)).toBeNull();
    expect(t.extractCacheStats({ usage: null })).toBeNull();
    expect(
      t.extractCacheStats({
        usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    ).toBeNull();
    expect(
      t.extractCacheStats({
        usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
      }),
    ).toEqual({ cached_tokens: 100, creation_tokens: 50 });
  });

  test("extractCacheStats returns null when usage is undefined or missing fields", () => {
    const t = new AnthropicTransport(stubAdapter());
    // No usage field at all.
    expect(t.extractCacheStats({})).toBeNull();
    // Usage with both missing — defaults to zero, returns null.
    expect(t.extractCacheStats({ usage: {} })).toBeNull();
    // Only cache_read populated.
    expect(
      t.extractCacheStats({ usage: { cache_read_input_tokens: 5 } }),
    ).toEqual({ cached_tokens: 5, creation_tokens: 0 });
    // Only cache_creation populated.
    expect(
      t.extractCacheStats({ usage: { cache_creation_input_tokens: 7 } }),
    ).toEqual({ cached_tokens: 0, creation_tokens: 7 });
  });
});

describe("AnthropicTransport.normalizeResponse", () => {
  test("text block surfaces as content with finish_reason='stop'", () => {
    const t = new AnthropicTransport(stubAdapter());
    const r = {
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
    };
    const nr = t.normalizeResponse(r);
    expect(nr).toBeInstanceOf(NormalizedResponse);
    expect(nr.content).toBe("Hello world");
    expect(nr.tool_calls).toBeNull();
    expect(nr.finish_reason).toBe("stop");
    expect(nr.reasoning).toBeNull();
    expect(nr.providerData).toBeNull();
  });

  test("multiple text blocks join with newline", () => {
    const t = new AnthropicTransport(stubAdapter());
    const nr = t.normalizeResponse({
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
      stop_reason: "end_turn",
    });
    expect(nr.content).toBe("line 1\nline 2");
  });

  test("tool_use block produces a ToolCall with stringified arguments", () => {
    const t = new AnthropicTransport(stubAdapter());
    const nr = t.normalizeResponse({
      content: [
        {
          type: "tool_use",
          id: "toolu_123",
          name: "terminal",
          input: { command: "ls" },
        },
      ],
      stop_reason: "tool_use",
    });
    expect(nr.finish_reason).toBe("tool_calls");
    expect(nr.tool_calls?.length).toBe(1);
    const tc = nr.tool_calls?.[0];
    expect(tc?.id).toBe("toolu_123");
    expect(tc?.name).toBe("terminal");
    expect(tc?.arguments).toBe(JSON.stringify({ command: "ls" }));
  });

  test("tool_use with strip_tool_prefix removes the 'mcp_' prefix", () => {
    const t = new AnthropicTransport(stubAdapter());
    const nr = t.normalizeResponse(
      {
        content: [{ type: "tool_use", id: "toolu_1", name: "mcp_search", input: {} }],
        stop_reason: "tool_use",
      },
      { strip_tool_prefix: true },
    );
    expect(nr.tool_calls?.[0]?.name).toBe("search");
  });

  test("tool_use without strip flag keeps the prefix and handles missing name/id/input", () => {
    const t = new AnthropicTransport(stubAdapter());
    const nr = t.normalizeResponse({
      content: [{ type: "tool_use" }],
      stop_reason: "tool_use",
    });
    expect(nr.tool_calls?.[0]?.name).toBe("");
    expect(nr.tool_calls?.[0]?.id).toBeNull();
    expect(nr.tool_calls?.[0]?.arguments).toBe("{}");
  });

  test("thinking blocks become reasoning text and feed reasoning_details", () => {
    const adapter = stubAdapter({
      toPlainData: vi.fn((v) => v),
    });
    const t = new AnthropicTransport(adapter);
    const nr = t.normalizeResponse({
      content: [
        { type: "thinking", thinking: "Let me think..." },
        { type: "text", text: "The answer is 42" },
      ],
      stop_reason: "end_turn",
    });
    expect(nr.content).toBe("The answer is 42");
    expect(nr.reasoning).toBe("Let me think...");
    const details = nr.providerData?.reasoning_details as Array<{ type: string }> | undefined;
    expect(details?.length).toBe(1);
    expect(details?.[0]?.type).toBe("thinking");
  });

  test("missing thinking text and toPlainData returning non-record both handled", () => {
    const adapter = stubAdapter({
      toPlainData: vi.fn(() => "not-a-record"),
    });
    const t = new AnthropicTransport(adapter);
    const nr = t.normalizeResponse({
      content: [
        { type: "thinking" },
        { type: "thinking", thinking: "second" },
      ],
      stop_reason: "end_turn",
    });
    expect(nr.reasoning).toBe("\n\nsecond");
    // No record-shaped dumps => providerData stays null.
    expect(nr.providerData).toBeNull();
  });

  test("unknown content-block types are silently skipped", () => {
    const t = new AnthropicTransport(stubAdapter());
    const nr = t.normalizeResponse({
      content: [
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "visible" },
      ],
      stop_reason: "end_turn",
    });
    expect(nr.content).toBe("visible");
  });

  test("text block with no `text` property falls back to empty string", () => {
    const t = new AnthropicTransport(stubAdapter());
    const nr = t.normalizeResponse({
      content: [{ type: "text" }, { type: "text", text: "trail" }],
      stop_reason: "end_turn",
    });
    expect(nr.content).toBe("\ntrail");
  });

  test("missing content array defaults to empty (matches `ar.content ?? []`)", () => {
    const t = new AnthropicTransport(stubAdapter());
    const nr = t.normalizeResponse({ stop_reason: "end_turn" });
    expect(nr.content).toBeNull();
    expect(nr.tool_calls).toBeNull();
  });

  test("unknown stop_reason defaults finish_reason to 'stop'", () => {
    const t = new AnthropicTransport(stubAdapter());
    const nr = t.normalizeResponse({ content: [], stop_reason: "wat" });
    expect(nr.finish_reason).toBe("stop");
  });

  test("missing stop_reason still resolves to 'stop'", () => {
    const t = new AnthropicTransport(stubAdapter());
    const nr = t.normalizeResponse({ content: [] });
    expect(nr.finish_reason).toBe("stop");
  });
});

describe("registerAnthropicTransport", () => {
  test("registers a factory that builds a fresh transport per call", () => {
    const adapter = stubAdapter();
    registerAnthropicTransport(adapter);
    const t = getTransport("anthropic_messages");
    expect(t).not.toBeNull();
    expect(t?.apiMode).toBe("anthropic_messages");
  });
});
