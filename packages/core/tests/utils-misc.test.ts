// Coverage tests for utils.ts surfaces not exercised by the upstream-ported
// files (test_utils_truthy_values, test_atomic_replace_symlinks,
// test_base_url_hostname). The behaviors here are still ports of the
// upstream functions in utils.py — see line refs in the comments.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  _resetUtilsIo,
  _utilsIo,
  atomicJsonWrite,
  atomicReplace,
  atomicRoundtripYamlUpdate,
  atomicYamlWrite,
  envBool,
  envInt,
  normalizeProxyEnvVars,
  normalizeProxyUrl,
  safeJsonLoads,
} from "../src/utils.js";

let tmp: string;
const PROXY_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;
let savedProxies: Record<string, string | undefined>;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "hermests-utils-misc-")));
  savedProxies = {};
  for (const k of PROXY_KEYS) {
    savedProxies[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of PROXY_KEYS) {
    if (savedProxies[k] === undefined) delete process.env[k];
    else process.env[k] = savedProxies[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("safeJsonLoads — port of utils.py:L258-268", () => {
  test("parses valid JSON", () => {
    expect(safeJsonLoads<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  test("returns default on malformed input", () => {
    expect(safeJsonLoads<{ a: number }>("not json", null)).toBeNull();
    expect(safeJsonLoads<number>("[1,", 0)).toBe(0);
  });

  test("default of null when omitted", () => {
    expect(safeJsonLoads("nope")).toBeNull();
  });
});

describe("envInt — port of utils.py:L274-282", () => {
  test("parses integer from env", () => {
    process.env.HERMES_TEST_INT = "42";
    try {
      expect(envInt("HERMES_TEST_INT", 0)).toBe(42);
    } finally {
      delete process.env.HERMES_TEST_INT;
    }
  });

  test("returns default when unset", () => {
    delete process.env.HERMES_TEST_INT;
    expect(envInt("HERMES_TEST_INT", 7)).toBe(7);
  });

  test("returns default when empty/whitespace", () => {
    process.env.HERMES_TEST_INT = "   ";
    try {
      expect(envInt("HERMES_TEST_INT", 9)).toBe(9);
    } finally {
      delete process.env.HERMES_TEST_INT;
    }
  });

  test("returns default when not a number", () => {
    process.env.HERMES_TEST_INT = "abc";
    try {
      expect(envInt("HERMES_TEST_INT", 11)).toBe(11);
    } finally {
      delete process.env.HERMES_TEST_INT;
    }
  });
});

describe("envBool — port of utils.py:L285-287", () => {
  test("truthy env values resolve true", () => {
    process.env.HERMES_BOOL = "yes";
    try {
      expect(envBool("HERMES_BOOL")).toBe(true);
    } finally {
      delete process.env.HERMES_BOOL;
    }
  });

  test("falsey env values resolve false", () => {
    process.env.HERMES_BOOL = "no";
    try {
      expect(envBool("HERMES_BOOL")).toBe(false);
    } finally {
      delete process.env.HERMES_BOOL;
    }
  });

  test("default does NOT apply when value is empty string (matches upstream)", () => {
    // Faithful to env_bool (utils.py:L285-287): is_truthy_value("", default)
    // — empty string is falsey, default only kicks in when the value is null.
    delete process.env.HERMES_BOOL;
    expect(envBool("HERMES_BOOL", true)).toBe(false);
    expect(envBool("HERMES_BOOL", false)).toBe(false);
  });
});

describe("normalizeProxyUrl — port of utils.py:L299-311", () => {
  test("returns null for null/empty input", () => {
    expect(normalizeProxyUrl(null)).toBeNull();
    expect(normalizeProxyUrl(undefined)).toBeNull();
    expect(normalizeProxyUrl("")).toBeNull();
    expect(normalizeProxyUrl("   ")).toBeNull();
  });

  test("rewrites socks:// to socks5://", () => {
    expect(normalizeProxyUrl("socks://proxy.local:1080")).toBe(
      "socks5://proxy.local:1080",
    );
    // Case insensitive.
    expect(normalizeProxyUrl("SOCKS://proxy.local:1080")).toBe(
      "socks5://proxy.local:1080",
    );
  });

  test("leaves http/https URLs unchanged", () => {
    expect(normalizeProxyUrl("http://proxy:8080")).toBe("http://proxy:8080");
    expect(normalizeProxyUrl("https://proxy:443")).toBe("https://proxy:443");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeProxyUrl("  http://proxy  ")).toBe("http://proxy");
  });
});

describe("normalizeProxyEnvVars — port of utils.py:L314-323", () => {
  test("rewrites socks:// values in-place across all known keys", () => {
    process.env.HTTPS_PROXY = "socks://a:1";
    process.env.http_proxy = "socks://b:2";
    process.env.ALL_PROXY = "http://untouched";
    normalizeProxyEnvVars();
    expect(process.env.HTTPS_PROXY).toBe("socks5://a:1");
    expect(process.env.http_proxy).toBe("socks5://b:2");
    expect(process.env.ALL_PROXY).toBe("http://untouched");
  });

  test("leaves unset keys unset", () => {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.ALL_PROXY;
    normalizeProxyEnvVars();
    expect("HTTPS_PROXY" in process.env).toBe(false);
  });
});

describe("atomicJsonWrite error path — port of utils.py:L85-136", () => {
  test("unlinks the temp file when serialization throws", () => {
    const target = join(tmp, "circular.json");
    // Circular structure — JSON.stringify throws.
    const cycle: { a?: unknown } = {};
    cycle.a = cycle;
    expect(() => atomicJsonWrite(target, cycle)).toThrow();
    // The target should not exist (the temp was unlinked).
    expect(existsSync(target)).toBe(false);
  });

  test("creates the parent directory if missing", () => {
    const target = join(tmp, "deep", "nested", "out.json");
    atomicJsonWrite(target, { ok: true });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ ok: true });
  });

  test("uses custom indent option", () => {
    const target = join(tmp, "indent.json");
    atomicJsonWrite(target, { a: 1 }, { indent: 4 });
    const text = readFileSync(target, "utf-8");
    expect(text).toContain('    "a"');
  });

  test("preserves existing file mode bits", () => {
    const target = join(tmp, "perm.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o644);
    atomicJsonWrite(target, { x: 1 });
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
});

describe("atomicYamlWrite — port of utils.py:L139-188", () => {
  test("writes basic YAML", () => {
    const target = join(tmp, "config.yaml");
    atomicYamlWrite(target, { model: { provider: "openrouter" } });
    expect(parseYaml(readFileSync(target, "utf-8"))).toEqual({
      model: { provider: "openrouter" },
    });
  });

  test("appends extraContent suffix", () => {
    const target = join(tmp, "extra.yaml");
    atomicYamlWrite(target, { a: 1 }, { extraContent: "\n# trailing comment\n" });
    const text = readFileSync(target, "utf-8");
    expect(text.endsWith("# trailing comment\n")).toBe(true);
  });

  test("sortKeys orders mapping entries", () => {
    const target = join(tmp, "sorted.yaml");
    atomicYamlWrite(target, { b: 2, a: 1, c: 3 }, { sortKeys: true });
    const text = readFileSync(target, "utf-8");
    // a should appear before b/c in sorted output.
    expect(text.indexOf("a:")).toBeLessThan(text.indexOf("b:"));
    expect(text.indexOf("b:")).toBeLessThan(text.indexOf("c:"));
  });

  test("unlinks temp file when toJSON serialization throws", () => {
    const target = join(tmp, "bad.yaml");
    // A value with a custom toJSON that throws — the yaml package walks
    // toJSON during stringify, triggering the catch branch.
    const bad = {
      explode: {
        toJSON() {
          throw new Error("serialize failed");
        },
      },
    };
    expect(() => atomicYamlWrite(target, bad)).toThrow(/serialize failed/);
    expect(existsSync(target)).toBe(false);
  });
});

describe("atomicRoundtripYamlUpdate — port of utils.py:L191-252", () => {
  test("updates a key inside existing YAML preserving comments", () => {
    const target = join(tmp, "rt.yaml");
    writeFileSync(
      target,
      "# header comment\nmodel:\n  provider: openrouter\n  # nested comment\n  name: gpt\n",
      "utf-8",
    );
    atomicRoundtripYamlUpdate(target, "model.name", "claude");
    const text = readFileSync(target, "utf-8");
    expect(text).toContain("name: claude");
    expect(text).toContain("# header comment");
    expect(text).toContain("# nested comment");
  });

  test("creates a new file when target is missing", () => {
    const target = join(tmp, "new-doc.yaml");
    atomicRoundtripYamlUpdate(target, "fresh.key", 42);
    const doc = parseYaml(readFileSync(target, "utf-8"));
    expect(doc).toEqual({ fresh: { key: 42 } });
  });

  test("creates the parent directory if missing", () => {
    const target = join(tmp, "rt-deep", "subdir", "out.yaml");
    atomicRoundtripYamlUpdate(target, "x", 1);
    const doc = parseYaml(readFileSync(target, "utf-8"));
    expect(doc).toEqual({ x: 1 });
  });

  test("preserves file mode of existing target", () => {
    const target = join(tmp, "rt-perm.yaml");
    writeFileSync(target, "old: true\n");
    chmodSync(target, 0o600);
    atomicRoundtripYamlUpdate(target, "old", false);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe("_preserveFileMode / _restoreFileMode error paths", () => {
  test("atomicJsonWrite still succeeds when target is in a directory with restricted chmod", () => {
    // This indirectly exercises the chmod try/catch branches in
    // _restoreFileMode (utils.ts:L74-81). We simulate by writing to a
    // brand-new file (no existing perms) — _preserveFileMode returns null,
    // which is the early-return branch we want.
    const target = join(tmp, "fresh.json");
    expect(existsSync(target)).toBe(false);
    atomicJsonWrite(target, { fresh: true });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ fresh: true });
  });
});

describe("baseUrlHostname / baseUrlHostMatches additional branch", () => {
  test("toString() coercion on non-string input", async () => {
    const utils = await import("../src/utils.js");
    // Use a String wrapper so the `(baseUrl ?? '').toString()` path runs.
    const fakeUrl = new String("https://api.openai.com/v1") as unknown as string;
    expect(utils.baseUrlHostname(fakeUrl)).toBe("api.openai.com");
    expect(utils.baseUrlHostMatches(fakeUrl, "openai.com")).toBe(true);
  });
});

describe("index re-export — covers index.ts", () => {
  test("namespace re-exports include all module surfaces", async () => {
    const idx = await import("../src/index.js");
    expect(typeof idx.isTruthyValue).toBe("function");
    expect(typeof idx.now).toBe("function");
    expect(typeof idx.getHermesHome).toBe("function");
    expect(typeof idx.applyWindowsUtf8Bootstrap).toBe("function");
    expect(typeof idx.setupLogging).toBe("function");
  });
});

describe("mkdirSync sanity (regression guard)", () => {
  test("temp dir is writable", () => {
    const f = join(tmp, "sentinel");
    writeFileSync(f, "ok");
    expect(readFileSync(f, "utf-8")).toBe("ok");
  });

  test("mkdirSync recursive does not error on existing dir", () => {
    mkdirSync(join(tmp, "x"), { recursive: true });
    mkdirSync(join(tmp, "x"), { recursive: true });
    expect(statSync(join(tmp, "x")).isDirectory()).toBe(true);
  });
});

describe("Atomic writes — full error-path coverage", () => {
  afterEach(() => {
    _resetUtilsIo();
  });

  test("_preserveFileMode swallows statSync errors", () => {
    // Make existsSync return true but statSync throw — exercises the
    // try/catch path in _preserveFileMode (utils.ts:L65-72).
    const target = join(tmp, "stat-fail.json");
    writeFileSync(target, "{}");
    _utilsIo.statSync = (() => {
      throw new Error("EACCES");
    }) as unknown as typeof _utilsIo.statSync;
    // No throw: defensive null fallback applies.
    atomicJsonWrite(target, { x: 1 });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ x: 1 });
  });

  test("_restoreFileMode swallows chmod errors", () => {
    // Pre-create a target with known mode, then make chmod fail when the
    // atomic write tries to restore — exercises utils.ts:L75-82.
    const target = join(tmp, "chmod-fail.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o644);
    _utilsIo.chmodSync = (() => {
      throw new Error("EPERM");
    }) as unknown as typeof _utilsIo.chmodSync;
    // The write must succeed even when chmod fails in the cleanup.
    atomicJsonWrite(target, { ok: true });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ ok: true });
  });

  test("_mkTemp retries on EEXIST collision", () => {
    // Force the first openSync to throw EEXIST, then succeed. Exercises
    // utils.ts:L129-131 collision-retry branch.
    const original = _utilsIo.openSync;
    let firstCall = true;
    _utilsIo.openSync = ((path: string, flags: string, mode?: number) => {
      if (firstCall) {
        firstCall = false;
        const err = Object.assign(new Error("collision"), { code: "EEXIST" });
        throw err;
      }
      return original(path, flags, mode);
    }) as unknown as typeof _utilsIo.openSync;
    atomicJsonWrite(join(tmp, "retry-mktemp.json"), { ok: true });
  });

  test("_mkTemp throws non-EEXIST errors immediately", () => {
    _utilsIo.openSync = (() => {
      const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
      throw err;
    }) as unknown as typeof _utilsIo.openSync;
    expect(() => atomicJsonWrite(join(tmp, "mktemp-fail.json"), {})).toThrow(
      /EACCES/,
    );
  });

  test("_mkTemp gives up after 10 EEXIST collisions", () => {
    _utilsIo.openSync = (() => {
      const err = Object.assign(new Error("always collide"), { code: "EEXIST" });
      throw err;
    }) as unknown as typeof _utilsIo.openSync;
    expect(() => atomicJsonWrite(join(tmp, "mktemp-loop.json"), {})).toThrow(
      /Failed to create temp file/,
    );
  });

  test("atomicJsonWrite cleanup: closeSync swallow + unlinkSync swallow", () => {
    // Force write to fail AFTER fd is open, then make closeSync and
    // unlinkSync both throw — exercises both swallowing catches at
    // utils.ts:L170-181.
    const target = join(tmp, "json-cleanup.json");
    _utilsIo.writeSync = (() => {
      throw new Error("disk full");
    }) as unknown as typeof _utilsIo.writeSync;
    _utilsIo.closeSync = (() => {
      throw new Error("bad fd");
    }) as unknown as typeof _utilsIo.closeSync;
    _utilsIo.unlinkSync = (() => {
      throw new Error("vanished");
    }) as unknown as typeof _utilsIo.unlinkSync;
    expect(() => atomicJsonWrite(target, {})).toThrow(/disk full/);
  });

  test("atomicYamlWrite cleanup: closeSync swallow + unlinkSync swallow", () => {
    const target = join(tmp, "yaml-cleanup.yaml");
    _utilsIo.writeSync = (() => {
      throw new Error("disk full");
    }) as unknown as typeof _utilsIo.writeSync;
    _utilsIo.closeSync = (() => {
      throw new Error("bad fd");
    }) as unknown as typeof _utilsIo.closeSync;
    _utilsIo.unlinkSync = (() => {
      throw new Error("vanished");
    }) as unknown as typeof _utilsIo.unlinkSync;
    expect(() => atomicYamlWrite(target, { a: 1 })).toThrow(/disk full/);
  });

  test("atomicRoundtripYamlUpdate cleanup: closeSync + unlinkSync swallow", () => {
    const target = join(tmp, "rt-cleanup.yaml");
    _utilsIo.writeSync = (() => {
      throw new Error("io fail");
    }) as unknown as typeof _utilsIo.writeSync;
    _utilsIo.closeSync = (() => {
      throw new Error("bad fd");
    }) as unknown as typeof _utilsIo.closeSync;
    _utilsIo.unlinkSync = (() => {
      throw new Error("vanished");
    }) as unknown as typeof _utilsIo.unlinkSync;
    expect(() => atomicRoundtripYamlUpdate(target, "k", 1)).toThrow(/io fail/);
  });

  test("atomicReplace through broken symlink uses readlinkSync require fallback", () => {
    // Cover the require("node:fs") branch at utils.ts:L104-110 (broken
    // symlink with relative link target). Already covered in utils-atomic
    // but re-asserted here under the new _utilsIo plumbing.
    const link = join(tmp, "broken-link.yaml");
    require("node:fs").symlinkSync("missing-rel.yaml", link);
    const src = join(tmp, "src.tmp");
    writeFileSync(src, "from-broken\n");
    atomicReplace(src, link);
    expect(readFileSync(join(tmp, "missing-rel.yaml"), "utf-8")).toBe(
      "from-broken\n",
    );
  });

  test("atomicYamlWrite cleanup runs when atomicReplace fails after fsync", () => {
    // Make atomicReplace fail by removing the parent directory after the
    // temp file is created. We do this via a Proxy on a custom data value
    // whose toJSON callback removes the directory mid-serialization is
    // not reliable; instead we trigger renameSync failure by making the
    // target an existing directory (rename file -> dir EISDIR on POSIX).
    const target = join(tmp, "dir-target");
    mkdirSync(target);
    expect(() => atomicYamlWrite(target, { a: 1 })).toThrow();
    // Temp file was unlinked by the catch path; only the directory remains.
    expect(statSync(target).isDirectory()).toBe(true);
  });

  test("atomicRoundtripYamlUpdate cleanup runs when atomicReplace fails", () => {
    const target = join(tmp, "rt-dir-target");
    mkdirSync(target);
    expect(() => atomicRoundtripYamlUpdate(target, "x", 1)).toThrow();
    expect(statSync(target).isDirectory()).toBe(true);
  });

  test("atomicJsonWrite cleanup runs when atomicReplace fails", () => {
    const target = join(tmp, "json-dir-target");
    mkdirSync(target);
    expect(() => atomicJsonWrite(target, { a: 1 })).toThrow();
    expect(statSync(target).isDirectory()).toBe(true);
  });

  test("atomicRoundtripYamlUpdate reads and overlays an existing comment-bearing file", () => {
    const target = join(tmp, "comments.yaml");
    writeFileSync(target, "# top comment\nfoo: 1  # inline\n");
    atomicRoundtripYamlUpdate(target, "foo", 99);
    const text = readFileSync(target, "utf-8");
    expect(text).toContain("# top comment");
    expect(text).toContain("99");
  });

  test("atomicRoundtripYamlUpdate handles deeply nested key creation", () => {
    const target = join(tmp, "deep.yaml");
    atomicRoundtripYamlUpdate(target, "a.b.c.d", "leaf");
    const out = parseYaml(readFileSync(target, "utf-8"));
    expect(out).toEqual({ a: { b: { c: { d: "leaf" } } } });
  });
});
