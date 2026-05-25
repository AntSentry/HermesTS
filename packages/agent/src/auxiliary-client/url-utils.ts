/**
 * URL helpers shared by the auxiliary client.
 * Faithful port of lines 110-126 + 483-510 of upstream `agent/auxiliary_client.py`.
 */

import { getLogger } from "@hermests/core";

const logger = getLogger("agent.auxiliary_client.url_utils");

/**
 * Return `false` instead of raising when a patched symbol is not a constructor.
 *
 * Mirrors `_safe_isinstance` (py:L110-115). In Python the upstream guards
 * against tests patching `OpenAI` with a non-class; in TS we mirror the
 * semantics for `instanceof` against arbitrary right-hand values. Returns
 * `false` rather than throwing `TypeError`.
 *
 * Accepts `any`-typed `obj`/`ctor` because the call sites are deliberately
 * dynamic — upstream patches the constructor symbol at runtime.
 */
export function safeInstanceof(obj: unknown, ctor: unknown): boolean {
  if (typeof ctor !== "function") {
    return false;
  }
  try {
    return obj instanceof (ctor as new (...args: never[]) => unknown);
  } catch {
    return false;
  }
}

/** Result of `extractUrlQueryParams` — clean URL plus parsed defaults. */
export interface ExtractedUrlQuery {
  /** URL with the query string removed. */
  cleanUrl: string;
  /**
   * Parsed query parameters, or `null` when the URL had no query string.
   * Matches upstream `Optional[dict]` return.
   */
  defaultQuery: Record<string, string> | null;
}

/**
 * Extract query params from a URL, returning the clean URL plus a
 * `default_query` dict suitable for passing to the OpenAI SDK constructor.
 *
 * Faithful to `_extract_url_query_params` (py:L118-125). For each repeated
 * key the *first* value wins — upstream uses `v[0]` from `parse_qs`.
 *
 * URLs without a query string return `defaultQuery: null` and the original
 * URL untouched.
 */
export function extractUrlQueryParams(url: string): ExtractedUrlQuery {
  // Use the WHATWG URL parser. Provide a fallback base for protocol-relative
  // or relative URLs so this never throws on the legitimate inputs aux client
  // sees (always absolute), while keeping behavior deterministic for tests.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { cleanUrl: url, defaultQuery: null };
  }
  if (!parsed.search) {
    return { cleanUrl: url, defaultQuery: null };
  }
  const params: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams.entries()) {
    if (!(k in params)) {
      params[k] = v;
    }
  }
  parsed.search = "";
  const cleanUrl = parsed.toString();
  return { cleanUrl, defaultQuery: params };
}

/**
 * Normalize an Anthropic-style base URL to OpenAI-compatible format.
 *
 * Some providers (MiniMax, MiniMax-CN) expose an `/anthropic` endpoint for the
 * Anthropic Messages API and a separate `/v1` endpoint for OpenAI chat
 * completions. The auxiliary client uses the OpenAI SDK, so it must hit the
 * `/v1` surface. Passing the raw `inference_base_url` causes requests to land
 * on `/anthropic/chat/completions` — a 404.
 *
 * Special cases:
 *   - ZAI (`open.bigmodel.cn` / `bigmodel`) uses `/api/anthropic` for the
 *     Anthropic wire but `/api/paas/v4` for the OpenAI wire — the generic
 *     `/v1` rewrite would be wrong.
 *   - Kimi Code (`api.kimi.com/coding`) uses `/coding/v1/messages` for
 *     Anthropic SDK and `/coding/v1/chat/completions` for OpenAI SDK; without
 *     appending `/v1` here the OpenAI SDK hits `/coding/chat/completions`
 *     (404).
 *
 * Faithful to `_to_openai_base_url` (py:L483-510).
 */
export function toOpenAIBaseUrl(baseUrl: string | null | undefined): string {
  const url = String(baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (url.endsWith("/anthropic")) {
    if (url.includes("open.bigmodel.cn") || url.includes("bigmodel")) {
      const rewritten = `${url.slice(0, -"/anthropic".length)}/paas/v4`;
      logger.debug("Auxiliary client: rewrote ZAI base URL %s → %s", url, rewritten);
      return rewritten;
    }
    const rewritten = `${url.slice(0, -"/anthropic".length)}/v1`;
    logger.debug("Auxiliary client: rewrote base URL %s → %s", url, rewritten);
    return rewritten;
  }
  if (url.includes("api.kimi.com") && url.endsWith("/coding")) {
    const rewritten = `${url}/v1`;
    logger.debug("Auxiliary client: rewrote Kimi base URL %s → %s", url, rewritten);
    return rewritten;
  }
  return url;
}
