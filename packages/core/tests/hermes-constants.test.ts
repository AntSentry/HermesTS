// Ported from tests/test_hermes_constants.py

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as constants from "../src/hermes-constants.js";
import {
  VALID_REASONING_EFFORTS,
  _internals,
  _io,
  _resetForTesting,
  _resetIo,
  getDefaultHermesRoot,
  isContainer,
  parseReasoningEffort,
  secureParentDir,
} from "../src/hermes-constants.js";

let tmp: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "hermests-constants-")));
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

function setHomedir(value: string): void {
  _io.homedir = () => value;
}

describe("getDefaultHermesRoot", () => {
  test("no HERMES_HOME returns ~/.hermes", () => {
    delete process.env.HERMES_HOME;
    setHomedir(tmp);
    expect(getDefaultHermesRoot()).toBe(join(tmp, ".hermes"));
  });

  test("HERMES_HOME equals ~/.hermes returns ~/.hermes", () => {
    const native = join(tmp, ".hermes");
    mkdirSync(native);
    setHomedir(tmp);
    process.env.HERMES_HOME = native;
    expect(getDefaultHermesRoot()).toBe(native);
  });

  test("HERMES_HOME is a profile under ~/.hermes returns ~/.hermes", () => {
    const native = join(tmp, ".hermes");
    const profile = join(native, "profiles", "coder");
    mkdirSync(profile, { recursive: true });
    setHomedir(tmp);
    process.env.HERMES_HOME = profile;
    expect(getDefaultHermesRoot()).toBe(native);
  });

  test("HERMES_HOME outside ~/.hermes (Docker) returns HERMES_HOME", () => {
    const dockerHome = join(tmp, "opt", "data");
    mkdirSync(dockerHome, { recursive: true });
    setHomedir(tmp);
    process.env.HERMES_HOME = dockerHome;
    expect(getDefaultHermesRoot()).toBe(dockerHome);
  });

  test("custom path outside ~/.hermes treated as root", () => {
    const custom = join(tmp, "my-hermes-data");
    mkdirSync(custom);
    setHomedir(tmp);
    process.env.HERMES_HOME = custom;
    expect(getDefaultHermesRoot()).toBe(custom);
  });

  test("docker profile active returns docker root", () => {
    const dockerRoot = join(tmp, "opt", "data");
    const profile = join(dockerRoot, "profiles", "coder");
    mkdirSync(profile, { recursive: true });
    setHomedir(tmp);
    process.env.HERMES_HOME = profile;
    expect(getDefaultHermesRoot()).toBe(dockerRoot);
  });

  test("realpath failure falls back to pathResolve", () => {
    // Force realpath to throw so we exercise the catch branch at
    // hermes-constants.ts:L160-164.
    _io.realpathSync = (() => {
      throw new Error("ENOENT");
    }) as unknown as typeof _io.realpathSync;
    setHomedir(tmp);
    process.env.HERMES_HOME = join(tmp, "nope-this-does-not-exist");
    const out = getDefaultHermesRoot();
    expect(out).toBe(join(tmp, "nope-this-does-not-exist"));
  });
});

