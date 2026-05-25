/**
 * Tests for `@hermests/agent/transports/codex`.
 *
 * Ported from upstream `tests/agent/transports/test_codex_transport.py`.
 * The adapter sits in sub-task #5i — we inject a stub. The
 * `grok_supports_reasoning_effort` predicate (upstream
 * `agent.model_metadata`) is also passed in per-call.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_CODEX_INSTRUCTIONS,
  ResponsesApiTransport,
  type CodexAdapter,
  type CodexNormalizedMessage,
  registerCodexTransport,
} from "../../src/transports/codex.js";
import {
  _resetTransportRegistryForTesting,
  getTransport,
} from "../../src/transports/registry.js";
import { NormalizedResponse } from "../../src/transports/types.js";

type CodexNormalizeReturn = [CodexNormalizedMessage | null, string | null];

function stubAdapter(overrides: Partial<CodexAdapter> = {}): CodexAdapter {
  return {
    chatMessagesToResponsesInput: vi.fn((messages: Array<Record<string, unknown>>) => messages),
    responsesTools: vi.fn((tools: Array<Record<string, unknown>> | null) =>
      tools && tools.length > 0
        ? tools.map((t) => ({
            type: "function",
            name: (t.function as { name?: string } | undefined)?.name ?? "",
          }))
        : [],
    ),
    normalizeCodexResponse: vi.fn(
      (): CodexNormalizeReturn => [
        { content: "default", reasoning: null, tool_calls: null },
        "completed",
      ],
    ),
    preflightCodexApiKwargs: vi.fn((kwargs: Record<string, unknown>) => kwargs),
    ...overrides,
  };
}

beforeEach(() => {
  _resetTransportRegistryForTesting();
});

afterEach(() => {
  _resetTransportRegistryForTesting();
});

describe("ResponsesApiTransport — basic", () => {
  test("apiMode is 'codex_responses'", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    expect(t.apiMode).toBe("codex_responses");
  });

  test("convertMessages forwards is_xai_responses option", () => {
    const adapter = stubAdapter();
    const t = new ResponsesApiTransport(adapter);
    t.convertMessages([{ role: "user", content: "hi" }], { is_xai_responses: true });
    expect(adapter.chatMessagesToResponsesInput).toHaveBeenCalledWith(
      [{ role: "user", content: "hi" }],
      { is_xai_responses: true },
    );
  });

  test("convertMessages defaults is_xai_responses to false", () => {
    const adapter = stubAdapter();
    const t = new ResponsesApiTransport(adapter);
    t.convertMessages([{ role: "user", content: "hi" }]);
    expect(adapter.chatMessagesToResponsesInput).toHaveBeenLastCalledWith(
      [{ role: "user", content: "hi" }],
      { is_xai_responses: false },
    );
  });

  test("convertTools delegates", () => {
    const adapter = stubAdapter();
    const t = new ResponsesApiTransport(adapter);
    const tools = [
      {
        type: "function",
        function: {
          name: "terminal",
          description: "Run a command",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const out = t.convertTools(tools) as Array<{ type: string; name: string }>;
    expect(out[0]?.name).toBe("terminal");
    expect(out[0]?.type).toBe("function");
  });

  test("preflightKwargs delegates to adapter with default allow_stream=false", () => {
    const adapter = stubAdapter();
    const t = new ResponsesApiTransport(adapter);
    t.preflightKwargs({ a: 1 });
    expect(adapter.preflightCodexApiKwargs).toHaveBeenCalledWith({ a: 1 }, { allow_stream: false });
    t.preflightKwargs({ a: 2 }, { allow_stream: true });
    expect(adapter.preflightCodexApiKwargs).toHaveBeenLastCalledWith({ a: 2 }, { allow_stream: true });
  });
});

describe("ResponsesApiTransport.buildKwargs", () => {
  test("basic kwargs: model, instructions, input, store=false, tools empty", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs(
      "gpt-5.4",
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      [],
      {},
    );
    expect(kw.model).toBe("gpt-5.4");
    expect(kw.instructions).toBe("You are helpful.");
    expect(kw.input).toBeDefined();
    expect(kw.store).toBe(false);
    expect(kw.tool_choice).toBeUndefined();
    expect(kw.parallel_tool_calls).toBeUndefined();
  });

  test("system message is extracted; tools enable tool_choice + parallel_tool_calls", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs(
      "gpt-5.4",
      [
        { role: "system", content: "Custom system prompt" },
        { role: "user", content: "Hi" },
      ],
      [{ type: "function", function: { name: "t" } }],
      {},
    );
    expect(kw.instructions).toBe("Custom system prompt");
    expect(kw.tool_choice).toBe("auto");
    expect(kw.parallel_tool_calls).toBe(true);
  });

  test("explicit instructions param wins over messages and default", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs(
      "gpt-5.4",
      [{ role: "system", content: "should-not-use" }],
      [],
      { instructions: "explicit instructions" },
    );
    expect(kw.instructions).toBe("explicit instructions");
  });

  test("no system + no instructions → default fallback string", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {});
    expect(kw.instructions).toBe(DEFAULT_CODEX_INSTRUCTIONS);
  });

  test("default_instructions param overrides the fallback string", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      default_instructions: "custom-default",
    });
    expect(kw.instructions).toBe("custom-default");
  });

  test("system message with null content falls through to default (?? '' branch)", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs(
      "gpt-5.4",
      [{ role: "system", content: null }, { role: "user", content: "Hi" }],
      [],
      {},
    );
    expect(kw.instructions).toBe(DEFAULT_CODEX_INSTRUCTIONS);
  });

  test("system message with empty content falls through to default", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs(
      "gpt-5.4",
      [
        { role: "system", content: "   " },
        { role: "user", content: "Hi" },
      ],
      [],
      {},
    );
    expect(kw.instructions).toBe(DEFAULT_CODEX_INSTRUCTIONS);
  });

  test("reasoning_config.effort='high' is forwarded", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      reasoning_config: { effort: "high" },
    });
    expect((kw.reasoning as { effort: string }).effort).toBe("high");
  });

  test("reasoning_config.effort='minimal' is clamped to 'low'", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      reasoning_config: { effort: "minimal" },
    });
    expect((kw.reasoning as { effort: string }).effort).toBe("low");
  });

  test("reasoning_config.enabled=false drops reasoning + sets include=[]", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      reasoning_config: { enabled: false },
    });
    expect(kw.reasoning).toBeUndefined();
    expect(kw.include).toEqual([]);
  });

  test("default reasoning carries effort=medium + summary=auto + encrypted_content include", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {});
    expect(kw.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(kw.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("session_id sets prompt_cache_key for the default backend", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      session_id: "test-session-123",
    });
    expect(kw.prompt_cache_key).toBe("test-session-123");
  });

  test("is_github_responses suppresses prompt_cache_key + drops include[]", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      session_id: "test-session",
      is_github_responses: true,
    });
    expect(kw.prompt_cache_key).toBeUndefined();
  });

  test("is_github_responses + github_reasoning_extra surfaces extras as reasoning", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      is_github_responses: true,
      github_reasoning_extra: { effort: "high", custom: true },
    });
    expect(kw.reasoning).toEqual({ effort: "high", custom: true });
  });

  test("is_github_responses without extras and with reasoning enabled emits no reasoning key", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      is_github_responses: true,
    });
    expect(kw.reasoning).toBeUndefined();
  });

  test("xAI: prompt_cache_key goes to extra_body, headers carry x-grok-conv-id", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("grok-4.3", [{ role: "user", content: "Hi" }], [], {
      session_id: "conv-xai-1",
      is_xai_responses: true,
    });
    expect(kw.prompt_cache_key).toBeUndefined();
    expect((kw.extra_body as { prompt_cache_key: string }).prompt_cache_key).toBe("conv-xai-1");
    expect((kw.extra_headers as { "x-grok-conv-id": string })["x-grok-conv-id"]).toBe(
      "conv-xai-1",
    );
  });

  test("xAI: caller-supplied extra_body.prompt_cache_key wins (setdefault semantics)", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("grok-4.3", [{ role: "user", content: "Hi" }], [], {
      session_id: "conv-xai-1",
      is_xai_responses: true,
      request_overrides: {
        extra_body: { prompt_cache_key: "caller-override", other_field: 42 },
      },
    });
    const eb = kw.extra_body as Record<string, unknown>;
    expect(eb.prompt_cache_key).toBe("caller-override");
    expect(eb.other_field).toBe(42);
  });

  test("xAI: caller-supplied extra_headers merge with x-grok-conv-id", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("grok-3", [{ role: "user", content: "Hi" }], [], {
      session_id: "conv-123",
      is_xai_responses: true,
      request_overrides: { extra_headers: { "X-Test": "1", "X-Trace": "abc" } },
    });
    expect(kw.extra_headers).toEqual({
      "X-Test": "1",
      "X-Trace": "abc",
      "x-grok-conv-id": "conv-123",
    });
  });

  test("xAI: extra_headers null-valued caller entries are dropped before merge", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("grok-3", [{ role: "user", content: "Hi" }], [], {
      session_id: "conv-123",
      is_xai_responses: true,
      request_overrides: { extra_headers: { Empty: null, Kept: "yes" } },
    });
    const hdrs = kw.extra_headers as Record<string, string>;
    expect(hdrs.Empty).toBeUndefined();
    expect(hdrs.Kept).toBe("yes");
    expect(hdrs["x-grok-conv-id"]).toBe("conv-123");
  });

  test("xAI: model on allowlist receives reasoning.effort + encrypted_content include", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const allow = vi.fn((m: string) => m === "grok-4.3" || m.endsWith("/grok-3-mini"));
    const kw = t.buildKwargs("grok-4.3", [{ role: "user", content: "Hi" }], [], {
      is_xai_responses: true,
      reasoning_config: { effort: "high" },
      grok_supports_reasoning_effort: allow,
    });
    expect(kw.reasoning).toEqual({ effort: "high" });
    expect(kw.include).toEqual(["reasoning.encrypted_content"]);
    expect(allow).toHaveBeenCalledWith("grok-4.3");
  });

  test("xAI: reasoning disabled emits no reasoning key", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("grok-4.3", [{ role: "user", content: "Hi" }], [], {
      is_xai_responses: true,
      reasoning_config: { enabled: false },
    });
    expect(kw.reasoning).toBeUndefined();
  });

  test("xAI: model NOT on allowlist omits reasoning.effort but still requests encrypted_content", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const deny = vi.fn(() => false);
    const kw = t.buildKwargs("grok-4", [{ role: "user", content: "Hi" }], [], {
      is_xai_responses: true,
      reasoning_config: { effort: "high" },
      grok_supports_reasoning_effort: deny,
    });
    expect(kw.reasoning).toBeUndefined();
    expect(kw.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("xAI: no allowlist predicate supplied → omit reasoning, still request encrypted_content", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("grok-4.3", [{ role: "user", content: "Hi" }], [], {
      is_xai_responses: true,
      reasoning_config: { effort: "high" },
    });
    expect(kw.reasoning).toBeUndefined();
    expect(kw.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("max_tokens → max_output_tokens (except on codex_backend)", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      max_tokens: 4096,
    });
    expect(kw.max_output_tokens).toBe(4096);

    const kwCodex = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      max_tokens: 4096,
      is_codex_backend: true,
    });
    expect(kwCodex.max_output_tokens).toBeUndefined();
  });

  test("is_codex_backend adds session_id + x-client-request-id headers", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      session_id: "sess-9",
      is_codex_backend: true,
    });
    const hdrs = kw.extra_headers as Record<string, string>;
    expect(hdrs.session_id).toBe("sess-9");
    expect(hdrs["x-client-request-id"]).toBe("sess-9");
  });

  test("is_codex_backend merges caller-supplied extra_headers (null-valued drops)", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      session_id: "sess-9",
      is_codex_backend: true,
      request_overrides: { extra_headers: { "X-Trace": "abc", Empty: null } },
    });
    const hdrs = kw.extra_headers as Record<string, string>;
    expect(hdrs["X-Trace"]).toBe("abc");
    expect(hdrs.Empty).toBeUndefined();
    expect(hdrs.session_id).toBe("sess-9");
  });

  test("is_codex_backend without a session_id or prompt_cache_key skips header injection", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      is_codex_backend: true,
    });
    expect(kw.extra_headers).toBeUndefined();
  });

  test("request_overrides apply last and can set arbitrary top-level keys", () => {
    const t = new ResponsesApiTransport(stubAdapter());
    const kw = t.buildKwargs("gpt-5.4", [{ role: "user", content: "Hi" }], [], {
      request_overrides: { custom_top_level: 7 },
    });
    expect(kw.custom_top_level).toBe(7);
  });
});

describe("ResponsesApiTransport.validateResponse", () => {
  const t = new ResponsesApiTransport(stubAdapter());

  test("null + non-record responses are invalid", () => {
    expect(t.validateResponse(null)).toBe(false);
    expect(t.validateResponse(undefined)).toBe(false);
    expect(t.validateResponse("string")).toBe(false);
  });

  test("empty / missing output is invalid", () => {
    expect(t.validateResponse({ output: [] })).toBe(false);
    expect(t.validateResponse({ output: null })).toBe(false);
    expect(t.validateResponse({})).toBe(false);
  });

  test("non-empty output array is valid", () => {
    expect(t.validateResponse({ output: [{ type: "message", content: [] }] })).toBe(true);
  });

  test("output_text alone is NOT valid (strict)", () => {
    expect(t.validateResponse({ output: null, output_text: "Some text" })).toBe(false);
  });
});

describe("ResponsesApiTransport.mapFinishReason", () => {
  const t = new ResponsesApiTransport(stubAdapter());

  test.each([
    ["completed", "stop"],
    ["incomplete", "length"],
    ["failed", "stop"],
    ["cancelled", "stop"],
    ["unknown_status", "stop"],
  ])("'%s' → '%s'", (input, expected) => {
    expect(t.mapFinishReason(input)).toBe(expected);
  });
});

describe("ResponsesApiTransport.normalizeResponse", () => {
  test("text response surfaces content + finish_reason", () => {
    const adapter = stubAdapter({
      normalizeCodexResponse: vi.fn((): CodexNormalizeReturn => [
        { content: "Hello world", reasoning: null },
        "completed",
      ]),
    });
    const t = new ResponsesApiTransport(adapter);
    const nr = t.normalizeResponse({});
    expect(nr).toBeInstanceOf(NormalizedResponse);
    expect(nr.content).toBe("Hello world");
    expect(nr.finish_reason).toBe("completed");
  });

  test("missing finish_reason defaults to 'stop'", () => {
    const adapter = stubAdapter({
      normalizeCodexResponse: vi.fn((): CodexNormalizeReturn => [{ content: "x" }, null]),
    });
    const t = new ResponsesApiTransport(adapter);
    expect(t.normalizeResponse({}).finish_reason).toBe("stop");
  });

  test("null msg yields content null and no provider_data", () => {
    const adapter = stubAdapter({
      normalizeCodexResponse: vi.fn((): CodexNormalizeReturn => [null, "completed"]),
    });
    const t = new ResponsesApiTransport(adapter);
    const nr = t.normalizeResponse({});
    expect(nr.content).toBeNull();
    expect(nr.tool_calls).toBeNull();
    expect(nr.providerData).toBeNull();
  });

  test("function-style tool_call carries call_id + response_item_id into provider_data", () => {
    const adapter = stubAdapter({
      normalizeCodexResponse: vi.fn((): CodexNormalizeReturn => [
        {
          content: null,
          tool_calls: [
            {
              id: "fc_abc123",
              function: { name: "terminal", arguments: JSON.stringify({ command: "ls" }) },
              call_id: "call_abc123",
              response_item_id: "fc_abc123",
            },
          ],
        },
        "incomplete",
      ]),
    });
    const t = new ResponsesApiTransport(adapter);
    const nr = t.normalizeResponse({});
    expect(nr.finish_reason).toBe("incomplete");
    const tc = nr.tool_calls?.[0];
    expect(tc?.name).toBe("terminal");
    expect(tc?.id).toBe("fc_abc123");
    expect(tc?.providerData).toEqual({
      call_id: "call_abc123",
      response_item_id: "fc_abc123",
    });
  });

  test("flat-shape tool_call (name/arguments) without function key still works", () => {
    const adapter = stubAdapter({
      normalizeCodexResponse: vi.fn((): CodexNormalizeReturn => [
        {
          content: null,
          tool_calls: [{ name: "search", arguments: "{}", call_id: "call_q" }],
        },
        "completed",
      ]),
    });
    const t = new ResponsesApiTransport(adapter);
    const nr = t.normalizeResponse({});
    const tc = nr.tool_calls?.[0];
    expect(tc?.name).toBe("search");
    expect(tc?.arguments).toBe("{}");
    expect(tc?.id).toBeNull();
    expect(tc?.providerData?.call_id).toBe("call_q");
  });

  test("tool_call with no id but a function falls back to function.name as id", () => {
    const adapter = stubAdapter({
      normalizeCodexResponse: vi.fn((): CodexNormalizeReturn => [
        {
          content: null,
          tool_calls: [
            { function: { name: "search_fn", arguments: "{}" } },
          ],
        },
        "completed",
      ]),
    });
    const t = new ResponsesApiTransport(adapter);
    const tc = t.normalizeResponse({}).tool_calls?.[0];
    expect(tc?.id).toBe("search_fn");
    expect(tc?.name).toBe("search_fn");
  });

  test("tool_call with no id and no function falls back to id=null + name=''", () => {
    const adapter = stubAdapter({
      normalizeCodexResponse: vi.fn((): CodexNormalizeReturn => [
        {
          content: null,
          tool_calls: [{}],
        },
        "completed",
      ]),
    });
    const t = new ResponsesApiTransport(adapter);
    const tc = t.normalizeResponse({}).tool_calls?.[0];
    expect(tc?.id).toBeNull();
    expect(tc?.name).toBe("");
    expect(tc?.arguments).toBe("{}");
    expect(tc?.providerData).toBeNull();
  });

  test("codex_reasoning_items + codex_message_items + reasoning_details survive in provider_data", () => {
    const adapter = stubAdapter({
      normalizeCodexResponse: vi.fn((): CodexNormalizeReturn => [
        {
          content: "x",
          codex_reasoning_items: [{ id: "rs_1" }],
          codex_message_items: [{ id: "msg_1" }],
          reasoning_details: [{ type: "thinking" }],
        },
        "completed",
      ]),
    });
    const t = new ResponsesApiTransport(adapter);
    const nr = t.normalizeResponse({});
    expect(nr.codex_reasoning_items).toEqual([{ id: "rs_1" }]);
    expect(nr.codex_message_items).toEqual([{ id: "msg_1" }]);
    expect(nr.providerData?.reasoning_details).toEqual([{ type: "thinking" }]);
  });
});

describe("registerCodexTransport", () => {
  test("registers a factory under codex_responses", () => {
    registerCodexTransport(stubAdapter());
    expect(getTransport("codex_responses")?.apiMode).toBe("codex_responses");
  });
});
