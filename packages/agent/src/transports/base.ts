/**
 * Abstract base for provider transports.
 *
 * Faithful port of upstream `agent/transports/base.py`.
 *
 * A transport owns the data path for one `apiMode`:
 *   `convertMessages → convertTools → buildKwargs → normalizeResponse`
 *
 * It does NOT own: client construction, streaming, credential refresh,
 * prompt caching, interrupt handling, or retry logic. Those stay on
 * AIAgent (deferred to integrators sub-task #5o).
 *
 * ── Faithful divergences ──────────────────────────────────────────────
 * 1. Python `ABC` with `@abstractmethod` becomes TS `abstract class` with
 *    `abstract` members. TypeScript enforces implementation at compile
 *    time rather than instantiation time, so the upstream
 *    `TypeError: Can't instantiate abstract class …` test is not
 *    portable verbatim — see the test-file note.
 * 2. Upstream uses `**kwargs`; TS uses an explicit `options` record so
 *    callers can pass arbitrary extras without changing the signature.
 */

import type { NormalizedResponse } from "./types.js";

/** Optional cache-hit / cache-write counts as exposed by some providers. */
export interface CacheStats {
  cached_tokens: number;
  creation_tokens: number;
}

/** Abstract base class for provider-specific format conversion and normalisation. */
export abstract class ProviderTransport {
  /** The `apiMode` string this transport handles (e.g. `"anthropic_messages"`). */
  abstract get apiMode(): string;

  /**
   * Convert OpenAI-format messages to provider-native format.
   *
   * Returns provider-specific structure (e.g. `[system, messages]` for
   * Anthropic, or the messages list unchanged for `chat_completions`).
   */
  abstract convertMessages(
    messages: Array<Record<string, unknown>>,
    options?: Record<string, unknown>,
  ): unknown;

  /**
   * Convert OpenAI-format tool definitions to provider-native format.
   *
   * Returns provider-specific tool list (e.g. Anthropic `input_schema`
   * format).
   */
  abstract convertTools(tools: Array<Record<string, unknown>>): unknown;

  /**
   * Build the complete API-call kwargs record.
   *
   * Typically calls `convertMessages()` and `convertTools()` internally,
   * then adds model-specific config. Returns a record ready to be
   * passed to the provider's SDK client.
   */
  abstract buildKwargs(
    model: string,
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>> | null,
    params: Record<string, unknown>,
  ): Record<string, unknown>;

  /**
   * Normalise a raw provider response to a shared `NormalizedResponse`.
   *
   * The only method that returns a transport-layer type.
   */
  abstract normalizeResponse(
    response: unknown,
    options?: Record<string, unknown>,
  ): NormalizedResponse;

  /**
   * Optional structural validity check on the raw response.
   *
   * Returns `true` if valid, `false` if the response should be treated
   * as invalid. Default: always `true` (matches upstream).
   */
  validateResponse(_response: unknown): boolean {
    return true;
  }

  /**
   * Optional provider-specific cache hit / creation stats. Default:
   * `null` (matches upstream returning `None`).
   */
  extractCacheStats(_response: unknown): CacheStats | null {
    return null;
  }

  /**
   * Optional provider-specific stop-reason mapping. Default: passthrough
   * (matches upstream returning the raw reason unchanged).
   */
  mapFinishReason(rawReason: string): string {
    return rawReason;
  }
}