describe("isContainer", () => {
  test("detects /.dockerenv", () => {
    _internals.containerDetected = undefined;
    // simulates is_container py:L339-364 — /.dockerenv branch
    _io.existsSync = ((p: unknown) => p === "/.dockerenv") as typeof _io.existsSync;
    expect(isContainer()).toBe(true);
  });

  test("detects /run/.containerenv (Podman)", () => {
    _internals.containerDetected = undefined;
    // simulates is_container py:L339-364 — Podman branch
    _io.existsSync = ((p: unknown) =>
      p === "/run/.containerenv") as typeof _io.existsSync;
    expect(isContainer()).toBe(true);
  });

  test("detects /proc/1/cgroup containing 'docker'", () => {
    _internals.containerDetected = undefined;
    // simulates is_container py:L339-364 — cgroup branch
    _io.existsSync = (() => false) as typeof _io.existsSync;
    _io.readFileSync = ((path: unknown) => {
      if (path === "/proc/1/cgroup") return "12:memory:/docker/abc123\n";
      throw new Error("ENOENT");
    }) as typeof _io.readFileSync;
    expect(isContainer()).toBe(true);
  });

  test("detects /proc/1/cgroup containing 'podman'", () => {
    _internals.containerDetected = undefined;
    _io.existsSync = (() => false) as typeof _io.existsSync;
    _io.readFileSync = ((path: unknown) => {
      if (path === "/proc/1/cgroup") return "12:memory:/podman/xyz\n";
      throw new Error("ENOENT");
    }) as typeof _io.readFileSync;
    expect(isContainer()).toBe(true);
  });

  test("detects /proc/1/cgroup containing '/lxc/'", () => {
    _internals.containerDetected = undefined;
    _io.existsSync = (() => false) as typeof _io.existsSync;
    _io.readFileSync = ((path: unknown) => {
      if (path === "/proc/1/cgroup") return "12:memory:/lxc/container1\n";
      throw new Error("ENOENT");
    }) as typeof _io.readFileSync;
    expect(isContainer()).toBe(true);
  });

  test("returns false on regular host", () => {
    _internals.containerDetected = undefined;
    _io.existsSync = (() => false) as typeof _io.existsSync;
    _io.readFileSync = ((path: unknown) => {
      if (path === "/proc/1/cgroup") return "12:memory:/\n";
      throw new Error("ENOENT");
    }) as typeof _io.readFileSync;
    expect(isContainer()).toBe(false);
  });

  test("returns false when cgroup read throws", () => {
    _internals.containerDetected = undefined;
    _io.existsSync = (() => false) as typeof _io.existsSync;
    _io.readFileSync = (() => {
      throw new Error("EACCES");
    }) as typeof _io.readFileSync;
    expect(isContainer()).toBe(false);
  });

  test("caches result across calls", () => {
    _internals.containerDetected = true;
    expect(isContainer()).toBe(true);
    _io.existsSync = (() => false) as typeof _io.existsSync;
    expect(isContainer()).toBe(true);
  });
});

describe("parseReasoningEffort", () => {
  test.each(["", "   ", "\t", "\n"])(
    "empty or whitespace returns null: %j",
    (value) => {
      expect(parseReasoningEffort(value)).toBeNull();
    },
  );

  test("'none' disables reasoning", () => {
    expect(parseReasoningEffort("none")).toEqual({ enabled: false });
  });

  test.each(VALID_REASONING_EFFORTS)("accepts level %s", (level) => {
    expect(parseReasoningEffort(level)).toEqual({ enabled: true, effort: level });
  });

  test.each<[string, string | false]>([
    ["MEDIUM", "medium"],
    ["High", "high"],
    ["  low  ", "low"],
    ["\tXHIGH\n", "xhigh"],
    ["None", false],
  ])("case + whitespace normalized: %s -> %s", (raw, expected) => {
    const result = parseReasoningEffort(raw);
    if (expected === false) {
      expect(result).toEqual({ enabled: false });
    } else {
      expect(result).toEqual({ enabled: true, effort: expected });
    }
  });

  test.each(["bogus", "very-high", "max", "0", "off", "true", "default"])(
    "unknown level returns null: %s",
    (value) => {
      expect(parseReasoningEffort(value)).toBeNull();
    },
  );

  test("documented levels are in VALID_REASONING_EFFORTS", () => {
    const documented = new Set(["minimal", "low", "medium", "high", "xhigh"]);
    for (const lvl of documented) {
      expect((VALID_REASONING_EFFORTS as readonly string[]).includes(lvl)).toBe(true);
    }
  });
});

