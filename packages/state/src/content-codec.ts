// Ported from hermes_state.py:1407-1446 (_encode_content / _decode_content).
import { getLogger } from "@hermests/core";

const logger = getLogger("hermes_state");

// Sentinel prefix to distinguish JSON-encoded structured content from
// plain string content. NUL is not legal in normal text and cannot
// collide with real user content.
export const CONTENT_JSON_PREFIX = "\x00json:";

// SQLite (via better-sqlite3) can bind string | number | bigint | Buffer | null.
// We allow `unknown` in/out to mirror Python's "Any" surface for message
// content (which may be a string, dict, or list-of-parts in multimodal
// messages).
export type StoredContent = string | number | bigint | Buffer | null;

// Ported from hermes_state.py:1412-1432
export function _encodeContent(content: unknown): StoredContent {
  if (
    content === null ||
    content === undefined ||
    typeof content === "string" ||
    typeof content === "number" ||
    typeof content === "bigint" ||
    Buffer.isBuffer(content)
  ) {
    // None/null stored as NULL. undefined treated like None.
    return content === undefined
      ? null
      : (content as StoredContent);
  }
  try {
    return CONTENT_JSON_PREFIX + JSON.stringify(content);
  } catch {
    // Last-resort fallback: stringify so persistence never fails.
    return String(content);
  }
}

// Ported from hermes_state.py:1434-1446
export function _decodeContent(content: unknown): unknown {
  if (typeof content === "string" && content.startsWith(CONTENT_JSON_PREFIX)) {
    try {
      return JSON.parse(content.slice(CONTENT_JSON_PREFIX.length));
    } catch {
      logger.warning(
        "Failed to decode JSON-encoded message content; returning raw string",
      );
      return content;
    }
  }
  return content;
}
