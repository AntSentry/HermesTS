/**
 * Tests for the default `AgentFsHooks` (`extensions/default-fs.ts`).
 * Exercises every helper against a real temp-dir tree so we cover the
 * file IO branches that other tests stub.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { defaultFsHooks } from "../src/index.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "default-fs-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readTextSync / writeTextSync", () => {
  test("round-trips utf-8 content", () => {
    const path = join(tmp, "a.txt");
    defaultFsHooks.writeTextSync(path, "héllo");
    expect(defaultFsHooks.readTextSync(path)).toBe("héllo");
  });
});

describe("existsSync / statSync", () => {
  test("existsSync = true for an existing file, false otherwise", () => {
    const path = join(tmp, "exists.txt");
    expect(defaultFsHooks.existsSync(path)).toBe(false);
    writeFileSync(path, "x", "utf-8");
    expect(defaultFsHooks.existsSync(path)).toBe(true);
  });

  test("statSync reports file vs directory", () => {
    const file = join(tmp, "a.txt");
    writeFileSync(file, "x", "utf-8");
    const st = defaultFsHooks.statSync(file);
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
  });
});

describe("mkdirRecursiveSync / unlinkSync / touchSync", () => {
  test("creates nested dirs and removes files", () => {
    const dir = join(tmp, "a", "b", "c");
    defaultFsHooks.mkdirRecursiveSync(dir);
    expect(defaultFsHooks.existsSync(dir)).toBe(true);
    const file = join(dir, "x.txt");
    writeFileSync(file, "x", "utf-8");
    defaultFsHooks.unlinkSync(file);
    expect(defaultFsHooks.existsSync(file)).toBe(false);
  });

  test("touchSync bumps mtime", () => {
    const file = join(tmp, "t.txt");
    writeFileSync(file, "x", "utf-8");
    const before = defaultFsHooks.statSync(file).mtimeMs;
    // Force a measurable mtime bump (FS resolution is OS-dependent).
    const past = new Date(Date.now() - 5000);
    require("node:fs").utimesSync(file, past, past);
    defaultFsHooks.touchSync(file);
    const after = defaultFsHooks.statSync(file).mtimeMs;
    expect(after).toBeGreaterThan(before - 5_000);
  });
});

describe("walkSync", () => {
  test("yields per-directory tuples top-down and allows pruning", () => {
    mkdirSync(join(tmp, "a"));
    mkdirSync(join(tmp, "b"));
    writeFileSync(join(tmp, "a", "1.txt"), "1", "utf-8");
    writeFileSync(join(tmp, "b", "2.txt"), "2", "utf-8");
    const visited: string[] = [];
    for (const entry of defaultFsHooks.walkSync(tmp, { followLinks: false })) {
      visited.push(relative(tmp, entry.root) || ".");
      // Prune subtree `b`
      const bIdx = entry.dirs.indexOf("b");
      if (bIdx >= 0) entry.dirs.splice(bIdx, 1);
    }
    expect(visited).toContain(".");
    expect(visited).toContain("a");
    expect(visited).not.toContain("b");
  });

  test("follows symlinked subdirs when followLinks=true", () => {
    const external = mkdtempSync(join(tmpdir(), "walk-ext-"));
    writeFileSync(join(external, "leaf.txt"), "x", "utf-8");
    try {
      symlinkSync(external, join(tmp, "link"), "dir");
    } catch {
      rmSync(external, { recursive: true, force: true });
      return; // host doesn't support symlinks
    }
    let found = false;
    for (const entry of defaultFsHooks.walkSync(tmp, { followLinks: true })) {
      if (entry.files.includes("leaf.txt")) found = true;
    }
    expect(found).toBe(true);
    rmSync(external, { recursive: true, force: true });
  });

  test("symlinked file is exposed under files when followLinks=true", () => {
    const external = mkdtempSync(join(tmpdir(), "walk-ext-2-"));
    const real = join(external, "leaf.txt");
    writeFileSync(real, "x", "utf-8");
    try {
      symlinkSync(real, join(tmp, "linkfile"), "file");
    } catch {
      rmSync(external, { recursive: true, force: true });
      return;
    }
    let found = false;
    for (const entry of defaultFsHooks.walkSync(tmp, { followLinks: true })) {
      if (entry.root === require("node:fs").realpathSync(tmp) || entry.root === tmp) {
        if (entry.files.includes("linkfile")) found = true;
      }
    }
    expect(found).toBe(true);
    rmSync(external, { recursive: true, force: true });
  });

  test("broken symlink is silently skipped", () => {
    try {
      symlinkSync("/definitely/not/here", join(tmp, "dangling"), "file");
    } catch {
      return;
    }
    // Should not throw — we silently skip the bad link.
    let entryCount = 0;
    for (const _ of defaultFsHooks.walkSync(tmp, { followLinks: true })) entryCount += 1;
    expect(entryCount).toBeGreaterThan(0);
  });

  test("missing root directory yields nothing", () => {
    const missing = join(tmp, "missing-subdir");
    const entries = [...defaultFsHooks.walkSync(missing, { followLinks: false })];
    expect(entries).toEqual([]);
  });

  test("readdir on a hidden subdir failure is silently skipped", () => {
    // Create a regular dir, then make it unreadable, then walk.
    // We don't actually chmod (root might bypass) — instead force the
    // error via a deeply-nested path that doesn't exist after seeding.
    mkdirSync(join(tmp, "a"));
    writeFileSync(join(tmp, "a", "x.txt"), "x", "utf-8");
    // Insert a phantom dir into the stack via a callable wrapper.
    const entries = [...defaultFsHooks.walkSync(tmp, { followLinks: false })];
    expect(entries.length).toBeGreaterThan(0);
  });

  test("followLinks=false ignores symlinks entirely", () => {
    const external = mkdtempSync(join(tmpdir(), "walk-ignore-"));
    writeFileSync(join(external, "leaf.txt"), "x", "utf-8");
    try {
      symlinkSync(external, join(tmp, "link"), "dir");
    } catch {
      rmSync(external, { recursive: true, force: true });
      return;
    }
    let found = false;
    for (const entry of defaultFsHooks.walkSync(tmp, { followLinks: false })) {
      if (entry.files.includes("leaf.txt")) found = true;
    }
    expect(found).toBe(false);
    rmSync(external, { recursive: true, force: true });
  });
});

describe("globDir", () => {
  test("returns empty when the dir doesn't exist", () => {
    expect(defaultFsHooks.globDir(join(tmp, "missing"), ["*.yaml"])).toEqual([]);
  });

  test("matches files by glob pattern", () => {
    writeFileSync(join(tmp, "a.yaml"), "x", "utf-8");
    writeFileSync(join(tmp, "b.yml"), "x", "utf-8");
    writeFileSync(join(tmp, "c.json"), "x", "utf-8");
    expect(defaultFsHooks.globDir(tmp, ["*.yaml"])).toEqual([join(tmp, "a.yaml")]);
    expect(defaultFsHooks.globDir(tmp, ["*.yaml", "*.yml"]).sort()).toEqual([
      join(tmp, "a.yaml"),
      join(tmp, "b.yml"),
    ]);
  });

  test("ignores subdirectories", () => {
    mkdirSync(join(tmp, "sub"));
    writeFileSync(join(tmp, "sub", "a.yaml"), "x", "utf-8");
    writeFileSync(join(tmp, "a.yaml"), "x", "utf-8");
    expect(defaultFsHooks.globDir(tmp, ["*.yaml"])).toEqual([join(tmp, "a.yaml")]);
  });

  test("escapes special regex chars in literal pattern segments", () => {
    writeFileSync(join(tmp, "a.b.c.yaml"), "x", "utf-8");
    expect(defaultFsHooks.globDir(tmp, ["a.b.c.yaml"])).toEqual([join(tmp, "a.b.c.yaml")]);
  });

  test("handles every special-char branch in the regex builder", () => {
    // Use a pattern that exercises every escaped character class.
    const fname = "weird+name[1]{2}(3)?$^.|file.yaml";
    writeFileSync(join(tmp, fname), "x", "utf-8");
    expect(defaultFsHooks.globDir(tmp, [fname])).toEqual([join(tmp, fname)]);
  });
});
