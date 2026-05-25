/**
 * Per-provider HTTP header builders for the auxiliary client.
 * Faithful port of lines 308-481 of upstream `agent/auxiliary_client.py`.
 *
 * Each builder returns a fresh dict; callers may mutate the result.
 */

import { Buffer } from "node:buffer";
import { baseUrlHostMatches, getLogger } from "@hermests/core";
import { hermesVersion, loadConfig } from "../_internal/sibling-stubs.js";
import { TRUTHY_ENV_VALUES } from "./provider-config.js";

const logger = getLogger("agent.auxiliary_client.headers");

/**
 * OpenRouter app attribution headers (base — always sent).
 *
 * `X-Title` is the canonical attribution header OpenRouter's dashboard reads;
 * the previous `X-OpenRouter-Title` label was not recognized there.
 *
 * Faithful to `_OR_HEADERS_BASE` (py:L311-315).
 */
export const OR_HEADERS_BASE: Readonly<Record<string, string>> = Object.freeze({
  "HTTP-Referer": "https://hermes-agent.nousresearch.com",
  "X-Title": "Hermes Agent",
  "X-OpenRouter-Categories": "productivity,cli-agent",
});

/** Min/max valid TTL accepted on the OpenRouter response-cache header. */
const OR_CACHE_TTL_MIN = 1;
const OR_CACHE_TTL_MAX = 86400;

/**
 * Build OpenRouter headers, optionally including response-cache headers.
 *
 * Precedence for response cache: env var > config.yaml > default (disabled).
 *
 * Environment variables:
 *   - `HERMES_OPENROUTER_CACHE` — truthy (`1`/`true`/`yes`/`on`) enables
 *     caching; anything else disables. Overrides `openrouter.response_cache`
 *     in config.yaml.
 *   - `HERMES_OPENROUTER_CACHE_TTL` — integer seconds (1-86400). Overrides
 *     `openrouter.response_cache_ttl` in config.yaml.
 *
 * `orConfig` is the `openrouter` section from config.yaml. When `undefined`
 * (or `null` to match upstream `or_config=None`), falls back to reading
 * config from disk via `loadConfig()`.
 *
 * Faithful to `build_or_headers` (py:L321-370).
 */
export function buildOrHeaders(orConfig?: Record<string, unknown> | null): Record<string, string> {
  const headers: Record<string, string> = { ...OR_HEADERS_BASE };

  // Resolve config from disk if not provided.
  let effective: Record<string, unknown>;
  if (orConfig === undefined || orConfig === null) {
    try {
      const cfg = loadConfig();
      const section = cfg.openrouter;
      effective =
        section && typeof section === "object" ? (section as Record<string, unknown>) : {};
    } catch {
      effective = {};
    }
  } else {
    effective = orConfig;
  }

  // Determine cache enabled: env var overrides config.
  const envCache = (process.env.HERMES_OPENROUTER_CACHE ?? "").trim().toLowerCase();
  let cacheEnabled: boolean;
  if (envCache) {
    cacheEnabled = TRUTHY_ENV_VALUES.has(envCache);
  } else {
    cacheEnabled = effective.response_cache === true;
  }

  if (!cacheEnabled) {
    return headers;
  }

  headers["X-OpenRouter-Cache"] = "true";

  // Determine TTL: env var overrides config.
  const envTtl = (process.env.HERMES_OPENROUTER_CACHE_TTL ?? "").trim();
  if (envTtl) {
    if (/^\d+$/.test(envTtl)) {
      const ttl = Number.parseInt(envTtl, 10);
      if (ttl >= OR_CACHE_TTL_MIN && ttl <= OR_CACHE_TTL_MAX) {
        headers["X-OpenRouter-Cache-TTL"] = String(ttl);
      }
    }
  } else {
    const raw = effective.response_cache_ttl ?? 300;
    if (
      typeof raw === "number" &&
      Number.isFinite(raw) &&
      raw >= OR_CACHE_TTL_MIN &&
      raw <= OR_CACHE_TTL_MAX
    ) {
      headers["X-OpenRouter-Cache-TTL"] = String(Math.trunc(raw));
    }
  }

  return headers;
}

