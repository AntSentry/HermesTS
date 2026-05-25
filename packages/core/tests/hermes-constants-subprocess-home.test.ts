// Ported from tests/test_subprocess_home_isolation.py
// Only the core-only test cases are ported here:
//   - TestGetSubprocessHome (the bits without tools.environments.local)
//   - TestPythonProcessUnchanged
// TestMakeRunEnvHomeInjection, TestSanitizeSubprocessEnvHomeInjection, and
// TestProfileBootstrap are deferred to tasks #6 (tools) and #14 (cli).

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  _resetForTesting,
  _resetIo,
  getHermesHome,
  getSubprocessHome,
  resetHermesHomeOverride,
  setHermesHomeOverride,
} from "../src/hermes-constants.js";

let tmp: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "hermests-subhome-")));
  savedHome = process.env.HERMES_HOME;
  delete process.env.HERMES_HOME;
  _resetForTesting();
  _resetIo();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
  _resetForTesting();
  _resetIo();
});

describe("getSubprocessHome", () => {
  test("returns null when HERMES_HOME unset", () => {
    delete process.env.HERMES_HOME;
    expect(getSubprocessHome()).toBeNull();
  });

  test("returns null when home/ subdirectory missing", () => {
    const hermesHome = join(tmp, ".hermes");
    mkdirSync(hermesHome);
    process.env.HERMES_HOME = hermesHome;
    expect(getSubprocessHome()).toBeNull();
  });

  test("returns profile_home when home/ exists", () => {
    const hermesHome = join(tmp, ".hermes");
    mkdirSync(hermesHome);
    const profileHome = join(hermesHome, "home");
    mkdirSync(profileHome);
    process.env.HERMES_HOME = hermesHome;
    expect(getSubprocessHome()).toBe(profileHome);
  });

  test("two profiles get distinct subprocess homes", () => {
    const base = join(tmp, ".hermes", "profiles");
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(base, name, "home"), { recursive: true });
    }
    process.env.HERMES_HOME = join(base, "alpha");
    const homeA = getSubprocessHome();
    process.env.HERMES_HOME = join(base, "beta");
    const homeB = getSubprocessHome();
    expect(homeA).not.toBeNull();
    expect(homeB).not.toBeNull();
    expect(homeA).not.toBe(homeB);
    expect((homeA as string).endsWith(join("alpha", "home"))).toBe(true);
    expect((homeB as string).endsWith(join("beta", "home"))).toBe(true);
  });

  test("context override isolates per-async-context (analogue of thread-local)", async () => {
    // Faithful divergence from the upstream py threading test: Python's
    // threading.local maps to Node's AsyncLocalStorage. The upstream test
    // verifies a sibling thread does NOT see the override; here we verify
    // a sibling async context does not see it.
    const root = join(tmp, "root");
    const profile = join(tmp, "profile");
    mkdirSync(root);
    mkdirSync(profile);
    process.env.HERMES_HOME = root;

    // Sibling async chain captures HERMES_HOME with no override active.
    let sibling = "";
    const siblingPromise = Promise.resolve().then(() => {
      sibling = getHermesHome();
    });

    const token = setHermesHomeOverride(profile);
    try {
      expect(getHermesHome()).toBe(profile);
      await siblingPromise;
    } finally {
      resetHermesHomeOverride(token);
    }
    // The sibling, which ran without entering the storage context, sees root.
    expect(sibling).toBe(root);
    expect(getHermesHome()).toBe(root);
  });
});

describe("Python process unchanged", () => {
  test("process HOME env var is never mutated by getSubprocessHome", () => {
    const hermesHome = join(tmp, "hermes");
    mkdirSync(hermesHome);
    mkdirSync(join(hermesHome, "home"));
    process.env.HERMES_HOME = hermesHome;

    const originalHome = process.env.HOME;
    const subHome = getSubprocessHome();

    expect(subHome).not.toBeNull();
    expect(process.env.HOME).toBe(originalHome);
  });
});
