// Ported from hermes_state.py:2089-2117 (CJK helpers).

// Ported from hermes_state.py:2089-2097
export function _isCjkCodepoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x20000 && cp <= 0x2a6df) || // CJK Extension B
    (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols
    (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
    (cp >= 0xac00 && cp <= 0xd7af) // Hangul Syllables
  );
}

// Ported from hermes_state.py:2099-2112
// Uses codePointAt to handle astral CJK Extension B correctly. Strings are
// iterated via for...of which yields full code points (not UTF-16 units).
export function _containsCjk(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    /* v8 ignore next */ // for...of always yields a string with a valid codePoint; defensive guard for TS narrowing only.
    if (cp === undefined) continue;
    if (_isCjkCodepoint(cp)) return true;
  }
  return false;
}

// Ported from hermes_state.py:2114-2117
export function _countCjk(text: string): number {
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && _isCjkCodepoint(cp)) count++;
  }
  return count;
}
