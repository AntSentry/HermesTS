// Ported from hermes_state.py:2035-2086 (_sanitize_fts5_query).

export function _sanitizeFts5Query(query: string): string {
  // Step 1: Extract balanced double-quoted phrases and protect them via
  // placeholders so subsequent steps don't strip their special chars.
  const quotedParts: string[] = [];
  let sanitized = query.replace(/"[^"]*"/g, (match) => {
    quotedParts.push(match);
    return `\x00Q${quotedParts.length - 1}\x00`;
  });

  // Step 2: Strip remaining (unmatched) FTS5-special characters.
  // Python: re.sub(r'[+{}()\"^]', " ", sanitized)
  sanitized = sanitized.replace(/[+{}()"^]/g, " ");

  // Step 3: Collapse repeated * (e.g. "***") into a single one, and
  // remove leading * (prefix-only needs at least one char before *).
  sanitized = sanitized.replace(/\*+/g, "*");
  sanitized = sanitized.replace(/(^|\s)\*/g, "$1");

  // Step 4: Remove dangling boolean operators at start/end that would
  // cause FTS5 syntax errors (e.g. "hello AND" or "OR world"). Python
  // applies .strip() before each substitution.
  sanitized = sanitized.trim().replace(/^(AND|OR|NOT)\b\s*/i, "");
  sanitized = sanitized.trim().replace(/\s+(AND|OR|NOT)\s*$/i, "");

  // Step 5: Wrap unquoted dotted, hyphenated, and underscored terms in
  // double quotes. FTS5's tokenizer splits on those, turning chat-send
  // into chat AND send.  A single pass avoids the double-quoting bug
  // that would happen if the patterns were applied sequentially.
  // Python: re.sub(r"\b(\w+(?:[._-]\w+)+)\b", r'"\1"', sanitized)
  // JS \w mirrors Python's [A-Za-z0-9_] under default re flags (no re.UNICODE).
  sanitized = sanitized.replace(/\b(\w+(?:[._-]\w+)+)\b/g, '"$1"');

  // Step 6: Restore preserved quoted phrases.
  for (let i = 0; i < quotedParts.length; i++) {
    /* v8 ignore next */ // i is bounded by quotedParts.length so quotedParts[i] is always defined; ?? "" is defensive for TS noUncheckedIndexedAccess.
    sanitized = sanitized.replace(`\x00Q${i}\x00`, quotedParts[i] ?? "");
  }

  return sanitized.trim();
}