/**
 * NVIDIA NIM cloud billing attribution headers. Host-gated because the
 * nvidia provider also supports local/on-prem NIM endpoints via
 * NVIDIA_BASE_URL.
 *
 * Faithful to `_NVIDIA_NIM_CLOUD_HEADERS` (py:L375-377).
 */
const NVIDIA_NIM_CLOUD_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "X-BILLING-INVOKE-ORIGIN": "HermesAgent",
});

/**
 * Return NVIDIA NIM cloud attribution headers for `build.nvidia.com` traffic.
 * Faithful to `build_nvidia_nim_headers` (py:L380-384).
 */
export function buildNvidiaNimHeaders(baseUrl: string | null | undefined): Record<string, string> {
  if (baseUrlHostMatches(String(baseUrl ?? ""), "integrate.api.nvidia.com")) {
    return { ...NVIDIA_NIM_CLOUD_HEADERS };
  }
  return {};
}

/**
 * Vercel AI Gateway app attribution headers. HTTP-Referer maps to
 * referrerUrl and X-Title maps to appName in the gateway's analytics.
 *
 * Faithful to `_AI_GATEWAY_HEADERS` (py:L391-395). Built lazily so a
 * hot-reloaded hermes-cli version is reflected without restarting
 * long-running processes.
 */
export function aiGatewayHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": "https://hermes-agent.nousresearch.com",
    "X-Title": "Hermes Agent",
    "User-Agent": `HermesAgent/${hermesVersion()}`,
  };
}

/**
 * Headers required to avoid Cloudflare 403s on
 * `chatgpt.com/backend-api/codex`. Faithful to `_codex_cloudflare_headers`
 * (py:L444-480).
 *
 * The Cloudflare layer in front of the Codex endpoint whitelists a small set
 * of first-party originators (`codex_cli_rs`, `codex_vscode`,
 * `codex_sdk_ts`, anything starting with `Codex`). Requests from
 * non-residential IPs (VPS, server-hosted agents) that don't advertise an
 * allowed originator are served a 403 with `cf-mitigated: challenge`
 * regardless of auth correctness.
 *
 * We pin `originator: codex_cli_rs` to match the upstream codex-rs CLI, set
 * `User-Agent` to a codex_cli_rs-shaped string (beats SDK fingerprinting),
 * and extract `ChatGPT-Account-ID` (canonical casing, from codex-rs
 * `auth.rs`) out of the OAuth JWT's `chatgpt_account_id` claim.
 *
 * Malformed tokens are tolerated — we drop the account-ID header rather than
 * raise, so a bad token still surfaces as an auth error (401) instead of a
 * crash at client construction.
 */
export function codexCloudflareHeaders(accessToken: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
    originator: "codex_cli_rs",
  };
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return headers;
  }
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) {
      return headers;
    }
    // Pad and decode the JWT payload — base64url, padding-tolerant. The
    // `parts.length < 2` guard above means parts[1] is always defined; the
    // non-null assertion is safe.
    // biome-ignore lint/style/noNonNullAssertion: protected by parts.length guard above
    const segment = parts[1]!;
    const padded = segment + "=".repeat(-segment.length & 3);
    const decoded = Buffer.from(padded, "base64url").toString("utf-8");
    const claims = JSON.parse(decoded) as Record<string, unknown>;
    const authClaim = claims["https://api.openai.com/auth"];
    if (authClaim !== null && typeof authClaim === "object") {
      const acctId = (authClaim as Record<string, unknown>).chatgpt_account_id;
      if (typeof acctId === "string" && acctId) {
        headers["ChatGPT-Account-ID"] = acctId;
      }
    }
  } catch {
    // Malformed JWT — drop the account-ID header and let auth fail downstream.
  }
  return headers;
}

/**
 * Internal helper exposed for the `logger.debug` assertions in tests.
 * Returns the logger used by this module so test code can observe debug calls.
 */
export function getHeadersLogger(): ReturnType<typeof getLogger> {
  return logger;
}
