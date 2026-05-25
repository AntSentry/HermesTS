/**
 * Tests for `@hermests/agent/transports/types`.
 *
 * Ported from upstream `tests/agent/transports/test_types.py`. Every
 * upstream case has a 1:1 TS equivalent; additional cases cover edge
 * branches the upstream tests rely on Python truthiness for (e.g.
 * `arguments` accepting numbers — TS string-coerces).
 */

import { describe, expect, test } from "vitest";

import {
  NormalizedResponse,
  ToolCall,
  Usage,
  buildToolCall,
  mapFinishReason,
} from "../../src/transports/types.js";

describe("ToolCall", () => {
  test("basic construction", () => {
    const tc = new ToolCall({ id: "call_abc", name: "terminal", arguments: '{"cmd": "ls"}' });
    expect(tc.id).toBe("call_abc");
    expect(tc.name).toBe("terminal");
    expect(tc.arguments).toBe('{"cmd": "ls"}');
    expect(tc.providerData).toBeNull();
  });

  test("null id is preserved", () => {
    const tc = new ToolCall({ id: null, name: "read_file", arguments: "{}" });
    expect(tc.id).toBeNull();
  });

  test("providerData passes through and exposes Codex keys", () => {
    const tc = new ToolCall({
      id: "call_x",
      name: "t",
      arguments: "{}",
      providerData: { call_id: "call_x", response_item_id: "fc_x" },
    });
    expect(tc.providerData?.call_id).toBe("call_x");
    expect(tc.providerData?.response_item_id).toBe("fc_x");
  });
});

describe("ToolCall backward-compat properties", () => {
  test("type getter returns 'function'", () => {
    const tc = new ToolCall({ id: "1", name: "search", arguments: '{"q":"test"}' });
    expect(tc.type).toBe("function");
  });

  test("function getter returns self", () => {
    const tc = new ToolCall({ id: "1", name: "search", arguments: '{"q":"test"}' });
    expect(tc.function).toBe(tc);
    expect(tc.function.name).toBe("search");
    expect(tc.function.arguments).toBe('{"q":"test"}');
  });

  test("call_id getter returns providerData.call_id or null", () => {
    const withPd = new ToolCall({
      id: "1",
      name: "fn",
      arguments: "{}",
      providerData: { call_id: "c1" },
    });
    expect(withPd.call_id).toBe("c1");

    const noPd = new ToolCall({ id: "1", name: "fn", arguments: "{}" });
    expect(noPd.call_id).toBeNull();

    const explicitNullPd = new ToolCall({
      id: "1",
      name: "fn",
      arguments: "{}",
      providerData: null,
    });
    expect(explicitNullPd.call_id).toBeNull();
  });

  test("response_item_id getter returns providerData.response_item_id or null", () => {
    const withPd = new ToolCall({
      id: "1",
      name: "fn",
      arguments: "{}",
      providerData: { response_item_id: "r1" },
    });
    expect(withPd.response_item_id).toBe("r1");

    const missingKey = new ToolCall({
      id: "1",
      name: "fn",
      arguments: "{}",
      providerData: { call_id: "c1" },
    });
    expect(missingKey.response_item_id).toBeNull();
  });

  test("extra_content getter returns providerData.extra_content or null", () => {
    const ec = { google: { thought_signature: "SIG_ABC123" } };
    const tc = new ToolCall({
      id: "1",
      name: "fn",
      arguments: "{}",
      providerData: { extra_content: ec },
    });
    expect(tc.extra_content).toBe(ec);

    const noPd = new ToolCall({ id: "1", name: "fn", arguments: "{}", providerData: null });
    expect(noPd.extra_content).toBeNull();

    const missingKey = new ToolCall({
      id: "1",
      name: "fn",
      arguments: "{}",
      providerData: { call_id: "c1" },
    });
    expect(missingKey.extra_content).toBeNull();
  });
});

describe("Usage", () => {
  test("defaults to zero", () => {
    const u = new Usage();
    expect(u.prompt_tokens).toBe(0);
    expect(u.completion_tokens).toBe(0);
    expect(u.total_tokens).toBe(0);
    expect(u.cached_tokens).toBe(0);
  });

  test("explicit values", () => {
    const u = new Usage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cached_tokens: 80,
    });
    expect(u.total_tokens).toBe(150);
    expect(u.cached_tokens).toBe(80);
  });
});

describe("NormalizedResponse", () => {
  test("text-only response carries content and finish_reason", () => {
    const r = new NormalizedResponse({
      content: "hello",
      tool_calls: null,
      finish_reason: "stop",
    });
    expect(r.content).toBe("hello");
    expect(r.tool_calls).toBeNull();
    expect(r.finish_reason).toBe("stop");
    expect(r.reasoning).toBeNull();
    expect(r.usage).toBeNull();
    expect(r.providerData).toBeNull();
  });

  test("with tool_calls", () => {
    const tcs = [new ToolCall({ id: "call_1", name: "terminal", arguments: '{"cmd":"pwd"}' })];
    const r = new NormalizedResponse({
      content: null,
      tool_calls: tcs,
      finish_reason: "tool_calls",
    });
    expect(r.finish_reason).toBe("tool_calls");
    expect(r.tool_calls?.length).toBe(1);
    expect(r.tool_calls?.[0]?.name).toBe("terminal");
  });

  test("with reasoning + usage + providerData", () => {
    const usage = new Usage({ prompt_tokens: 5 });
    const r = new NormalizedResponse({
      content: "answer",
      tool_calls: null,
      finish_reason: "stop",
      reasoning: "I thought about it",
      usage,
      providerData: { reasoning_details: [{ type: "thinking", thinking: "hmm" }] },
    });
    expect(r.reasoning).toBe("I thought about it");
    expect(r.usage).toBe(usage);
    const details = r.reasoning_details as Array<{ type: string }> | null;
    expect(details?.[0]?.type).toBe("thinking");
  });
});