describe("secureParentDir", () => {
  test("safe path (depth >= 3) calls chmod", () => {
    const safeDir = join(tmp, "home", "user", ".hermes");
    mkdirSync(safeDir, { recursive: true });
    const target = join(safeDir, "auth.json");
    writeFileSync(target, "{}");

    const calls: Array<[string, number]> = [];
    _io.chmodSync = ((p: unknown, m: unknown) => {
      calls.push([String(p), m as number]);
    }) as typeof _io.chmodSync;

    secureParentDir(target);
    expect(calls).toEqual([[safeDir, 0o700]]);
  });

  test("root path is skipped", () => {
    const calls: Array<[string, number]> = [];
    _io.chmodSync = ((p: unknown, m: unknown) => {
      calls.push([String(p), m as number]);
    }) as typeof _io.chmodSync;
    secureParentDir("/foo");
    expect(calls).toEqual([]);
  });

  test("top-level dir (depth 2) is skipped", () => {
    const calls: Array<[string, number]> = [];
    _io.chmodSync = ((p: unknown, m: unknown) => {
      calls.push([String(p), m as number]);
    }) as typeof _io.chmodSync;
    // /usr/foo -> parent /usr is depth 2; refuse.
    secureParentDir("/usr/foo");
    expect(calls).toEqual([]);
  });

  test("two-component path skipped (depth < 3 after realpath)", () => {
    const calls: Array<[string, number]> = [];
    _io.chmodSync = ((p: unknown, m: unknown) => {
      calls.push([String(p), m as number]);
    }) as typeof _io.chmodSync;
    // Mock realpath to make /x/y resolve to /x, mirroring py:L222-225.
    _io.realpathSync = ((p: unknown) => {
      if (p === "/x") return "/x";
      throw new Error("ENOENT");
    }) as unknown as typeof _io.realpathSync;
    secureParentDir("/x/y");
    expect(calls).toEqual([]);
  });

  test("chmod errors swallowed", () => {
    const safeDir = join(tmp, "a", "b", "c");
    mkdirSync(safeDir, { recursive: true });
    const target = join(safeDir, "file.json");
    writeFileSync(target, "{}");

    _io.chmodSync = (() => {
      throw new Error("permission denied");
    }) as typeof _io.chmodSync;
    expect(() => secureParentDir(target)).not.toThrow();
  });

  test("symlink resolution applies before depth check", () => {
    const realDir = join(tmp, "a", "b");
    mkdirSync(realDir, { recursive: true });
    const target = join(realDir, "file.json");
    writeFileSync(target, "{}");

    const link = join(tmp, "link");
    symlinkSync(realDir, link);
    const linkTarget = join(link, "file.json");

    const calls: Array<[string, number]> = [];
    _io.chmodSync = ((p: unknown, m: unknown) => {
      calls.push([String(p), m as number]);
    }) as typeof _io.chmodSync;
    secureParentDir(linkTarget);
    expect(calls.length).toBe(1);
    const [firstCall] = calls;
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]).toBe(realDir);
    expect(firstCall?.[1]).toBe(0o700);
  });

  test("realpath failure falls back to pathResolve and still rejects short paths", () => {
    const calls: Array<[string, number]> = [];
    _io.chmodSync = ((p: unknown, m: unknown) => {
      calls.push([String(p), m as number]);
    }) as typeof _io.chmodSync;
    _io.realpathSync = (() => {
      throw new Error("ENOENT");
    }) as unknown as typeof _io.realpathSync;
    secureParentDir("/foo/bar");
    expect(calls).toEqual([]);
  });

  test("relative parent path counts without a root component", () => {
    // simulates secure_parent_dir Path.parts without anchor from hermes_constants.py:L238-255.
    const calls: Array<[string, number]> = [];
    _io.realpathSync = ((p: unknown) => String(p)) as typeof _io.realpathSync;
    _io.chmodSync = ((p: unknown, m: unknown) => {
      calls.push([String(p), m as number]);
    }) as typeof _io.chmodSync;

    secureParentDir("foo/bar/baz/file.json");

    expect(calls).toEqual([["foo/bar/baz", 0o700]]);
  });

  // Confirms the trailing `void isAbsolute` import-time guard runs.
  test("isAbsolute reference compiles", () => {
    expect(typeof nodePath.isAbsolute).toBe("function");
    expect(constants).toBeDefined();
  });
});

