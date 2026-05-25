/**
 * Tests for `@hermests/agent/transports/bedrock`.
 *
 * Ported from upstream `tests/agent/transports/test_bedrock_transport.py`.
 * The adapter ships in sub-task #5h; we inject a stub that mirrors the
 * adapter contract.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  BEDROCK_FINISH_REASON_MAP,
  BedrockTransport,
  type BedrockAdapter,
  type BedrockNormalizedConverse,
  registerBedrockTransport,
} from "../../src/transports/bedrock.js";
import {
  _resetTransportRegistryForTesting,
  getTransport,
} from "../../src/transports/registry.js";
import { NormalizedResponse } from "../../src/transports/types.js";

function stubAdapter(overrides: Partial<BedrockAdapter> = {}): BedrockAdapter {
  return {
    convertMessagesToConverse: vi.fn((messages) => messages),
    convertToolsToConverse: vi.fn((tools: Array<Record<string, unknown>>) =>
      tools.map((t) => ({
        toolSpec: {
          name: (t.function as { name?: string } | undefined)?.name ?? "",
        },
      })),
    ),
    buildConverseKwargs: vi.fn((args) => ({
      modelId: args.model,
      messages: args.messages,
      inferenceConfig: { maxTokens: args.max_tokens ?? 4096 },
    })),
    normalizeConverseResponse: vi.fn(() => ({
      choices: [
        {
          message: { content: "default", tool_calls: null, reasoning: null },
          finish_reason: "stop",
        },
      ],
    })),
    ...overrides,
  };
}

beforeEach(() => {
  _resetTransportRegistryForTesting();
});

afterEach(() => {
  _resetTransportRegistryForTesting();
});

describe("BedrockTransport", () => {
  test("apiMode is 'bedrock_converse'", () => {
    const t = new BedrockTransport(stubAdapter());
    expect(t.apiMode).toBe("bedrock_converse");
  });

  test("convertMessages and convertTools delegate to adapter", () => {
    const adapter = stubAdapter();
    const t = new BedrockTransport(adapter);
    t.convertMessages([{ role: "user", content: "hi" }]);
    expect(adapter.convertMessagesToConverse).toHaveBeenCalled();

    const tools = [{ type: "function", function: { name: "terminal" } }];
    const out = t.convertTools(tools) as Array<{ toolSpec: { name: string } }>;
    expect(out[0]?.toolSpec.name).toBe("terminal");
  });

  test("buildKwargs adds sentinel dispatch keys and default region", () => {
    const adapter = stubAdapter();
    const t = new BedrockTransport(adapter);
    const kw = t.buildKwargs(
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
      [{ role: "user", content: "Hello" }],
      null,
      {},
    );
    expect(kw.modelId).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(kw.__bedrock_converse__).toBe(true);
    expect(kw.__bedrock_region__).toBe("us-east-1");
    expect(kw.messages).toBeDefined();
  });

  test("custom region overrides the default", () => {
    const adapter = stubAdapter();
    const t = new BedrockTransport(adapter);
    const kw = t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
      region: "eu-west-1",
    });
    expect(kw.__bedrock_region__).toBe("eu-west-1");
  });

  test("max_tokens is forwarded to the adapter", () => {
    const adapter = stubAdapter();
    const t = new BedrockTransport(adapter);
    const kw = t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
      max_tokens: 8192,
    }) as { inferenceConfig: { maxTokens: number } };
    expect(kw.inferenceConfig.maxTokens).toBe(8192);
  });

  test("temperature + guardrail_config are forwarded to the adapter", () => {
    const adapter = stubAdapter();
    const t = new BedrockTransport(adapter);
    t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {
      temperature: 0.5,
      guardrail_config: { id: "gr1" },
    });
    const args = (adapter.buildConverseKwargs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(args?.temperature).toBe(0.5);
    expect(args?.guardrail_config).toEqual({ id: "gr1" });
  });

  test("temperature + guardrail_config default to null when omitted", () => {
    const adapter = stubAdapter();
    const t = new BedrockTransport(adapter);
    t.buildKwargs("any", [{ role: "user", content: "Hi" }], null, {});
    const args = (adapter.buildConverseKwargs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(args?.temperature).toBeNull();
    expect(args?.guardrail_config).toBeNull();
  });
});

describe("BedrockTransport.validateResponse", () => {
  const t = new BedrockTransport(stubAdapter());

  test("null and undefined are invalid", () => {
    expect(t.validateResponse(null)).toBe(false);
    expect(t.validateResponse(undefined)).toBe(false);
  });

  test("raw dict with 'output' is valid; without is invalid", () => {
    expect(t.validateResponse({ output: { message: {} } })).toBe(true);
    expect(t.validateResponse({ error: "fail" })).toBe(false);
  });

  test("normalised shape with non-empty choices is valid", () => {
    expect(
      t.validateResponse({
        choices: [{ message: { content: "hi" } }],
      }),
    ).toBe(true);
  });

  test("normalised shape with empty choices is invalid", () => {
    expect(t.validateResponse({ choices: [] })).toBe(false);
  });

  test("non-record primitives are invalid", () => {
    expect(t.validateResponse("string-response")).toBe(false);
    expect(t.validateResponse(42)).toBe(false);
  });
});

describe("BedrockTransport.mapFinishReason", () => {
  const t = new BedrockTransport(stubAdapter());

  test("canonical mappings cover end_turn, tool_use, max_tokens, guardrail", () => {
    expect(t.mapFinishReason("end_turn")).toBe("stop");
    expect(t.mapFinishReason("tool_use")).toBe("tool_calls");
    expect(t.mapFinishReason("max_tokens")).toBe("length");
    expect(t.mapFinishReason("guardrail_intervened")).toBe("content_filter");
    expect(t.mapFinishReason("content_filtered")).toBe("content_filter");
    expect(t.mapFinishReason("stop_sequence")).toBe("stop");
  });

  test("unknown maps to 'stop' and exported constant matches the live table", () => {
    expect(t.mapFinishReason("unknown")).toBe("stop");
    expect(BEDROCK_FINISH_REASON_MAP.end_turn).toBe("stop");
  });
});

describe("BedrockTransport.normalizeResponse", () => {
  test("delegates to adapter for raw boto3 dict; returns NormalizedResponse", () => {
    const adapter = stubAdapter({
      normalizeConverseResponse: vi.fn(() => ({
        choices: [
          {
            message: { content: "Hello world", tool_calls: null, reasoning: null },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })),
    });
    const t = new BedrockTransport(adapter);
    const nr = t.normalizeResponse({
      output: { message: { role: "assistant", content: [{ text: "Hello world" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(nr).toBeInstanceOf(NormalizedResponse);
    expect(nr.content).toBe("Hello world");
    expect(nr.finish_reason).toBe("stop");
    expect(nr.usage?.prompt_tokens).toBe(10);
  });

  test("passes through already-normalised SimpleNamespace-style responses", () => {
    const adapter = stubAdapter();
    const t = new BedrockTransport(adapter);
    const preNormalized: BedrockNormalizedConverse = {
      choices: [
        {
          message: {
            content: "Hello from Bedrock",
            tool_calls: null,
            reasoning: null,
            reasoning_content: null,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const nr = t.normalizeResponse(preNormalized);
    expect(nr.content).toBe("Hello from Bedrock");
    expect(nr.finish_reason).toBe("stop");
    expect(nr.usage?.total_tokens).toBe(15);
    // Adapter was not called.
    expect(adapter.normalizeConverseResponse).not.toHaveBeenCalled();
  });

  test("falls back to adapter when choices is empty (treated as raw)", () => {
    const adapter = stubAdapter({
      normalizeConverseResponse: vi.fn(() => ({
        choices: [{ message: { content: "via adapter" }, finish_reason: "stop" }],
      })),
    });
    const t = new BedrockTransport(adapter);
    const nr = t.normalizeResponse({ choices: [] });
    expect(adapter.normalizeConverseResponse).toHaveBeenCalled();
    expect(nr.content).toBe("via adapter");
  });

  test("tool_calls populate ToolCall list and finish_reason carries through", () => {
    const adapter = stubAdapter({
      normalizeConverseResponse: vi.fn(() => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "tool_1",
                  function: { name: "terminal", arguments: '{"command": "ls"}' },
                },
              ],
              reasoning: null,
            },
            finish_reason: "tool_calls",
          },
        ],
      })),
    });
    const t = new BedrockTransport(adapter);
    const nr = t.normalizeResponse({ output: {} });
    expect(nr.finish_reason).toBe("tool_calls");
    expect(nr.tool_calls?.length).toBe(1);
    expect(nr.tool_calls?.[0]?.name).toBe("terminal");
    expect(nr.tool_calls?.[0]?.id).toBe("tool_1");
  });

  test("reasoning_content falls back to .reasoning_content when .reasoning absent", () => {
    const adapter = stubAdapter({
      normalizeConverseResponse: vi.fn(() => ({
        choices: [
          {
            message: {
              content: "Answer.",
              tool_calls: null,
              reasoning: null,
              reasoning_content: "Let me think...",
            },
            finish_reason: "stop",
          },
        ],
      })),
    });
    const t = new BedrockTransport(adapter);
    const nr = t.normalizeResponse({ output: {} });
    expect(nr.reasoning).toBe("Let me think...");
    expect(nr.content).toBe("Answer.");
  });

  test("missing usage stays null on NormalizedResponse", () => {
    const adapter = stubAdapter({
      normalizeConverseResponse: vi.fn(() => ({
        choices: [{ message: { content: "x", tool_calls: null }, finish_reason: "stop" }],
        usage: null,
      })),
    });
    const t = new BedrockTransport(adapter);
    const nr = t.normalizeResponse({ output: {} });
    expect(nr.usage).toBeNull();
  });

  test("usage with missing fields defaults to zero", () => {
    const adapter = stubAdapter({
      normalizeConverseResponse: vi.fn(() => ({
        choices: [{ message: { content: "x", tool_calls: null }, finish_reason: "stop" }],
        usage: {},
      })),
    });
    const t = new BedrockTransport(adapter);
    const nr = t.normalizeResponse({ output: {} });
    expect(nr.usage?.prompt_tokens).toBe(0);
    expect(nr.usage?.completion_tokens).toBe(0);
    expect(nr.usage?.total_tokens).toBe(0);
  });

  test("non-record response forwards to adapter (hasNonEmptyChoices short-circuit)", () => {
    const adapter = stubAdapter({
      normalizeConverseResponse: vi.fn(() => ({
        choices: [{ message: { content: "from primitive" }, finish_reason: "stop" }],
      })),
    });
    const t = new BedrockTransport(adapter);
    const nr = t.normalizeResponse("a-string-response");
    expect(nr.content).toBe("from primitive");
    expect(adapter.normalizeConverseResponse).toHaveBeenCalled();
  });

  test("missing finish_reason defaults to 'stop'", () => {
    const adapter = stubAdapter({
      normalizeConverseResponse: vi.fn(() => ({
        choices: [{ message: { content: "x" }, finish_reason: null }],
      })),
    });
    const t = new BedrockTransport(adapter);
    expect(t.normalizeResponse({ output: {} }).finish_reason).toBe("stop");
  });

  test("throws when adapter returns empty choices (contract violation)", () => {
    const adapter = stubAdapter({
      normalizeConverseResponse: vi.fn(() => ({ choices: [] })),
    });
    const t = new BedrockTransport(adapter);
    expect(() => t.normalizeResponse({ output: {} })).toThrow(/empty choices/);
  });
});

describe("registerBedrockTransport", () => {
  test("registers a factory that builds a fresh transport per call", () => {
    registerBedrockTransport(stubAdapter());
    const t = getTransport("bedrock_converse");
    expect(t?.apiMode).toBe("bedrock_converse");
  });
});