describe("NormalizedResponse backward-compat properties", () => {
  test("reasoning_content getter", () => {
    const r = new NormalizedResponse({
      content: "hi",
      tool_calls: null,
      finish_reason: "stop",
      providerData: { reasoning_content: "thought process" },
    });
    expect(r.reasoning_content).toBe("thought process");

    const empty = new NormalizedResponse({
      content: "hi",
      tool_calls: null,
      finish_reason: "stop",
    });
    expect(empty.reasoning_content).toBeNull();
  });

  test("reasoning_details getter", () => {
    const details = [{ type: "thinking", thinking: "hmm" }];
    const r = new NormalizedResponse({
      content: "hi",
      tool_calls: null,
      finish_reason: "stop",
      providerData: { reasoning_details: details },
    });
    expect(r.reasoning_details).toBe(details);

    const empty = new NormalizedResponse({
      content: "hi",
      tool_calls: null,
      finish_reason: "stop",
      providerData: null,
    });
    expect(empty.reasoning_details).toBeNull();
  });

  test("codex_reasoning_items getter", () => {
    const items = ["item1", "item2"];
    const r = new NormalizedResponse({
      content: "hi",
      tool_calls: null,
      finish_reason: "stop",
      providerData: { codex_reasoning_items: items },
    });
    expect(r.codex_reasoning_items).toBe(items);

    const empty = new NormalizedResponse({
      content: "hi",
      tool_calls: null,
      finish_reason: "stop",
    });
    expect(empty.codex_reasoning_items).toBeNull();
  });

  test("codex_message_items getter", () => {
    const items = [{ id: "msg_1", type: "message" }];
    const r = new NormalizedResponse({
      content: "hi",
      tool_calls: null,
      finish_reason: "stop",
      providerData: { codex_message_items: items },
    });
    expect(r.codex_message_items).toBe(items);

    const empty = new NormalizedResponse({
      content: "hi",
      tool_calls: null,
      finish_reason: "stop",
    });
    expect(empty.codex_message_items).toBeNull();
  });
});

describe("buildToolCall", () => {
  test("record arguments are JSON-serialised", () => {
    const tc = buildToolCall("call_1", "terminal", { cmd: "ls" });
    expect(tc.arguments).toBe(JSON.stringify({ cmd: "ls" }));
    expect(tc.providerData).toBeNull();
  });

  test("string arguments pass through verbatim", () => {
    const tc = buildToolCall("call_2", "read_file", '{"path": "/tmp"}');
    expect(tc.arguments).toBe('{"path": "/tmp"}');
  });

  test("non-record / non-string arguments stringify", () => {
    const tc = buildToolCall("call_n", "n", 42);
    expect(tc.arguments).toBe("42");

    // Array also stringifies via String() (matches upstream `str(arguments)`).
    const tcArr = buildToolCall("call_a", "a", [1, 2, 3]);
    expect(tcArr.arguments).toBe("1,2,3");
  });

  test("provider fields collect into providerData", () => {
    const tc = buildToolCall("call_3", "terminal", "{}", {
      call_id: "call_3",
      response_item_id: "fc_3",
    });
    expect(tc.providerData).toEqual({ call_id: "call_3", response_item_id: "fc_3" });
  });

  test("null id is preserved", () => {
    const tc = buildToolCall(null, "t", "{}");
    expect(tc.id).toBeNull();
  });
});

describe("mapFinishReason", () => {
  const ANTHROPIC_MAP: Record<string, string> = {
    end_turn: "stop",
    tool_use: "tool_calls",
    max_tokens: "length",
    stop_sequence: "stop",
    refusal: "content_filter",
  };

  test("known reasons map correctly", () => {
    expect(mapFinishReason("end_turn", ANTHROPIC_MAP)).toBe("stop");
    expect(mapFinishReason("tool_use", ANTHROPIC_MAP)).toBe("tool_calls");
    expect(mapFinishReason("max_tokens", ANTHROPIC_MAP)).toBe("length");
    expect(mapFinishReason("refusal", ANTHROPIC_MAP)).toBe("content_filter");
  });

  test("unknown reason defaults to 'stop'", () => {
    expect(mapFinishReason("something_new", ANTHROPIC_MAP)).toBe("stop");
  });

  test("null and undefined default to 'stop'", () => {
    expect(mapFinishReason(null, ANTHROPIC_MAP)).toBe("stop");
    expect(mapFinishReason(undefined, ANTHROPIC_MAP)).toBe("stop");
  });
});
