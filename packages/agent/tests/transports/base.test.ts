/**
 * Tests for `@hermests/agent/transports/base`.
 *
 * Ported from upstream `tests/agent/transports/test_transport.py`
 * (`TestProviderTransportABC` class).
 *
 * Faithful divergence: TypeScript enforces abstract-class implementation
 * at compile time, so the upstream `pytest.raises(TypeError)` cases for
 * "cannot instantiate ABC" and "concrete must implement all abstract" do
 * not have runtime equivalents — the equivalent failure is a compiler
 * error. We exercise the default implementations and the concrete-minimal
 * happy path instead.
 */

import { describe, expect, test } from "vitest";

import { ProviderTransport } from "../../src/transports/base.js";
import { NormalizedResponse } from "../../src/transports/types.js";

class MinimalTransport extends ProviderTransport {
  override get apiMode(): string {
    return "test_minimal";
  }
  override convertMessages(messages: Array<Record<string, unknown>>): unknown {
    return messages;
  }
  override convertTools(tools: Array<Record<string, unknown>>): unknown {
    return tools;
  }
  override buildKwargs(
    model: string,
    messages: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    return { model, messages };
  }
  override normalizeResponse(): NormalizedResponse {
    return new NormalizedResponse({ content: "ok", tool_calls: null, finish_reason: "stop" });
  }
}

describe("ProviderTransport (minimal concrete subclass)", () => {
  test("apiMode getter returns subclass-specific value", () => {
    const t = new MinimalTransport();
    expect(t.apiMode).toBe("test_minimal");
  });

  test("validateResponse default returns true", () => {
    const t = new MinimalTransport();
    expect(t.validateResponse(null)).toBe(true);
    expect(t.validateResponse({ anything: "goes" })).toBe(true);
  });

  test("extractCacheStats default returns null", () => {
    const t = new MinimalTransport();
    expect(t.extractCacheStats(null)).toBeNull();
    expect(t.extractCacheStats({ usage: { cached_tokens: 100 } })).toBeNull();
  });

  test("mapFinishReason default passes through unchanged", () => {
    const t = new MinimalTransport();
    expect(t.mapFinishReason("end_turn")).toBe("end_turn");
    expect(t.mapFinishReason("anything")).toBe("anything");
  });

  test("buildKwargs delegates to subclass and convertMessages/Tools are reachable", () => {
    const t = new MinimalTransport();
    const kw = t.buildKwargs("m", [{ role: "user", content: "hi" }]);
    expect(kw.model).toBe("m");
    expect(t.convertMessages([{ role: "user", content: "hi" }])).toEqual([
      { role: "user", content: "hi" },
    ]);
    expect(t.convertTools([{ type: "function" }])).toEqual([{ type: "function" }]);
    const nr = t.normalizeResponse();
    expect(nr.content).toBe("ok");
  });
});
