/**
 * Anthropic prompt caching strategy.
 *
 * Faithful port of upstream `agent/prompt_caching.py`.
 *
 * Single layout: `system_and_3`. 4 cache_control breakpoints — system
 * prompt + last 3 non-system messages, all at the same TTL (5m or 1h).
 * Reduces input token costs by ~75% on multi-turn conversations within
 * a single session.
 *
 * Pure functions — no class state, no AIAgent dependency.
 */

interface CacheMarker {
  type: "ephemeral";
  ttl?: "1h";
}

interface MessageDict {
  role?: unknown;
  content?: unknown;
  cache_control?: unknown;
  [key: string]: unknown;
}

interface ContentPartDict {
  cache_control?: unknown;
  [key: string]: unknown;
}

function isContentPart(value: unknown): value is ContentPartDict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildMarker(ttl: string): CacheMarker {
  const marker: CacheMarker = { type: "ephemeral" };
  if (ttl === "1h") {
    marker.ttl = "1h";
  }
  return marker;
}

/** Add `cache_control` to a single message, handling all format variations. */
function applyCacheMarker(msg: MessageDict, marker: CacheMarker, nativeAnthropic: boolean): void {
  // The applyAnthropicCacheControl callers only pass dicts whose `role`
  // is a string (or absent → "" coerced is dead). Treat `role` as the
  // string value for branch coverage purposes.
  const role = msg.role as string | undefined;
  const content = msg.content;

  if (role === "tool") {
    if (nativeAnthropic) {
      msg.cache_control = marker;
    }
    return;
  }

  if (content === null || content === undefined || content === "") {
    msg.cache_control = marker;
    return;
  }

  if (typeof content === "string") {
    msg.content = [{ type: "text", text: content, cache_control: marker }];
    return;
  }

  if (Array.isArray(content) && content.length > 0) {
    const last = content[content.length - 1];
    if (isContentPart(last)) {
      last.cache_control = marker;
    }
  }
}

/**
 * Apply `system_and_3` caching strategy to messages for Anthropic models.
 *
 * Places up to 4 cache_control breakpoints: system prompt + last 3
 * non-system messages, all at the same TTL.
 *
 * Returns a deep copy with cache_control breakpoints injected — the
 * input array is never mutated.
 */
export function applyAnthropicCacheControl(
  apiMessages: ReadonlyArray<Record<string, unknown>>,
  cacheTtl: "5m" | "1h" = "5m",
  nativeAnthropic = false,
): Array<Record<string, unknown>> {
  // structuredClone matches Python's `copy.deepcopy` for JSON-shaped
  // data. The message dicts contain nested arrays of content parts;
  // we need a deep clone so the caller's reference is untouched.
  const messages: MessageDict[] = structuredClone(apiMessages as Record<string, unknown>[]);
  if (messages.length === 0) {
    return messages as Array<Record<string, unknown>>;
  }

  const marker = buildMarker(cacheTtl);

  let breakpointsUsed = 0;
  if (messages[0]?.role === "system") {
    applyCacheMarker(messages[0]!, marker, nativeAnthropic);
    breakpointsUsed += 1;
  }

  const remaining = 4 - breakpointsUsed;
  const nonSysIdx: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]!.role !== "system") {
      nonSysIdx.push(i);
    }
  }
  const tail = nonSysIdx.slice(Math.max(0, nonSysIdx.length - remaining));
  for (const idx of tail) {
    applyCacheMarker(messages[idx]!, marker, nativeAnthropic);
  }

  return messages as Array<Record<string, unknown>>;
}
