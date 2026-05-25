// Ported from tests/agent/test_tool_result_classification.py

import { describe, expect, test } from "vitest";

import {
  FILE_MUTATING_TOOL_NAMES,
  fileMutationResultLanded,
} from "../src/tool-result-classification.js";

describe("FILE_MUTATING_TOOL_NAMES", () => {
  test("contains exactly write_file and patch", () => {
    expect(FILE_MUTATING_TOOL_NAMES.has("write_file")).toBe(true);
    expect(FILE_MUTATING_TOOL_NAMES.has("patch")).toBe(true);
    expect(FILE_MUTATING_TOOL_NAMES.has("read_file")).toBe(false);
    expect(FILE_MUTATING_TOOL_NAMES.size).toBe(2);
  });
});

describe("fileMutationResultLanded", () => {
  test("write_file with bytes_written returns true", () => {
    expect(fileMutationResultLanded("write_file", '{"bytes_written": 42}')).toBe(true);
  });

  test("write_file without bytes_written returns false", () => {
    expect(fileMutationResultLanded("write_file", '{"ok": true}')).toBe(false);
  });

  test("patch with success true returns true", () => {
    expect(fileMutationResultLanded("patch", '{"success": true}')).toBe(true);
  });

  test("patch with success false returns false", () => {
    expect(fileMutationResultLanded("patch", '{"success": false}')).toBe(false);
  });

  test("patch missing success returns false", () => {
    expect(fileMutationResultLanded("patch", "{}")).toBe(false);
  });

  test("unknown tool name returns false", () => {
    expect(fileMutationResultLanded("read_file", '{"bytes_written": 1}')).toBe(false);
  });

  test("non-string result returns false", () => {
    expect(fileMutationResultLanded("write_file", { bytes_written: 1 })).toBe(false);
    expect(fileMutationResultLanded("write_file", 42)).toBe(false);
    expect(fileMutationResultLanded("write_file", null)).toBe(false);
    expect(fileMutationResultLanded("write_file", undefined)).toBe(false);
  });

  test("malformed JSON returns false", () => {
    expect(fileMutationResultLanded("write_file", "not json")).toBe(false);
    expect(fileMutationResultLanded("write_file", "{bad: json}")).toBe(false);
  });

  test("JSON with error field returns false even when fields present", () => {
    expect(
      fileMutationResultLanded("write_file", '{"bytes_written": 5, "error": "denied"}'),
    ).toBe(false);
    expect(fileMutationResultLanded("patch", '{"success": true, "error": "denied"}')).toBe(false);
  });

  test("JSON that is not an object returns false", () => {
    expect(fileMutationResultLanded("write_file", "[1,2,3]")).toBe(false);
    expect(fileMutationResultLanded("write_file", "42")).toBe(false);
    expect(fileMutationResultLanded("write_file", "null")).toBe(false);
    expect(fileMutationResultLanded("write_file", '"a string"')).toBe(false);
  });

  test("trims whitespace around JSON payload", () => {
    expect(fileMutationResultLanded("write_file", '  {"bytes_written": 1}  \n')).toBe(true);
  });

  test("known mutating tool with non-matching shape returns false (fallthrough)", () => {
    // Exercises the trailing `return false` after the toolName checks.
    expect(fileMutationResultLanded("write_file", '{"unrelated": true}')).toBe(false);
  });
});