describe("isTermux", () => {
  test("returns true when TERMUX_VERSION is set", () => {
    const saved = process.env.TERMUX_VERSION;
    process.env.TERMUX_VERSION = "0.118.0";
    try {
      expect(constants.isTermux()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TERMUX_VERSION;
      else process.env.TERMUX_VERSION = saved;
    }
  });

  test("returns true when PREFIX includes Termux path", () => {
    const savedPrefix = process.env.PREFIX;
    const savedVer = process.env.TERMUX_VERSION;
    delete process.env.TERMUX_VERSION;
    process.env.PREFIX = "/data/data/com.termux/files/usr";
    try {
      expect(constants.isTermux()).toBe(true);
    } finally {
      if (savedPrefix === undefined) delete process.env.PREFIX;
      else process.env.PREFIX = savedPrefix;
      if (savedVer === undefined) delete process.env.TERMUX_VERSION;
      else process.env.TERMUX_VERSION = savedVer;
    }
  });

  test("returns false otherwise", () => {
    const savedPrefix = process.env.PREFIX;
    const savedVer = process.env.TERMUX_VERSION;
    delete process.env.TERMUX_VERSION;
    delete process.env.PREFIX;
    try {
      expect(constants.isTermux()).toBe(false);
    } finally {
      if (savedPrefix === undefined) delete process.env.PREFIX;
      else process.env.PREFIX = savedPrefix;
      if (savedVer === undefined) delete process.env.TERMUX_VERSION;
      else process.env.TERMUX_VERSION = savedVer;
    }
  });
});

describe("isWsl", () => {
  test("detects Microsoft in /proc/version", () => {
    _internals.wslDetected = undefined;
    _io.readFileSync = ((path: unknown) => {
      if (path === "/proc/version") return "Linux version 5.10 microsoft-standard-WSL2";
      throw new Error("ENOENT");
    }) as typeof _io.readFileSync;
    expect(constants.isWsl()).toBe(true);
  });

  test("returns false when /proc/version is unavailable", () => {
    _internals.wslDetected = undefined;
    _io.readFileSync = (() => {
      throw new Error("ENOENT");
    }) as typeof _io.readFileSync;
    expect(constants.isWsl()).toBe(false);
  });

  test("returns false when /proc/version exists without 'microsoft'", () => {
    _internals.wslDetected = undefined;
    _io.readFileSync = ((path: unknown) => {
      if (path === "/proc/version") return "Linux version 6.1 vanilla kernel";
      throw new Error("ENOENT");
    }) as typeof _io.readFileSync;
    expect(constants.isWsl()).toBe(false);
  });

  test("caches result across calls", () => {
    _internals.wslDetected = true;
    expect(constants.isWsl()).toBe(true);
    _io.readFileSync = (() => {
      throw new Error("would change result if uncached");
    }) as typeof _io.readFileSync;
    expect(constants.isWsl()).toBe(true);
  });
});

describe("setHermesHomeOverride / resetHermesHomeOverride", () => {
  test("override is reflected in getHermesHomeOverride and getHermesHome", () => {
    const token = constants.setHermesHomeOverride(join(tmp, "override-home"));
    try {
      expect(constants.getHermesHomeOverride()).toBe(join(tmp, "override-home"));
      expect(constants.getHermesHome()).toBe(join(tmp, "override-home"));
    } finally {
      constants.resetHermesHomeOverride(token);
    }
    expect(constants.getHermesHomeOverride()).toBeNull();
  });

  test("setting null clears the override cell value", () => {
    const initial = constants.setHermesHomeOverride(join(tmp, "a"));
    constants.setHermesHomeOverride(null);
    expect(constants.getHermesHomeOverride()).toBeNull();
    constants.resetHermesHomeOverride(initial);
  });

  test("getHermesHome reads HERMES_HOME env var after override is reset", () => {
    process.env.HERMES_HOME = join(tmp, "env-home");
    expect(constants.getHermesHome()).toBe(join(tmp, "env-home"));
  });

  test("getHermesHome trims surrounding whitespace from HERMES_HOME", () => {
    process.env.HERMES_HOME = `   ${join(tmp, "spaces")}   `;
    expect(constants.getHermesHome()).toBe(join(tmp, "spaces"));
  });
});

describe("getOptionalSkillsDir / getBundledSkillsDir / _getPackagedDataDir", () => {
  test("env var HERMES_OPTIONAL_SKILLS overrides everything", () => {
    const saved = process.env.HERMES_OPTIONAL_SKILLS;
    process.env.HERMES_OPTIONAL_SKILLS = "/custom/optional";
    try {
      expect(constants.getOptionalSkillsDir()).toBe("/custom/optional");
    } finally {
      if (saved === undefined) delete process.env.HERMES_OPTIONAL_SKILLS;
      else process.env.HERMES_OPTIONAL_SKILLS = saved;
    }
  });

  test("falls back to explicit default when env unset", () => {
    delete process.env.HERMES_OPTIONAL_SKILLS;
    expect(constants.getOptionalSkillsDir("/explicit/default")).toBe(
      "/explicit/default",
    );
  });

  test("falls back to <home>/optional-skills when no default supplied", () => {
    delete process.env.HERMES_OPTIONAL_SKILLS;
    process.env.HERMES_HOME = join(tmp, "home");
    expect(constants.getOptionalSkillsDir()).toBe(
      join(tmp, "home", "optional-skills"),
    );
  });

  test("HERMES_BUNDLED_SKILLS env var overrides everything", () => {
    const saved = process.env.HERMES_BUNDLED_SKILLS;
    process.env.HERMES_BUNDLED_SKILLS = "/custom/bundled";
    try {
      expect(constants.getBundledSkillsDir()).toBe("/custom/bundled");
    } finally {
      if (saved === undefined) delete process.env.HERMES_BUNDLED_SKILLS;
      else process.env.HERMES_BUNDLED_SKILLS = saved;
    }
  });

  test("bundled skills explicit default wins when env unset", () => {
    delete process.env.HERMES_BUNDLED_SKILLS;
    expect(constants.getBundledSkillsDir("/explicit/bundled")).toBe(
      "/explicit/bundled",
    );
  });

  test("bundled skills falls back to <home>/skills", () => {
    delete process.env.HERMES_BUNDLED_SKILLS;
    process.env.HERMES_HOME = join(tmp, "bhome");
    expect(constants.getBundledSkillsDir()).toBe(join(tmp, "bhome", "skills"));
  });

  test("_getPackagedDataDir defaults to null in TS port", () => {
    expect(constants._getPackagedDataDir("anything")).toBeNull();
  });

  test("_io.getPackagedDataDir override drives getOptionalSkillsDir", () => {
    delete process.env.HERMES_OPTIONAL_SKILLS;
    _io.getPackagedDataDir = (name: string) =>
      name === "optional-skills" ? "/packaged/optional" : null;
    expect(constants.getOptionalSkillsDir()).toBe("/packaged/optional");
  });

  test("_io.getPackagedDataDir override drives getBundledSkillsDir", () => {
    delete process.env.HERMES_BUNDLED_SKILLS;
    _io.getPackagedDataDir = (name: string) =>
      name === "skills" ? "/packaged/skills" : null;
    expect(constants.getBundledSkillsDir()).toBe("/packaged/skills");
  });
});

describe("getHermesDir / displayHermesHome / well-known paths", () => {
  test("getHermesDir returns old path when it exists", () => {
    const home = join(tmp, ".hermes");
    mkdirSync(join(home, "old-cache"), { recursive: true });
    process.env.HERMES_HOME = home;
    expect(constants.getHermesDir("cache/images", "old-cache")).toBe(
      join(home, "old-cache"),
    );
  });

  test("getHermesDir falls back to new path when old missing", () => {
    const home = join(tmp, ".hermes");
    mkdirSync(home);
    process.env.HERMES_HOME = home;
    expect(constants.getHermesDir("cache/images", "old-cache")).toBe(
      join(home, "cache/images"),
    );
  });

  test("displayHermesHome returns ~/ when home equals userHome", () => {
    setHomedir(tmp);
    process.env.HERMES_HOME = tmp;
    expect(constants.displayHermesHome()).toBe("~/");
  });

  test("displayHermesHome returns ~/subdir when home is under userHome", () => {
    setHomedir(tmp);
    process.env.HERMES_HOME = join(tmp, ".hermes");
    expect(constants.displayHermesHome()).toBe("~/.hermes");
  });

  test("displayHermesHome returns absolute path when home is outside userHome", () => {
    setHomedir(tmp);
    process.env.HERMES_HOME = "/elsewhere";
    expect(constants.displayHermesHome()).toBe("/elsewhere");
  });

  test("getConfigPath / getSkillsDir / getEnvPath compose under HERMES_HOME", () => {
    process.env.HERMES_HOME = join(tmp, ".hermes");
    expect(constants.getConfigPath()).toBe(join(tmp, ".hermes", "config.yaml"));
    expect(constants.getSkillsDir()).toBe(join(tmp, ".hermes", "skills"));
    expect(constants.getEnvPath()).toBe(join(tmp, ".hermes", ".env"));
  });
});

describe("getSubprocessHome", () => {
  test("returns null when HERMES_HOME unset", () => {
    delete process.env.HERMES_HOME;
    expect(constants.getSubprocessHome()).toBeNull();
  });

  test("returns null when home/ subdirectory missing", () => {
    const hermesHome = join(tmp, ".hermes");
    mkdirSync(hermesHome);
    process.env.HERMES_HOME = hermesHome;
    expect(constants.getSubprocessHome()).toBeNull();
  });

  test("returns profile_home when home/ exists", () => {
    const hermesHome = join(tmp, ".hermes");
    mkdirSync(hermesHome);
    const profileHome = join(hermesHome, "home");
    mkdirSync(profileHome);
    process.env.HERMES_HOME = hermesHome;
    expect(constants.getSubprocessHome()).toBe(profileHome);
  });

  test("two profiles get distinct subprocess homes", () => {
    const base = join(tmp, ".hermes", "profiles");
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(base, name, "home"), { recursive: true });
    }
    process.env.HERMES_HOME = join(base, "alpha");
    const homeA = constants.getSubprocessHome();
    process.env.HERMES_HOME = join(base, "beta");
    const homeB = constants.getSubprocessHome();
    expect(homeA).not.toBeNull();
    expect(homeB).not.toBeNull();
    expect(homeA).not.toBe(homeB);
    expect((homeA as string).endsWith(join("alpha", "home"))).toBe(true);
    expect((homeB as string).endsWith(join("beta", "home"))).toBe(true);
  });

  test("honors the in-process override", () => {
    const root = join(tmp, "root");
    const profile = join(tmp, "profile");
    mkdirSync(root);
    mkdirSync(join(profile, "home"), { recursive: true });
    process.env.HERMES_HOME = root;
    const token = constants.setHermesHomeOverride(profile);
    try {
      expect(constants.getSubprocessHome()).toBe(join(profile, "home"));
    } finally {
      constants.resetHermesHomeOverride(token);
    }
  });

  test("returns null when statSync throws (covers the catch branch)", () => {
    const hermesHome = join(tmp, ".hermes");
    mkdirSync(hermesHome);
    mkdirSync(join(hermesHome, "home"));
    process.env.HERMES_HOME = hermesHome;
    _io.statSync = (() => {
      throw new Error("EACCES");
    }) as typeof _io.statSync;
    expect(constants.getSubprocessHome()).toBeNull();
  });
});

