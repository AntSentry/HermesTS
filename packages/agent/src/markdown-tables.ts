/**
 * CJK/wide-character-aware re-alignment of model-emitted markdown tables.
 *
 * Faithful port of upstream `agent/markdown_tables.py`.
 *
 * Models pad markdown tables assuming each character occupies one
 * terminal cell. CJK glyphs and most emoji render as two cells, so the
 * model's spacing collapses into drift the moment a table reaches a
 * real terminal. This module rebuilds row padding using display
 * columns (via `string-width`, the JS equivalent of `wcwidth`).
 *
 * Faithful divergence:
 *   - Upstream uses `from wcwidth import wcswidth`. The TS equivalent
 *     is the `string-width` npm package, which also returns 0 for
 *     control chars and handles emoji variation selectors correctly.
 *     Upstream documents the `wcwidth` returns -1 case and clamps to
 *     0 — `string-width` already returns a non-negative integer, so
 *     the clamp is unnecessary but kept for parity.
 */

import stringWidth from "string-width";

const DIVIDER_CELL_RE = /^\s*:?-{3,}:?\s*$/;
const MIN_COL_WIDTH = 3;

function dispWidth(s: string): number {
  const w = stringWidth(s);
  return w > 0 ? w : 0;
}

function padToWidth(s: string, target: number): string {
  return s + " ".repeat(Math.max(0, target - dispWidth(s)));
}

/** Split `| a | b | c |` into `["a", "b", "c"]` with trims. */
export function splitTableRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) {
    s = s.slice(1);
  }
  if (s.endsWith("|")) {
    s = s.slice(0, -1);
  }
  return s.split("|").map((c) => c.trim());
}

/** True when `row` is a markdown table separator line. */
export function isTableDivider(row: string): boolean {
  const cells = splitTableRow(row);
  if (cells.length <= 1) {
    return false;
  }
  for (const c of cells) {
    if (!DIVIDER_CELL_RE.test(c)) {
      return false;
    }
  }
  return true;
}

/**
 * True when `row` could plausibly be a markdown table row. Permissive
 * by design — the realigner only rewrites blocks accompanied by a
 * divider, so false positives here at worst delay one streamed line.
 */
export function looksLikeTableRow(row: string): boolean {
  if (!row.includes("|")) {
    return false;
  }
  // A `|` in the string implies trim() is non-empty.
  const stripped = row.trim();
  if (stripped.startsWith("|")) {
    return true;
  }
  let count = 0;
  for (const ch of stripped) {
    if (ch === "|") {
      count += 1;
      if (count >= 2) {
        return true;
      }
    }
  }
  return false;
}

