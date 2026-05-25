/**
 * Translates chat.completions multimodal content into Codex Responses API
 * format. Faithful port of lines 575-626 of upstream
 * `agent/auxiliary_client.py`.
 *
 * chat.completions wire:
 *   {"type": "text", "text": "..."}
 *   {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
 *
 * Responses API wire:
 *   {"type": "input_text", "text": "..."}
 *   {"type": "input_image", "image_url": "data:image/png;base64,..."}
 */

import type { OpenAIContentPart, OpenAIMessageContent } from "../_internal/openai-client-shape.js";

/** Output shape used by the Responses API for content items. */
export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }
  | OpenAIContentPart;

/**
 * Result of `convertContentForResponses`. When upstream returned a plain
 * string it's preserved verbatim; otherwise we return a list of converted
 * parts. An empty list collapses to `""` to mirror upstream
 * `converted or ""`.
 */
export type ConvertedContent = string | ResponsesContentPart[];

/**
 * Convert chat.completions content to Responses API format. Faithful to
 * `_convert_content_for_responses` (py:L581-626).
 *
 * - Plain strings pass through unchanged (Responses API accepts strings
 *   directly for text-only messages).
 * - Non-list/non-string inputs collapse to `str(content) if content else ""`.
 * - `{"type": "text", "text": ...}` → `{"type": "input_text", "text": ...}`.
 * - `{"type": "image_url", "image_url": ...}` flattens the nested
 *   `{url, detail}` object into the Responses-style `image_url` string plus
 *   optional `detail`. Bare string `image_url` (rare but accepted upstream)
 *   is preserved.
 * - Items already in Responses shape (`input_text`, `input_image`) pass through.
 * - Unknown part types attempt to preserve their `text` field; otherwise
 *   they are dropped.
 * - An empty result list collapses to the empty string.
 */
export function convertContentForResponses(
  content: OpenAIMessageContent | unknown,
): ConvertedContent {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    if (
      content === null ||
      content === undefined ||
      content === false ||
      content === 0 ||
      content === ""
    ) {
      return "";
    }
    return String(content);
  }

  const converted: ResponsesContentPart[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") {
      continue;
    }
    const partRecord = part as Record<string, unknown>;
    const ptype = String(partRecord.type ?? "");
    if (ptype === "text") {
      converted.push({ type: "input_text", text: String(partRecord.text ?? "") });
    } else if (ptype === "image_url") {
      // chat.completions nests the URL: {"image_url": {"url": "..."}}
      const imageData = partRecord.image_url;
      let url = "";
      let detail: string | undefined;
      if (imageData !== null && typeof imageData === "object") {
        const imageRecord = imageData as Record<string, unknown>;
        url = String(imageRecord.url ?? "");
        // Upstream uses Python-truthy `if detail:` — empty string, null,
        // undefined, 0, false all skip the assignment.
        const d = imageRecord.detail;
        if (d !== null && d !== undefined && d !== "" && d !== false && d !== 0) {
          detail = String(d);
        }
      } else {
        url = String(imageData ?? "");
      }
      const entry: { type: "input_image"; image_url: string; detail?: string } = {
        type: "input_image",
        image_url: url,
      };
      if (detail !== undefined) {
        entry.detail = detail;
      }
      converted.push(entry);
    } else if (ptype === "input_text" || ptype === "input_image") {
      // Already in Responses format — pass through.
      converted.push(part as ResponsesContentPart);
    } else {
      // Unknown content type — try to preserve as text. Upstream guards with
      // Python-truthy `if text:`, so empty-string / null / 0 / False are
      // all dropped before the push.
      const rawText = partRecord.text;
      if (
        rawText !== null &&
        rawText !== undefined &&
        rawText !== "" &&
        rawText !== false &&
        rawText !== 0
      ) {
        converted.push({ type: "input_text", text: String(rawText) });
      }
    }
  }

  return converted.length > 0 ? converted : "";
}
