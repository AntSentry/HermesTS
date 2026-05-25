// Ported from tests/tools/test_config_null_guard.py::TestTrajectoryCompressorNullGuard
// and tests/hermes_cli/test_arcee_provider.py::test_trajectory_compressor_detects_arcee.

import { describe, expect, it } from "vitest";
import { detectProvider } from "../src/provider-detection.js";

describe("detectProvider", () => {
  it.each([
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://nousresearch.com/api/v1", "nous"],
    ["https://chatgpt.com/backend-api/codex", "codex"],
    ["https://CHATGPT.com/Backend-Api/CODEX/foo", "codex"],
    ["https://z.ai/api/v1", "zai"],
    ["https://api.z.ai/api/paas/v4", "zai"],
    ["https://api.moonshot.ai/v1", "kimi-coding"],
    ["https://api.moonshot.cn/v1", "kimi-coding"],
    ["https://api.kimi.com/coding", "kimi-coding"],
    ["https://api.arcee.ai/api/v1", "arcee"],
    ["https://api.minimaxi.com/v1", "minimax-cn"],
    ["https://api.minimax.io/v1", "minimax"],
  ])("detects %s -> %s", (url, expected) => {
    expect(detectProvider(url)).toBe(expected);
  });

  it("returns empty string for unknown provider", () => {
    expect(detectProvider("https://example.com/v1")).toBe("");
  });

  it("returns empty string for chatgpt without /backend-api/codex", () => {
    expect(detectProvider("https://chatgpt.com/")).toBe("");
  });

  it("returns empty string for null base URL — null-guard", () => {
    // Ported from TestTrajectoryCompressorNullGuard.test_null_base_url_does_not_crash
    expect(detectProvider(null)).toBe("");
    expect(detectProvider(undefined)).toBe("");
    expect(detectProvider("")).toBe("");
  });
});