function renderBlock(rows: string[][], availableWidth: number | null): string[] {
  const ncols = Math.max(...rows.map((r) => r.length));
  const normalized = rows.map((r) => {
    if (r.length === ncols) return r;
    return [...r, ...Array<string>(ncols - r.length).fill("")];
  });

  const widths: number[] = [];
  for (let c = 0; c < ncols; c += 1) {
    let maxW = MIN_COL_WIDTH;
    for (const r of normalized) {
      // r is padded to length === ncols above, so r[c] is always defined.
      const w = dispWidth(r[c]!);
      if (w > maxW) {
        maxW = w;
      }
    }
    widths.push(maxW);
  }

  const horizontalWidth = widths.reduce((a, b) => a + b, 0) + 3 * ncols + 1;

  if (availableWidth !== null && horizontalWidth > Math.max(availableWidth, 20)) {
    return renderVertical(normalized, ncols, availableWidth);
  }

  const renderRow = (cells: string[]): string => {
    const padded = cells.map((c, k) => padToWidth(c, widths[k]!));
    return `| ${padded.join(" | ")} |`;
  };

  const out: string[] = [];
  out.push(renderRow(normalized[0]!));
  out.push(`|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);
  for (let i = 1; i < normalized.length; i += 1) {
    out.push(renderRow(normalized[i]!));
  }
  return out;
}

/**
 * Soft-wrap `text` at word boundaries to fit `width` display cells.
 *
 * Falls back to hard-breaking the longest word if a single token is
 * wider than `width`. Empty input yields a single empty string so the
 * caller's row count stays predictable.
 */
function wrapToWidth(text: string, width: number): string[] {
  // Callers guarantee text is non-empty and post-trim (cells go through
  // splitTableRow's `.trim()` on the way in), and width >= 10
  // (renderVertical clamps firstBudget/contBudget at 10). The upstream
  // `width <= 0 or not text` short-circuit + the empty-words branch are
  // therefore dead at this call site.
  const words = text.split(/\s+/).filter((w) => w.length > 0);

  const hardBreak = (word: string, w: number): string[] => {
    const out: string[] = [];
    let buf = "";
    let bw = 0;
    for (const ch of word) {
      // string-width returns 1+ for printable chars; words at this
      // call site come from `text.split(/\s+/)` so every char is
      // printable, no zero-width clamp needed.
      const cw = dispWidth(ch);
      if (bw + cw > w && buf) {
        out.push(buf);
        buf = ch;
        bw = cw;
      } else {
        buf += ch;
        bw += cw;
      }
    }
    if (buf) {
      out.push(buf);
    }
    return out;
  };

  const lines: string[] = [];
  let current = "";
  let currentW = 0;

  for (const word of words) {
    const ww = dispWidth(word);
    if (!current) {
      if (ww <= width) {
        current = word;
        currentW = ww;
      } else {
        const pieces = hardBreak(word, width);
        lines.push(...pieces.slice(0, -1));
        // hardBreak always returns ≥1 piece for a non-empty word.
        current = pieces[pieces.length - 1]!;
        currentW = dispWidth(current);
      }
      continue;
    }
    if (currentW + 1 + ww <= width) {
      current += ` ${word}`;
      currentW += 1 + ww;
    } else {
      lines.push(current);
      if (ww <= width) {
        current = word;
        currentW = ww;
      } else {
        const pieces = hardBreak(word, width);
        lines.push(...pieces.slice(0, -1));
        // hardBreak always returns ≥1 piece for a non-empty word.
        current = pieces[pieces.length - 1]!;
        currentW = dispWidth(current);
      }
    }
  }
  if (current) {
    lines.push(current);
  }
  // words.length >= 1 plus the trailing `if (current) push` guarantee
  // lines.length >= 1 — no `[""]` fallback needed.
  return lines;
}

function renderVertical(rows: string[][], ncols: number, availableWidth: number): string[] {
  // renderBlock only calls us with rows.length >= 1 (header row).
  const headers = [...rows[0]!, ...Array<string>(Math.max(0, ncols - rows[0]!.length)).fill("")];
  const body = rows.slice(1);

  const labels = headers.map((h, i) => h || `Column ${i + 1}`);

  const sepWidth = Math.max(20, Math.min(40, availableWidth - 2));
  const separator = "─".repeat(sepWidth);
  const indent = "  ";
  const indentW = dispWidth(indent);

  const out: string[] = [];
  for (let ri = 0; ri < body.length; ri += 1) {
    if (ri > 0) {
      out.push(separator);
    }
    const row = body[ri]!;
    for (let ci = 0; ci < ncols; ci += 1) {
      const label = labels[ci]!;
      // renderBlock normalizes every row to length === ncols, so the
      // header-pad-shorter-body case is already handled before we get here.
      const value = row[ci]!;
      const labelW = dispWidth(label);
      const firstBudget = Math.max(10, availableWidth - labelW - 2);
      const contBudget = Math.max(10, availableWidth - indentW);
      if (!value) {
        out.push(`${label}:`);
        continue;
      }
      // wrapToWidth never returns an empty array for non-empty input.
      const wrapped = wrapToWidth(value, firstBudget);
      out.push(`${label}: ${wrapped[0]!}`);
      if (wrapped.length > 1) {
        const contText = wrapped.slice(1).join(" ");
        for (const cl of wrapToWidth(contText, contBudget)) {
          if (cl.trim()) {
            out.push(`${indent}${cl}`);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Rewrite every `| ... |` + divider block with wcwidth-aware padding.
 *
 * Lines that are not part of a recognised table are returned verbatim,
 * so this is safe to apply to arbitrary assistant prose.
 *
 * If `availableWidth` is given (terminal cells available for the
 * rendered table), tables wider than that are rendered as vertical
 * key-value pairs instead of a horizontal pipe-bordered grid.
 */
export function realignMarkdownTables(text: string, availableWidth: number | null = null): string {
  if (!text.includes("|")) {
    return text;
  }

  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i]!;
    if (line.includes("|") && i + 1 < n && isTableDivider(lines[i + 1]!)) {
      const header = splitTableRow(line);
      const body: string[][] = [];
      let j = i + 2;
      while (j < n && lines[j]!.includes("|") && lines[j]!.trim()) {
        if (isTableDivider(lines[j]!)) {
          j += 1;
          continue;
        }
        body.push(splitTableRow(lines[j]!));
        j += 1;
      }

      if (header.some((c) => c.length > 0) || body.length > 0) {
        out.push(...renderBlock([header, ...body], availableWidth));
        i = j;
        continue;
      }
    }
    out.push(line);
    i += 1;
  }

  return out.join("\n");
}
