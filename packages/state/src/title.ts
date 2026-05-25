// Ported from hermes_state.py:984-1028 (sanitize_title + MAX_TITLE_LENGTH).

export const MAX_TITLE_LENGTH = 100;

// Pre-compiled char ranges so the actual regex source stays plain ASCII —
// avoids TS source-file parsing pitfalls with RTL/LTR override codepoints.
// Mirrors hermes_state.py:1012-1015 exactly: U+200B-U+200F, U+2028-U+202E,
// U+2060-U+2069, U+FEFF, U+FFFC, U+FFF9-U+FFFB.
const _UNICODE_CONTROL_REGEX = new RegExp(
  "[" +
    "\\u200B-\\u200F" +
    "\\u2028-\\u202E" +
    "\\u2060-\\u2069" +
    "\\uFEFF" +
    "\\uFFFC" +
    "\\uFFF9-\\uFFFB" +
    "]",
  "g",
);

// Ported from hermes_state.py:986-1028
export function sanitizeTitle(title: string | null | undefined): string | null {
  if (!title) {
    return null;
  }

  // Strip ASCII control chars (0x00-0x1F, 0x7F) but keep whitespace chars
  // (\t \n \r) so the whitespace-collapsing step can normalise them.
  let cleaned = title.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

  // Strip problematic Unicode control characters (see _UNICODE_CONTROL_REGEX).
  cleaned = cleaned.replace(_UNICODE_CONTROL_REGEX, "");

  // Collapse internal whitespace runs and strip.
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (!cleaned) {
    return null;
  }

  if (cleaned.length > MAX_TITLE_LENGTH) {
    throw new RangeError(
      `Title too long (${cleaned.length} chars, max ${MAX_TITLE_LENGTH})`,
    );
  }

  return cleaned;
}
