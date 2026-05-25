// Ported from tests/agent/test_subdirectory_hints.py

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SubdirectoryHintTracker, setContextScanner } from "../src/subdirectory-hints.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hermests-sub-"));
  setContextScanner(null);
});

afterEach(() => {
  setContextScanner(null);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("SubdirectoryHintTracker", () => {
  test("returns null when no hint files found in path arg", () => {
    const subdir = join(root, "src");
    mkdirSync(subdir);
    const tracker = new SubdirectoryHintTracker(root);
    expect(tracker.checkToolCall("read_file", { path: join(subdir, "main.ts") })).toBe(null);
  });

  test("loads AGENTS.md from the file's parent directory", () => {
    const sub = join(root, "backend");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "do the backend thing");
    const tracker = new SubdirectoryHintTracker(root);
    const hints = tracker.checkToolCall("read_file", { path: join(sub, "main.py") });
    expect(hints).not.toBe(null);
    expect(hints).toContain("Subdirectory context discovered");
    expect(hints).toContain("do the backend thing");
  });

  test("relative path argument is resolved against working dir", () => {
    const sub = join(root, "rel");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "rel ctx");
    const tracker = new SubdirectoryHintTracker(root);
    // Path is relative — exercises the !isAbsolute branch in addPathCandidate.
    const hints = tracker.checkToolCall("read_file", { path: "rel/main.py" });
    expect(hints).toContain("rel ctx");
  });

  test("walks ancestors when no hint in immediate dir", () => {
    const subA = join(root, "a");
    mkdirSync(subA, { recursive: true });
    writeFileSync(join(subA, "AGENTS.md"), "intermediate context");
    const deep = join(subA, "b", "c");
    mkdirSync(deep, { recursive: true });
    const tracker = new SubdirectoryHintTracker(root);
    const hints = tracker.checkToolCall("read_file", { path: join(deep, "x.ts") });
    expect(hints).not.toBe(null);
    expect(hints).toContain("intermediate context");
  });

  test("working-dir hints are pre-loaded and not returned again", () => {
    writeFileSync(join(root, "AGENTS.md"), "wd context");
    const tracker = new SubdirectoryHintTracker(root);
    // Reading a file in the working dir should not surface its AGENTS.md
    // (because the wd is pre-marked as loaded).
    expect(tracker.checkToolCall("read_file", { path: join(root, "main.py") })).toBe(null);
  });

  test("second tool call for same directory returns null (cached)", () => {
    const sub = join(root, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "ctx");
    const tracker = new SubdirectoryHintTracker(root);
    expect(tracker.checkToolCall("read_file", { path: join(sub, "a") })).not.toBe(null);
    expect(tracker.checkToolCall("read_file", { path: join(sub, "b") })).toBe(null);
  });

  test("supports file_path and workdir argument keys", () => {
    const sub = join(root, "x");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "x ctx");
    const t1 = new SubdirectoryHintTracker(root);
    expect(t1.checkToolCall("read_file", { file_path: join(sub, "f") })).not.toBe(null);

    const sub2 = join(root, "y");
    mkdirSync(sub2);
    writeFileSync(join(sub2, "AGENTS.md"), "y ctx");
    const t2 = new SubdirectoryHintTracker(root);
    expect(t2.checkToolCall("terminal", { workdir: sub2 })).not.toBe(null);
  });

  test("terminal tool extracts path tokens from command", () => {
    const sub = join(root, "z");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "z ctx");
    const tracker = new SubdirectoryHintTracker(root);
    const cmd = `cat ${join(sub, "file.txt")}`;
    expect(tracker.checkToolCall("terminal", { command: cmd })).not.toBe(null);
  });

  test("terminal tool ignores flags", () => {
    const tracker = new SubdirectoryHintTracker(root);
    expect(tracker.checkToolCall("terminal", { command: "ls -la --color=auto" })).toBe(null);
  });

  test("terminal tool ignores URL tokens", () => {
    const tracker = new SubdirectoryHintTracker(root);
    expect(tracker.checkToolCall("terminal", { command: "curl https://example.com" })).toBe(null);
  });

  test("whitespace-split path extraction works for quoted-style commands too", () => {
    const sub = join(root, "q");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "q ctx");
    const tracker = new SubdirectoryHintTracker(root);
    const cmd = `cat ${join(sub, "f.txt")}`;
    expect(tracker.checkToolCall("terminal", { command: cmd })).not.toBe(null);
  });

  test("respects HINT_FILENAMES priority — AGENTS.md wins over CLAUDE.md", () => {
    const sub = join(root, "p");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "agents wins");
    writeFileSync(join(sub, "CLAUDE.md"), "claude loses");
    const tracker = new SubdirectoryHintTracker(root);
    const hints = tracker.checkToolCall("read_file", { path: join(sub, "main.ts") });
    expect(hints).toContain("agents wins");
    expect(hints).not.toContain("claude loses");
  });

  test("truncates oversize hint files", () => {
    const sub = join(root, "big");
    mkdirSync(sub);
    const huge = "x".repeat(20_000);
    writeFileSync(join(sub, "AGENTS.md"), huge);
    const tracker = new SubdirectoryHintTracker(root);
    const hints = tracker.checkToolCall("read_file", { path: join(sub, "f.ts") });
    expect(hints).toContain("[...truncated AGENTS.md:");
  });

  test("empty hint files are skipped", () => {
    const sub = join(root, "e");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "   \n\n");
    const tracker = new SubdirectoryHintTracker(root);
    expect(tracker.checkToolCall("read_file", { path: join(sub, "f") })).toBe(null);
  });

  test("default scanner (no override) returns content unchanged", () => {
    // Default scanner is set in beforeEach via setContextScanner(null).
    // Exercise the identity arrow function via a real hint discovery.
    const sub = join(root, "raw");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "raw content");
    const tracker = new SubdirectoryHintTracker(root);
    const hints = tracker.checkToolCall("read_file", { path: join(sub, "f.ts") });
    expect(hints).toContain("raw content");
  });

  test("calls into the injected context scanner", () => {
    const captured: { content: string; filename: string }[] = [];
    setContextScanner((content, filename) => {
      captured.push({ content, filename });
      return `[scanned] ${content}`;
    });
    const sub = join(root, "scan");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "raw");
    const tracker = new SubdirectoryHintTracker(root);
    const hints = tracker.checkToolCall("read_file", { path: join(sub, "f.ts") });
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.filename).toBe("AGENTS.md");
    expect(hints).toContain("[scanned] raw");
  });

  test("non-string args are ignored", () => {
    const tracker = new SubdirectoryHintTracker(root);
    expect(tracker.checkToolCall("read_file", { path: 42 as unknown as string })).toBe(null);
  });

  test("non-existent ancestor inside working dir returns null", () => {
    // Use a path under the test root so we don't pick up CLAUDE.md
    // files higher in the test machine's filesystem.
    const tracker = new SubdirectoryHintTracker(root);
    expect(
      tracker.checkToolCall("read_file", { path: join(root, "does-not-exist", "file.ts") }),
    ).toBe(null);
  });

  test("returns null when all extracted dirs already loaded", () => {
    const tracker = new SubdirectoryHintTracker(root);
    // No subdir hints + working dir already loaded.
    expect(tracker.checkToolCall("read_file", { path: root })).toBe(null);
  });

  test("default working dir uses process.cwd()", () => {
    const tracker = new SubdirectoryHintTracker();
    expect(tracker.workingDir).toBe(process.cwd());
  });

  test("~/ expansion routes through homedir before checking ancestors", () => {
    // Just verify the expansion doesn't throw. The return value depends
    // on whether the test machine has AGENTS.md / CLAUDE.md files in
    // the user's actual home — we can't control that.
    const tracker = new SubdirectoryHintTracker(root);
    const result = tracker.checkToolCall("read_file", { path: "~/never-exists-12345" });
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("contextScanner read failure is logged but does not throw", () => {
    const sub = join(root, "r");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "ok");
    setContextScanner(() => {
      throw new Error("scanner exploded");
    });
    const tracker = new SubdirectoryHintTracker(root);
    // The exception is caught inside the read loop — call returns null
    // because no hints survived the scanner throw.
    expect(tracker.checkToolCall("read_file", { path: join(sub, "f") })).toBe(null);
  });

  test("checkToolCall with no path args returns null", () => {
    const tracker = new SubdirectoryHintTracker(root);
    expect(tracker.checkToolCall("read_file", {})).toBe(null);
  });
});
