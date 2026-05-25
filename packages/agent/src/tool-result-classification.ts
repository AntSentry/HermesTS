/**
 * Shared helpers for classifying tool result payloads.
 *
 * Faithful port of upstream `agent/tool_result_classification.py`.
 */

/** Tools whose successful results prove a file was written. */
export const FILE_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(["write_file", "patch"]);

/**
 * Return `true` when a file-mutation tool result proves the write landed.
 *
 * Mirrors upstream `file_mutation_result_landed(tool_name, result)`:
 *   - Tool must be in `FILE_MUTATING_TOOL_NAMES`.
 *   - Result must be a non-empty JSON string.
 *   - Parsed JSON must be an object without an `error` field.
 *   - For `write_file`: must include a `bytes_written` field.
 *   - For `patch`: must report `success === true`.
 */
export function fileMutationResultLanded(toolName: string, result: unknown): boolean {
  if (!FILE_MUTATING_TOOL_NAMES.has(toolName) || typeof result !== "string") {
    return false;
  }

  let data: unknown;
  try {
    data = JSON.parse(result.trim());
  } catch {
    return false;
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  if (obj.error) {
    return false;
  }
  if (toolName === "write_file") {
    return "bytes_written" in obj;
  }
  // `toolName` is constrained to FILE_MUTATING_TOOL_NAMES by the guard
  // above, so the only remaining case is "patch".
  return obj.success === true;
}
