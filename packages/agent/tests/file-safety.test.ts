// Ported from upstream file_safety.py exercises (covered indirectly
// in test_run_agent.py write-deny path tests; this file pins the
// helper-level contract directly).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  buildWriteDeniedPaths,
  buildWriteDeniedPrefixes,
  getReadBlockError,
  getSafeWriteRoot,
  isWriteDenied,
} from "../src/file-safety.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.HERMES_WRITE_SAFE_ROOT;
  delete process.env.HERMES_HOME;
  delete process.env.HERMES_PROFILE;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("buildWriteDeniedPaths", () => {
  test("contains expected ssh entries", () => {
    const set = buildWriteDeniedPaths(homedir());
    const hasAuth = [...set].some((p) => p.endsWith("authorized_keys"));
    expect(hasAuth).toBe(true);
  });

  test("contains rc files", () => {
    const set = buildWriteDeniedPaths(homedir());
    const hasBashrc = [...set].some((p) => p.endsWith(".bashrc"));
    expect(hasBashrc).toBe(true);
  });

  test("contains /etc/passwd-style system files (resolved via realpath)", () => {
    const set = buildWriteDeniedPaths(homedir());
    // realpath may add /private prefix on macOS — match by suffix.
    const hasPasswd = [...set].some((p) => p.endsWith("/etc/passwd"));
    const hasSudoers = [...set].some((p) => p.endsWith("/etc/sudoers"));
    expect(hasPasswd).toBe(true);
    expect(hasSudoers).toBe(true);
  });
});

describe("buildWriteDeniedPrefixes", () => {
  test("includes .ssh and .aws dirs with trailing separator", () => {
    const prefixes = buildWriteDeniedPrefixes(homedir());
    const hasSsh = prefixes.some((p) => p.endsWith("/.ssh/"));
    const hasAws = prefixes.some((p) => p.endsWith("/.aws/"));
    expect(hasSsh).toBe(true);
    expect(hasAws).toBe(true);
  });
});

describe("getSafeWriteRoot", () => {
  test("returns null when env not set", () => {
    expect(getSafeWriteRoot()).toBe(null);
  });

  test("returns realpath when env set", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermests-safe-"));
    try {
      process.env.HERMES_WRITE_SAFE_ROOT = dir;
      const out = getSafeWriteRoot();
      expect(out).not.toBe(null);
      expect(out).toContain("hermests-safe-");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handles ~ expansion", () => {
    process.env.HERMES_WRITE_SAFE_ROOT = "~/never-actually-exists-i18n-marker";
    const out = getSafeWriteRoot();
    expect(out).not.toBe(null);
    expect(out).toContain("never-actually-exists-i18n-marker");
  });
});

describe("isWriteDenied", () => {
  test("denies a tracked rc file", () => {
    expect(isWriteDenied(join(homedir(), ".bashrc"))).toBe(true);
  });

  test("denies any path inside .ssh/", () => {
    expect(isWriteDenied(join(homedir(), ".ssh", "anything.txt"))).toBe(true);
  });

  test("denies the global /etc/passwd", () => {
    expect(isWriteDenied("/etc/passwd")).toBe(true);
  });

  test("allows arbitrary tmp file by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermests-fs-"));
    try {
      expect(isWriteDenied(join(dir, "ok.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("when SAFE_ROOT set, denies outside paths", () => {
    const safe = mkdtempSync(join(tmpdir(), "hermests-safe-"));
    try {
      process.env.HERMES_WRITE_SAFE_ROOT = safe;
      expect(isWriteDenied(join(safe, "ok.txt"))).toBe(false);
      expect(isWriteDenied("/tmp/elsewhere/foo.txt")).toBe(true);
    } finally {
      rmSync(safe, { recursive: true, force: true });
    }
  });

  test("when SAFE_ROOT set, allows the root itself", () => {
    const safe = mkdtempSync(join(tmpdir(), "hermests-safe-"));
    try {
      process.env.HERMES_WRITE_SAFE_ROOT = safe;
      expect(isWriteDenied(safe)).toBe(false);
    } finally {
      rmSync(safe, { recursive: true, force: true });
    }
  });

  test("denies a control-plane file under hermes home (auth.json)", () => {
    const home = mkdtempSync(join(tmpdir(), "hermests-hh-"));
    try {
      process.env.HERMES_HOME = home;
      const path = join(home, "auth.json");
      writeFileSync(path, "{}");
      expect(isWriteDenied(path)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("denies any file inside mcp-tokens", () => {
    const home = mkdtempSync(join(tmpdir(), "hermests-hh-"));
    try {
      process.env.HERMES_HOME = home;
      const dir = join(home, "mcp-tokens");
      mkdirSync(dir);
      const file = join(dir, "github.json");
      writeFileSync(file, "{}");
      expect(isWriteDenied(file)).toBe(true);
      // Also denies the directory itself by exact match.
      expect(isWriteDenied(dir)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("getReadBlockError", () => {
  test("returns null for unrelated path", () => {
    expect(getReadBlockError("/tmp/non-sensitive")).toBe(null);
  });

  test("resolves relative paths against cwd", () => {
    // Relative input goes through the `!isAbsolute → resolve` branch.
    expect(getReadBlockError("./not-a-credential")).toBe(null);
  });

  test("blocks auth.json inside hermes home", () => {
    const home = mkdtempSync(join(tmpdir(), "hermests-hh-"));
    try {
      process.env.HERMES_HOME = home;
      const authPath = join(home, "auth.json");
      writeFileSync(authPath, "{}");
      const msg = getReadBlockError(authPath);
      expect(msg).not.toBe(null);
      expect(msg).toContain("credential store");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("blocks mcp-tokens directory itself", () => {
    const home = mkdtempSync(join(tmpdir(), "hermests-hh-"));
    try {
      process.env.HERMES_HOME = home;
      const dir = join(home, "mcp-tokens");
      mkdirSync(dir);
      const msg = getReadBlockError(dir);
      expect(msg).not.toBe(null);
      expect(msg).toContain("MCP token directory");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("blocks any file inside mcp-tokens", () => {
    const home = mkdtempSync(join(tmpdir(), "hermests-hh-"));
    try {
      process.env.HERMES_HOME = home;
      const dir = join(home, "mcp-tokens");
      mkdirSync(dir);
      const file = join(dir, "github.json");
      writeFileSync(file, "{}");
      const msg = getReadBlockError(file);
      expect(msg).not.toBe(null);
      expect(msg).toContain("MCP token file");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("blocks files inside skills/.hub", () => {
    const home = mkdtempSync(join(tmpdir(), "hermests-hh-"));
    try {
      process.env.HERMES_HOME = home;
      const hub = join(home, "skills", ".hub");
      mkdirSync(hub, { recursive: true });
      const file = join(hub, "index.json");
      writeFileSync(file, "{}");
      const msg = getReadBlockError(file);
      expect(msg).not.toBe(null);
      expect(msg).toContain("prompt injection");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("blocks the skills/.hub directory itself (exact match)", () => {
    const home = mkdtempSync(join(tmpdir(), "hermests-hh-"));
    try {
      process.env.HERMES_HOME = home;
      const hub = join(home, "skills", ".hub");
      mkdirSync(hub, { recursive: true });
      const msg = getReadBlockError(hub);
      expect(msg).not.toBe(null);
      expect(msg).toContain("prompt injection");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
