/**
 * Trajectory saving utilities and static helpers.
 *
 * Faithful port of upstream `agent/trajectory.py`.
 *
 * `_convert_to_trajectory_format` stays as an AIAgent method (the
 * integrators package owns that), this module covers the static helpers
 * and the file-write logic.
 */

import { appendFile } from "node:fs/promises";

import { getLogger } from "@hermests/core";

const logger = getLogger("agent.trajectory");

/** Convert `<REASONING_SCRATCHPAD>` tags to `<think>` tags. */
export function convertScratchpadToThink(content: string): string {
  if (!content || !content.includes("<REASONING_SCRATCHPAD>")) {
    return content;
  }
  return content
    .replaceAll("<REASONING_SCRATCHPAD>", "<think>")
    .replaceAll("</REASONING_SCRATCHPAD>", "</think>");
}

/**
 * Check if content has an opening `<REASONING_SCRATCHPAD>` without a
 * matching closing tag.
 */
export function hasIncompleteScratchpad(content: string): boolean {
  if (!content) {
    return false;
  }
  return content.includes("<REASONING_SCRATCHPAD>") && !content.includes("</REASONING_SCRATCHPAD>");
}

/** Shape of one entry written to the trajectory JSONL file. */
export interface TrajectoryEntry {
  conversations: ReadonlyArray<Record<string, unknown>>;
  timestamp: string;
  model: string;
  completed: boolean;
}

/**
 * Append a trajectory entry to a JSONL file.
 *
 * `filename` defaults to `trajectory_samples.jsonl` for completed
 * conversations and `failed_trajectories.jsonl` otherwise.
 *
 * Errors are logged at WARNING — matches upstream's
 * `logger.warning("Failed to save trajectory: %s", e)`.
 */
export async function saveTrajectory(
  trajectory: ReadonlyArray<Record<string, unknown>>,
  model: string,
  completed: boolean,
  filename: string | null = null,
): Promise<void> {
  const target = filename ?? (completed ? "trajectory_samples.jsonl" : "failed_trajectories.jsonl");

  const entry: TrajectoryEntry = {
    conversations: trajectory,
    timestamp: new Date().toISOString(),
    model,
    completed,
  };

  try {
    // Match Python's `json.dumps(..., ensure_ascii=False)` — JS
    // JSON.stringify is already non-ASCII-preserving by default.
    await appendFile(target, `${JSON.stringify(entry)}\n`, "utf-8");
    logger.info(`Trajectory saved to ${target}`);
  } catch (exc) {
    // `fs.appendFile` only rejects with Error instances.
    logger.warning(`Failed to save trajectory: ${(exc as Error).message}`);
  }
}
