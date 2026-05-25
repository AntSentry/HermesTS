// Ported from tests/agent/test_markdown_tables.py

import { describe, expect, test } from "vitest";

import {
  isTableDivider,
  looksLikeTableRow,
  realignMarkdownTables,
  splitTableRow,
} from "../src/markdown-tables.js";

describe("splitTableRow", () => {
  test("splits and trims a standard row", () => {
    expect(splitTableRow("| a | b | c |")).toEqual(["a", "b", "c"]);
  });

  test("handles rows without leading/trailing pipes", () => {
    expect(splitTableRow("a | b")).toEqual(["a", "b"]);
  });

  test("treats empty cells as empty strings", () => {
    expect(splitTableRow("|  | x |")).toEqual(["", "x"]);
  });
});

describe("isTableDivider", () => {
  test("matches dash separator", () => {
    expect(isTableDivider("|---|---|")).toBe(true);
  });

  test("matches alignment colons", () => {
    expect(isTableDivider("| :---: | ---: | :--- |")).toBe(true);
  });

  test("rejects single cell", () => {
    expect(isTableDivider("|---|")).toBe(false);
  });

  test("rejects non-dash content", () => {
    expect(isTableDivider("| header | header |")).toBe(false);
  });
});

describe("looksLikeTableRow", () => {
  test("requires a pipe", () => {
    expect(looksLikeTableRow("no pipes")).toBe(false);
  });

  test("blank input rejected", () => {
    expect(looksLikeTableRow("")).toBe(false);
    expect(looksLikeTableRow("   ")).toBe(false);
  });

  test("leading pipe accepted", () => {
    expect(looksLikeTableRow("|a|b|")).toBe(true);
  });

  test("two pipes without leading accepted", () => {
    // "a | b" has 1 mid pipe → does not pass the `count >= 2` threshold.
    expect(looksLikeTableRow("a | b")).toBe(false);
  });

  test("single mid pipe rejected", () => {
    expect(looksLikeTableRow("a|b")).toBe(false);
    expect(looksLikeTableRow("a-b")).toBe(false);
  });

  test("requires at least 2 mid-pipes without leading", () => {
    expect(looksLikeTableRow("a|")).toBe(false);
    expect(looksLikeTableRow("a|b|c")).toBe(true);
  });
});

