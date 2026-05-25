/**
 * Provider detection — faithful port of `TrajectoryCompressor._detect_provider`
 * (upstream `trajectory_compressor.py` lines 435-462).
 *
 * Detects the provider id from a base URL, used to decide whether to route
 * through the call_llm/async_call_llm provider router or hit a raw OpenAI
 * client.
 */

import { baseUrlHostMatches, baseUrlHostname } from "@hermests/core";

/**
 * Detect the provider name from a configured base URL. Returns "" when the
 * URL doesn't match any known provider (matches upstream — empty string
 * signals "use raw client" to the caller).
 */
export function detectProvider(baseUrl: string | null | undefined): string {
  const url = baseUrl ?? "";

  if (baseUrlHostMatches(url, "openrouter.ai")) return "openrouter";
  if (baseUrlHostMatches(url, "nousresearch.com")) return "nous";

  if (baseUrlHostname(url) === "chatgpt.com" && url.toLowerCase().includes("/backend-api/codex")) {
    return "codex";
  }

  if (baseUrlHostMatches(url, "z.ai")) return "zai";

  if (
    baseUrlHostMatches(url, "moonshot.ai") ||
    baseUrlHostMatches(url, "moonshot.cn") ||
    baseUrlHostMatches(url, "api.kimi.com")
  ) {
    return "kimi-coding";
  }

  if (baseUrlHostMatches(url, "arcee.ai")) return "arcee";
  if (baseUrlHostMatches(url, "minimaxi.com")) return "minimax-cn";
  if (baseUrlHostMatches(url, "minimax.io")) return "minimax";

  return "";
}
