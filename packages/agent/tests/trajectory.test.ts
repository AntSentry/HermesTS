// Ported from upstream trajectory.py exercises (no dedicated upstream
// test file — `convert_to_trajectory_format` lives on the AIAgent
// orchestrator and is tested via run_agent integration tests).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  convertScratchpadToThink,
  hasIncompleteScratchpad,
  saveTrajectory,
} from "../src/trajectory.js";

describe("convertScratchpadToThink", () => {
  test("rewrites both open and close tags", () => {
    expect(
      convertScratchpadToThink("hello <REASONING_SCRATCHPAD>plan</REASONING_SCRATCHPAD> world"),
    ).toBe("hello <think>plan</think> world");
  });

  test("multiple occurrences are all replaced", () => {
    const input =
      "<REASONING_SCRATCHPAD>a</REASONING_SCRATCHPAD><REASONING_SCRATCHPAD>b</REASONING_SCRATCHPAD>";
    expect(convertScratchpadToThink(input)).toBe("<think>a</think><think>b</think>");
  });

  test("returns input when no scratchpad tag present", () => {
    expect(convertScratchpadToThink("plain text")).toBe("plain text");
    expect(convertScratchpadToThink("")).toBe("");
  });
});

describe("hasIncompleteScratchpad", () => {
  test("true when only opening tag present", () => {
    expect(hasIncompleteScratchpad("oh <REASONING_SCRATCHPAD> dear")).toBe(true);
  });

  test("false when both opening and closing present", () => {
    expect(
      hasIncompleteScratchpad("<REASONING_SCRATCHPAD>thinking</REASONING_SCRATCHPAD>"),
    ).toBe(false);
  });

  test("false when neither present", () => {
    expect(hasIncompleteScratchpad("plain")).toBe(false);
    expect(hasIncompleteScratchpad("")).toBe(false);
  });
});

describe("saveTrajectory", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hermests-traj-"));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("appends a JSONL entry with completed=true default filename", async () => {
    const file = join(tmp, "trajectory_samples.jsonl");
    process.chdir(tmp);
    try {
      await saveTrajectory([{ role: "user", value: "hi" }], "test-model", true);
      const text = readFileSync(file, "utf-8");
      const parsed = JSON.parse(text.trim());
      expect(parsed.model).toBe("test-model");
      expect(parsed.completed).toBe(true);
      expect(parsed.conversations).toEqual([{ role: "user", value: "hi" }]);
      expect(typeof parsed.timestamp).toBe("string");
    } finally {
      process.chdir("/");
    }
  });

  test("uses failed_trajectories.jsonl when completed=false", async () => {
    const file = join(tmp, "failed_trajectories.jsonl");
    process.chdir(tmp);
    try {
      await saveTrajectory([], "m", false);
      const text = readFileSync(file, "utf-8");
      const parsed = JSON.parse(text.trim());
      expect(parsed.completed).toBe(false);
    } finally {
      process.chdir("/");
    }
  });

  test("respects explicit filename override", async () => {
    const file = join(tmp, "custom.jsonl");
    await saveTrajectory([{ a: 1 }], "m", true, file);
    const text = readFileSync(file, "utf-8");
    expect(text).toContain('"a":1');
  });

  test("multiple writes append (one JSON object per line)", async () => {
    const file = join(tmp, "multi.jsonl");
    await saveTrajectory([{ a: 1 }], "m", true, file);
    await saveTrajectory([{ a: 2 }], "m", true, file);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).conversations).toEqual([{ a: 1 }]);
    expect(JSON.parse(lines[1]!).conversations).toEqual([{ a: 2 }]);
  });

  test("write failure is swallowed (no throw)", async () => {
    // Target a directory path — appendFile errors with EISDIR.
    await expect(saveTrajectory([], "m", true, tmp)).resolves.toBeUndefined();
  });

  test("NUL byte in path is handled in error path", async () => {
    const bad = join(tmp, "no\0way.jsonl");
    await expect(saveTrajectory([], "m", true, bad)).resolves.toBeUndefined();
  });
});