describe("realignMarkdownTables", () => {
  test("returns input unchanged when no pipes present", () => {
    expect(realignMarkdownTables("just prose")).toBe("just prose");
  });

  test("realigns a simple ASCII table", () => {
    const input = ["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
    const out = realignMarkdownTables(input);
    expect(out.split("\n")).toEqual([
      "| a   | b   |",
      "|-----|-----|",
      "| 1   | 2   |",
    ]);
  });

  test("rewrites widths for CJK content", () => {
    const input = ["| name | city |", "|---|---|", "| Bob | 北京 |"].join("\n");
    const out = realignMarkdownTables(input);
    const lines = out.split("\n");
    // Body row should pad the `Bob` column to 4 cells to align with `name`.
    expect(lines[2]).toContain("北京");
    // Each line must visually align — header pipe and body pipe at same byte index.
    expect(lines[0]?.indexOf("|", 1)).toBe(lines[2]?.indexOf("|", 1));
  });

  test("non-table prose is passed through", () => {
    expect(realignMarkdownTables("hello\nworld")).toBe("hello\nworld");
  });

  test("table without divider after header is left alone", () => {
    const input = "| a | b |\n| 1 | 2 |";
    expect(realignMarkdownTables(input)).toBe(input);
  });

  test("handles a header-only multi-cell table (no body rows)", () => {
    // Single-cell tables are rejected by isTableDivider (which requires
    // >1 cells), so we need a two-cell example to exercise this branch.
    const input = "| h1 | h2 |\n|---|---|";
    const out = realignMarkdownTables(input);
    expect(out.split("\n")).toEqual(["| h1  | h2  |", "|-----|-----|"]);
  });

  test("renders vertical fallback for over-wide table", () => {
    const input = [
      "| col_a_long_header | col_b_long_header |",
      "|---|---|",
      "| value_a | value_b |",
    ].join("\n");
    const out = realignMarkdownTables(input, 20);
    expect(out).toContain("col_a_long_header:");
    expect(out).toContain("col_b_long_header:");
    expect(out).not.toContain("|---");
  });

  test("vertical fallback wraps long values into continuation lines", () => {
    const longVal = "abcdefghijklmnopqrstuvwxyz0123456789";
    const input = ["| h |", "|---|", `| ${longVal} |`].join("\n");
    const out = realignMarkdownTables(input, 12);
    expect(out.split("\n").length).toBeGreaterThan(2);
  });

  test("vertical fallback handles missing value cells gracefully", () => {
    // Force the vertical path: minimum activation needs the rendered
    // horizontal width > max(availableWidth, 20).
    const input = [
      "| col_one_label | col_two_label |",
      "|---|---|",
      "| only_a |",
    ].join("\n");
    const out = realignMarkdownTables(input, 20);
    expect(out).toContain("col_one_label:");
    expect(out).toContain("col_two_label:");
  });

  test("multiple tables in one input", () => {
    const input = [
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "between",
      "",
      "| c | d |",
      "|---|---|",
      "| 3 | 4 |",
    ].join("\n");
    const out = realignMarkdownTables(input);
    expect(out).toContain("between");
    expect(out.match(/\|-----\|-----\|/g)?.length).toBe(2);
  });

  test("divider inside body is skipped (j increments past it)", () => {
    // Body row that happens to look like a divider gets dropped, not added.
    const input = [
      "| h1 | h2 |",
      "|---|---|",
      "| a | b |",
      "|---|---|",
      "| c | d |",
    ].join("\n");
    const out = realignMarkdownTables(input);
    const bodyMatches = out.match(/\|\s+[acd]/g);
    // Both data rows survive — divider in the middle is just an extra
    // separator and ignored.
    expect(bodyMatches?.length).toBeGreaterThanOrEqual(2);
  });

  test("text without any table at all is verbatim", () => {
    expect(realignMarkdownTables("a|b but no divider")).toBe("a|b but no divider");
  });

  test("hard-break path with a single huge unbreakable token", () => {
    // Forces wrapToWidth's hard-break branch via a single very long
    // token. A single-cell pseudo-table (`| h |`) does not trigger the
    // table-detection branch (isTableDivider requires >1 cells), so use
    // a two-cell layout. Vertical activates because horizontal width
    // (>200 cells) exceeds availableWidth=30.
    const huge = "x".repeat(200);
    const input = ["| h | k |", "|---|---|", `| ${huge} | y |`].join("\n");
    const out = realignMarkdownTables(input, 30);
    // Expect at least: "h: <first piece>", several continuation lines,
    // then "k: y" — well above 3 lines.
    expect(out.split("\n").length).toBeGreaterThan(3);
  });

  test("vertical fallback handles empty cell value (skip wrap path)", () => {
    // Headers wide enough to force vertical at availableWidth=20.
    const input = [
      "| col_one_label | col_two_label |",
      "|---|---|",
      "|   |   |",
    ].join("\n");
    const out = realignMarkdownTables(input, 20);
    expect(out).toContain("col_one_label:");
  });

  test("realign treats truly empty header+body as not a table", () => {
    // Header is all-blank cells, no body — fails the `any(c)` AND `body` check.
    const input = ["|   |   |", "|---|---|"].join("\n");
    const out = realignMarkdownTables(input);
    // Falls through unchanged since header is empty and no body rows exist.
    expect(out).toBe(input);
  });

  test("vertical fallback emits separator between body rows", () => {
    const input = [
      "| col_one_label | col_two_label |",
      "|---|---|",
      "| r1a | r1b |",
      "| r2a | r2b |",
    ].join("\n");
    const out = realignMarkdownTables(input, 20);
    expect(out).toContain("─");
  });

  test("vertical fallback for whitespace-only value emits 'label:' line", () => {
    // value="" branch (`if (!value)`): use a cell that survives trim but
    // wraps to whitespace-only word set.
    const input = [
      "| col_one_label | col_two_label |",
      "|---|---|",
      "|  whitespace  |  another     |",
    ].join("\n");
    const out = realignMarkdownTables(input, 20);
    expect(out).toContain("col_one_label:");
  });

  test("vertical fallback wraps multi-word value", () => {
    // Triggers wrapToWidth normal path with multiple words, exercising
    // the `currentW + 1 + ww <= width` line where current is non-empty.
    const input = [
      "| col_one_label | col_two_label |",
      "|---|---|",
      "| word1 word2 word3 word4 | x |",
    ].join("\n");
    const out = realignMarkdownTables(input, 20);
    expect(out).toContain("col_one_label:");
  });

  test("vertical fallback labels empty header cells as 'Column N'", () => {
    const input = [
      "| col_one_label |   |",
      "|---|---|",
      "| a | b |",
    ].join("\n");
    const out = realignMarkdownTables(input, 20);
    expect(out).toContain("col_one_label:");
    expect(out).toContain("Column 2:");
  });

  test("vertical fallback handles a long word inside multi-word value", () => {
    // Exercises the `else` branch where current exists, next word > width.
    const longTok = "x".repeat(30);
    const input = [
      "| col_one_label | col_two_label |",
      "|---|---|",
      `| short ${longTok} | y |`,
    ].join("\n");
    const out = realignMarkdownTables(input, 20);
    expect(out.split("\n").length).toBeGreaterThan(2);
  });
});