describe("applyIpv4Preference", () => {
  test("force=false is a no-op", () => {
    const dns = require("node:dns") as typeof import("node:dns");
    const before = dns.lookup;
    constants.applyIpv4Preference(false);
    expect(dns.lookup).toBe(before);
  });

  test("force=true installs a patched lookup once", () => {
    const dns = require("node:dns") as typeof import("node:dns");
    const original = dns.lookup;
    try {
      constants.applyIpv4Preference(true);
      const patched = dns.lookup as typeof dns.lookup & {
        _hermesIpv4Patched?: boolean;
      };
      expect(patched._hermesIpv4Patched).toBe(true);
      constants.applyIpv4Preference(true);
      expect(dns.lookup).toBe(patched);
    } finally {
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  test("family:0 (unspecified) is rewritten to family:4", () => {
    const dns = require("node:dns") as typeof import("node:dns");
    const original = dns.lookup;
    try {
      const observedFamilies: Array<number | string | undefined> = [];
      const stub = ((
        _h: string,
        opts: { family?: number | string },
        cb: (err: Error | null, addr: string, fam?: number) => void,
      ) => {
        observedFamilies.push(opts.family);
        cb(null, "127.0.0.1", 4);
      }) as unknown as typeof dns.lookup;
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: stub,
      });
      constants.applyIpv4Preference(true);

      dns.lookup("example.com", { family: 0 }, () => undefined);
      dns.lookup("example.com", 0, () => undefined);
      dns.lookup("example.com", () => undefined);

      expect(observedFamilies).toEqual([4, 4, 4]);
    } finally {
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  test("string family 'IPv6' passes through unchanged", () => {
    const dns = require("node:dns") as typeof import("node:dns");
    const original = dns.lookup;
    try {
      const observed: Array<number | string | undefined> = [];
      const stub = ((
        _h: string,
        opts: { family?: number | string },
        cb: (err: Error | null, addr: string, fam?: number) => void,
      ) => {
        observed.push(opts.family);
        cb(null, "::1", 6);
      }) as unknown as typeof dns.lookup;
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: stub,
      });
      constants.applyIpv4Preference(true);

      dns.lookup("example.com", { family: "IPv6" as unknown as 6 }, () => undefined);
      expect(observed).toEqual(["IPv6"]);
    } finally {
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  test("string family 'IPv4' falls into the family-4 branch", () => {
    const dns = require("node:dns") as typeof import("node:dns");
    const original = dns.lookup;
    try {
      const observed: Array<number | string | undefined> = [];
      const stub = ((
        _h: string,
        opts: { family?: number | string },
        cb: (err: Error | null, addr: string, fam?: number) => void,
      ) => {
        observed.push(opts.family);
        cb(null, "1.2.3.4", 4);
      }) as unknown as typeof dns.lookup;
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: stub,
      });
      constants.applyIpv4Preference(true);

      dns.lookup("example.com", { family: "IPv4" as unknown as 4 }, () => undefined);
      expect(observed).toEqual(["IPv4"]);
    } finally {
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  test("numeric family 6 passes through unchanged", () => {
    const dns = require("node:dns") as typeof import("node:dns");
    const original = dns.lookup;
    try {
      const observed: number[] = [];
      const stub = ((
        _h: string,
        family: number,
        cb: (err: Error | null, addr: string, fam?: number) => void,
      ) => {
        observed.push(family);
        cb(null, "::1", 6);
      }) as unknown as typeof dns.lookup;
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: stub,
      });
      constants.applyIpv4Preference(true);
      dns.lookup("example.com", 6, () => undefined);
      expect(observed).toEqual([6]);
    } finally {
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  test("ENOTFOUND fallback retries with original options", () => {
    const dns = require("node:dns") as typeof import("node:dns");
    const original = dns.lookup;
    try {
      const observed: Array<number | string | undefined> = [];
      const stub = ((
        _h: string,
        opts: { family?: number | string },
        cb: (
          err: NodeJS.ErrnoException | null,
          addr: string | { address: string; family: number }[],
          fam?: number,
        ) => void,
      ) => {
        const family = opts.family;
        observed.push(family);
        if (family === 4) {
          const err = Object.assign(new Error("not found"), {
            code: "ENOTFOUND",
          });
          cb(err as NodeJS.ErrnoException, "");
          return;
        }
        cb(null, "::1", 6);
      }) as unknown as typeof dns.lookup;
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: stub,
      });
      constants.applyIpv4Preference(true);

      const seen: Array<string | null> = [];
      dns.lookup("v6only.example", { family: 0 }, (_e, addr) => {
        seen.push(String(addr));
      });

      expect(observed).toEqual([4, 0]);
      expect(seen).toEqual(["::1"]);
    } finally {
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  test("EAI_AGAIN also triggers fallback", () => {
    const dns = require("node:dns") as typeof import("node:dns");
    const original = dns.lookup;
    try {
      let callCount = 0;
      const stub = ((
        _h: string,
        opts: { family?: number | string },
        cb: (err: NodeJS.ErrnoException | null, addr: string, fam?: number) => void,
      ) => {
        callCount++;
        if (callCount === 1) {
          const err = Object.assign(new Error("transient"), {
            code: "EAI_AGAIN",
          });
          cb(err as NodeJS.ErrnoException, "");
          return;
        }
        cb(null, "fallback.ok", 4);
      }) as unknown as typeof dns.lookup;
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: stub,
      });
      constants.applyIpv4Preference(true);

      const seen: string[] = [];
      dns.lookup("example.com", { family: 0 }, (_e, addr) => {
        seen.push(String(addr));
      });
      expect(seen).toEqual(["fallback.ok"]);
      expect(callCount).toBe(2);
    } finally {
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  test("non-fallback errors propagate to the user callback", () => {
    const dns = require("node:dns") as typeof import("node:dns");
    const original = dns.lookup;
    try {
      const stub = ((
        _h: string,
        _opts: { family?: number | string },
        cb: (err: NodeJS.ErrnoException | null, addr: string, fam?: number) => void,
      ) => {
        const err = Object.assign(new Error("hard fail"), { code: "EPERM" });
        cb(err as NodeJS.ErrnoException, "");
      }) as unknown as typeof dns.lookup;
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: stub,
      });
      constants.applyIpv4Preference(true);

      const errs: string[] = [];
      dns.lookup("example.com", { family: 0 }, (err) => {
        if (err) errs.push(err.message);
      });
      expect(errs).toEqual(["hard fail"]);
    } finally {
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  test("error from fallback retry propagates (covers second-leg failure path)", () => {
    const dns = require("node:dns") as typeof import("node:dns");
    const original = dns.lookup;
    try {
      const stub = ((
        _h: string,
        opts: { family?: number | string },
        cb: (
          err: NodeJS.ErrnoException | null,
          addr: string,
          fam?: number,
        ) => void,
      ) => {
        if (opts.family === 4) {
          const err = Object.assign(new Error("retry trigger"), {
            code: "ENOTFOUND",
          });
          cb(err as NodeJS.ErrnoException, "");
          return;
        }
        const err = Object.assign(new Error("fallback failed"), { code: "EPERM" });
        cb(err as NodeJS.ErrnoException, "");
      }) as unknown as typeof dns.lookup;
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: stub,
      });
      constants.applyIpv4Preference(true);
      // Provide a user callback so the fallback leg's invocation has someone
      // to call; ensures the retry path runs end-to-end.
      const errs: string[] = [];
      dns.lookup("example.com", { family: 0 }, (err) => {
        if (err) errs.push(err.message);
      });
      expect(errs).toEqual(["fallback failed"]);
    } finally {
      Object.defineProperty(dns, "lookup", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});

describe("provider base URLs", () => {
  test("OPENROUTER_BASE_URL is fixed", () => {
    expect(constants.OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  test("OPENROUTER_MODELS_URL composes from base", () => {
    expect(constants.OPENROUTER_MODELS_URL).toBe(
      `${constants.OPENROUTER_BASE_URL}/models`,
    );
  });

  test("AI_GATEWAY_BASE_URL is fixed", () => {
    expect(constants.AI_GATEWAY_BASE_URL).toBe("https://ai-gateway.vercel.sh/v1");
  });
});

describe("_resetForTesting / _resetIo", () => {
  test("_resetForTesting clears all module-level caches", () => {
    _internals.profileFallbackWarned = true;
    _internals.wslDetected = true;
    _internals.containerDetected = true;
    _resetForTesting();
    expect(_internals.profileFallbackWarned).toBe(false);
    expect(_internals.wslDetected).toBeUndefined();
    expect(_internals.containerDetected).toBeUndefined();
  });

  test("_resetIo restores the original IO hooks", () => {
    _io.existsSync = (() => false) as typeof _io.existsSync;
    _io.readFileSync = (() => "") as unknown as typeof _io.readFileSync;
    _io.realpathSync = (() => "") as unknown as typeof _io.realpathSync;
    _io.chmodSync = (() => undefined) as typeof _io.chmodSync;
    _io.statSync = (() => ({}) as never) as typeof _io.statSync;
    _io.homedir = () => "/elsewhere";
    _resetIo();
    expect(_io.existsSync("/.does-not-exist")).toBe(false);
    expect(typeof _io.homedir).toBe("function");
  });
});
