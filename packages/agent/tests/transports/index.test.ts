/**
 * Barrel re-export smoke test for `@hermests/agent/transports`.
 *
 * The barrel has no logic of its own — these tests just guarantee each
 * sibling export remains reachable from the package entry. If an export
 * is renamed or dropped, this file fails fast.
 */

import { describe, expect, test } from "vitest";

import * as barrel from "../../src/transports/index.js";
import * as packageBarrel from "../../src/index.js";

describe("@hermests/agent/transports barrel", () => {
  test("types, base, registry, and per-provider exports are reachable", () => {
    expect(barrel.NormalizedResponse).toBeDefined();
    expect(barrel.ToolCall).toBeDefined();
    expect(barrel.Usage).toBeDefined();
    expect(barrel.buildToolCall).toBeDefined();
    expect(barrel.mapFinishReason).toBeDefined();
    expect(barrel.ProviderTransport).toBeDefined();
    expect(barrel.registerTransport).toBeDefined();
    expect(barrel.getTransport).toBeDefined();
    expect(barrel.AnthropicTransport).toBeDefined();
    expect(barrel.registerAnthropicTransport).toBeDefined();
    expect(barrel.BedrockTransport).toBeDefined();
    expect(barrel.registerBedrockTransport).toBeDefined();
    expect(barrel.ResponsesApiTransport).toBeDefined();
    expect(barrel.registerCodexTransport).toBeDefined();
    expect(barrel.ChatCompletionsTransport).toBeDefined();
    expect(barrel.registerChatCompletionsTransport).toBeDefined();
    expect(barrel.DEFAULT_CODEX_INSTRUCTIONS).toBeDefined();
    expect(barrel.DEVELOPER_ROLE_MODELS).toBeDefined();
    expect(barrel.buildGeminiThinkingConfig).toBeDefined();
    expect(barrel.isMoonshotModel).toBeDefined();
    expect(barrel.sanitizeMoonshotTools).toBeDefined();
    expect(barrel.sanitizeMoonshotToolParameters).toBeDefined();
    expect(barrel.snakeCaseGeminiThinkingConfig).toBeDefined();
    expect(barrel.isGeminiOpenaiCompatBaseUrl).toBeDefined();
    expect(barrel.resolveLmstudioEffort).toBeDefined();
    expect(barrel.ANTHROPIC_STOP_REASON_MAP).toBeDefined();
    expect(barrel.BEDROCK_FINISH_REASON_MAP).toBeDefined();
  });

  test("package-level barrel re-exports the transports barrel", () => {
    expect(packageBarrel.NormalizedResponse).toBe(barrel.NormalizedResponse);
    expect(packageBarrel.getTransport).toBe(barrel.getTransport);
  });
});
