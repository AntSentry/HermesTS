// Ported from tests/test_hermes_home_profile_warning.py

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  _internals,
  _io,
  _resetForTesting,
  _resetIo,
  getHermesHome,
} from "../src/hermes-constants.js";

let tmp: string;
let savedHome: string | undefined;
let stderrChunks: string[];
let originalWrite: typeof process.stderr.write;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "hermests-profile-warn-")));
  savedHome = process.env.HERMES_HOME;
  delete process.env.HERMES_HOME;
  _resetForTesting();
  _resetIo();
  _io.homedir = () => tmp;

  stderrChunks = [];
  originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHome;
  process.stderr.write = originalWrite;
  rmSync(tmp, { recursive: true, force: true });
  _resetForTesting();
  _resetIo();
});

function stderrText(): string {
  return stderrChunks.join("");
}

describe("getHermesHome — profile fallback warning", () => {
  test("classic mode (no active_profile file) is silent", () => {
    const result = getHermesHome();
    expect(result).toBe(join(tmp, ".hermes"));
    expect(stderrText()).not.toContain("HERMES_HOME fallback");
  });

  test("default active_profile is silent", () => {
    const hermesDir = join(tmp, ".hermes");
    mkdirSync(hermesDir);
    writeFileSync(join(hermesDir, "active_profile"), "default\n");

    const result = getHermesHome();

    expect(result).toBe(join(tmp, ".hermes"));
    expect(stderrText()).not.toContain("HERMES_HOME fallback");
  });

  test("named profile with HERMES_HOME unset warns exactly once", () => {
    const hermesDir = join(tmp, ".hermes");
    mkdirSync(hermesDir);
    writeFileSync(join(hermesDir, "active_profile"), "coder\n");

    const result = getHermesHome();

    expect(result).toBe(join(tmp, ".hermes"));
    const text = stderrText();
    const matches = text.match(/HERMES_HOME fallback/g) ?? [];
    expect(matches.length).toBe(1);
    expect(text).toContain("'coder'");
    expect(text).toContain("#18594");

    // One-shot: subsequent calls don't re-warn.
    getHermesHome();
    getHermesHome();
    const afterText = stderrText();
    const afterMatches = afterText.match(/HERMES_HOME fallback/g) ?? [];
    expect(afterMatches.length).toBe(1);
  });

  test("setting HERMES_HOME suppresses the warning", () => {
    const profileDir = join(tmp, ".hermes", "profiles", "coder");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(tmp, ".hermes", "active_profile"), "coder\n");
    process.env.HERMES_HOME = profileDir;

    const result = getHermesHome();

    expect(result).toBe(profileDir);
    expect(stderrText()).not.toContain("HERMES_HOME fallback");
  });

  test("unreadable active_profile file does not crash and does not warn", () => {
    const hermesDir = join(tmp, ".hermes");
    mkdirSync(hermesDir);
    writeFileSync(join(hermesDir, "active_profile"), "default\n");

    // Force readFileSync to throw, mirroring the upstream "can't decode" case.
    _io.readFileSync = (() => {
      throw new Error("EACCES");
    }) as typeof _io.readFileSync;

    const result = getHermesHome();

    expect(result).toBe(join(tmp, ".hermes"));
    expect(stderrText()).not.toContain("HERMES_HOME fallback");
  });

  test("empty active_profile is treated as default", () => {
    const hermesDir = join(tmp, ".hermes");
    mkdirSync(hermesDir);
    writeFileSync(join(hermesDir, "active_profile"), "");

    const result = getHermesHome();

    expect(result).toBe(join(tmp, ".hermes"));
    expect(stderrText()).not.toContain("HERMES_HOME fallback");
  });

  test("warning still emits if process.stderr.write throws", () => {
    // Simulates a detached/closed stderr — the wrapper try/catch at
    // hermes-constants.ts:L133-137 must swallow the error.
    const hermesDir = join(tmp, ".hermes");
    mkdirSync(hermesDir);
    writeFileSync(join(hermesDir, "active_profile"), "coder\n");

    process.stderr.write = (() => {
      throw new Error("stderr detached");
    }) as typeof process.stderr.write;

    expect(() => getHermesHome()).not.toThrow();
    expect(_internals.profileFallbackWarned).toBe(true);
  });
});
