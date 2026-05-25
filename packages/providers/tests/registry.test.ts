/**
 * Tests for `@hermests/providers/registry`.
 *
 * Combines:
 *   - In-scope cases from upstream `tests/providers/test_provider_profiles.py`
 *     (`TestRegistry` — registry semantics: register, alias, unknown returns
 *     None, registry consistency).
 *   - In-scope behavior from `tests/providers/test_plugin_discovery.py`:
 *     `test_user_plugin_overrides_bundled` (last-writer-wins) is ported as
 *     a fixture-driven test. The bundled-profile-count assertions defer to
 *     task #8 (plugins) — see `docs/deferred-tests.md`.
 *   - Branch coverage for the discovery code path (bundled dir present /
 *     absent, user dir present / absent, plugin entry present / absent,
 *     broken plugin load, getHermesHome throws).
 *
 * Provider-specific profile tests (Nvidia, Kimi, OpenRouter, etc.) and the
 * upstream `test_general_plugin_manager_skips_model_provider_kind` defer to
 * later tasks — see `docs/deferred-tests.md`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ProviderProfile } from "../src/base.js";
import {
  _getAliases,
  _getRegistry,
  _resetRegistry,
  _setBundledPluginsDirForTesting,
  getProviderProfile,
  listProviders,
  registerProvider,
} from "../src/registry.js";

// Every test starts from a clean registry — equivalent to the
// `_clear_provider_caches` helper inside upstream
// `tests/providers/test_plugin_discovery.py`.
beforeEach(() => {
  _resetRegistry();
  _setBundledPluginsDirForTesting(null);
});

afterEach(() => {
  _resetRegistry();
  _setBundledPluginsDirForTesting(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── registerProvider semantics — direct ports of upstream TestRegistry ─────

describe("registerProvider", () => {
  test("stores the profile under its canonical name", () => {
    const p = new ProviderProfile({ name: "nvidia", aliases: ["nvidia-nim"] });
    registerProvider(p);
    const reg = _getRegistry();
    expect(reg.get("nvidia")).toBe(p);
  });

  test("registers every alias against the canonical name", () => {
    const p = new ProviderProfile({
      name: "kimi-coding",
      aliases: ["kimi", "moonshot"],
    });
    registerProvider(p);
    const aliases = _getAliases();
    expect(aliases.get("kimi")).toBe("kimi-coding");
    expect(aliases.get("moonshot")).toBe("kimi-coding");
  });

  test("last writer wins for same canonical name", () => {
    const first = new ProviderProfile({
      name: "gmi",
      baseUrl: "https://first.example/v1",
    });
    const second = new ProviderProfile({
      name: "gmi",
      baseUrl: "https://second.example/v1",
    });
    registerProvider(first);
    registerProvider(second);
    expect(_getRegistry().get("gmi")).toBe(second);
  });
});

// ── getProviderProfile / listProviders — direct ports of TestRegistry ──────

describe("getProviderProfile", () => {
  test("returns the registered profile by canonical name", async () => {
    // The bundled-plugins-dir override empties the discovery side-effect so
    // we can pre-seed via registerProvider after the override is in place.
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    const p = new ProviderProfile({ name: "nvidia" });
    registerProvider(p);
    const found = await getProviderProfile("nvidia");
    expect(found).toBe(p);
    expect(found?.name).toBe("nvidia");
  });

  test("resolves an alias to the canonical profile", async () => {
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    const p = new ProviderProfile({
      name: "kimi-coding",
      aliases: ["kimi", "moonshot"],
    });
    registerProvider(p);
    expect((await getProviderProfile("kimi"))?.name).toBe("kimi-coding");
    expect((await getProviderProfile("moonshot"))?.name).toBe("kimi-coding");
    expect((await getProviderProfile("kimi-coding"))?.name).toBe("kimi-coding");
  });

  test("returns null for an unknown provider", async () => {
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    expect(await getProviderProfile("nonexistent-provider")).toBeNull();
  });

  test("every entry in the registry maps back to itself by name", async () => {
    // Direct port of `test_all_providers_have_name` semantics: the canonical
    // name in the registry map must match the profile's `name` field.
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    registerProvider(new ProviderProfile({ name: "alpha" }));
    registerProvider(new ProviderProfile({ name: "beta" }));
    // Trigger discovery so the "if (!_discovered)" branch is exercised
    // before we walk the registry.
    await getProviderProfile("alpha");
    for (const [name, profile] of _getRegistry()) {
      expect(profile.name).toBe(name);
    }
  });
});

describe("listProviders", () => {
  test("returns one entry per canonical profile (dedup by name)", async () => {
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    const a = new ProviderProfile({ name: "a", aliases: ["a-alias"] });
    const b = new ProviderProfile({ name: "b" });
    registerProvider(a);
    registerProvider(b);
    const out = await listProviders();
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.name).sort()).toEqual(["a", "b"]);
  });

  test("triggers discovery on first call", async () => {
    // No registrations yet; with bundled override pointed at an empty dir
    // and no HERMES_HOME set to a real plugin dir, listProviders returns [].
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    expect(await listProviders()).toEqual([]);
  });

  test("subsequent calls take the early-exit path (discovery is idempotent)", async () => {
    // Discovery is run once; later calls reuse the populated registry.
    const dir = _makeTempDir();
    _writePlugin(join(dir, "once"), { name: "once" });
    _setBundledPluginsDirForTesting(dir);
    const first = await listProviders();
    expect(first.map((p) => p.name)).toEqual(["once"]);
    // Adding a plugin AFTER discovery does not re-trigger it.
    _writePlugin(join(dir, "two"), { name: "two" });
    const second = await listProviders();
    expect(second.map((p) => p.name)).toEqual(["once"]);
  });

  test("concurrent first-call race awaits a single shared discovery promise", async () => {
    // Two parallel callers must both see the populated registry. Without
    // the cached discovery Promise, the second caller would race past
    // `_discovered = true` while the first is still mid-import and see an
    // empty registry. Direct test of the `_discoveryPromise` cache.
    const dir = _makeTempDir();
    _writePlugin(join(dir, "race"), { name: "race" });
    _setBundledPluginsDirForTesting(dir);
    const [a, b] = await Promise.all([listProviders(), listProviders()]);
    expect(a.map((p) => p.name)).toEqual(["race"]);
    expect(b.map((p) => p.name)).toEqual(["race"]);
  });
});

// ── Discovery — bundled + user paths, plus error branches ──────────────────

describe("plugin discovery — bundled path", () => {
  test("imports every bundled plugin entry module that exists", async () => {
    const dir = _makeTempDir();
    _writePlugin(join(dir, "alpha"), {
      name: "alpha",
      baseUrl: "https://alpha.example/v1",
    });
    _writePlugin(join(dir, "beta"), {
      name: "beta",
      baseUrl: "https://beta.example/v1",
    });
    _setBundledPluginsDirForTesting(dir);
    const names = (await listProviders()).map((p) => p.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  test("skips directories whose name starts with `_` or `.`", async () => {
    const dir = _makeTempDir();
    _writePlugin(join(dir, "_hidden"), { name: "hidden" });
    _writePlugin(join(dir, ".dotfile"), { name: "dot" });
    _writePlugin(join(dir, "visible"), { name: "visible" });
    _setBundledPluginsDirForTesting(dir);
    const names = (await listProviders()).map((p) => p.name);
    expect(names).toEqual(["visible"]);
  });

  test("skips plain files at the top level", async () => {
    const dir = _makeTempDir();
    writeFileSync(join(dir, "stray.txt"), "not-a-plugin\n");
    _writePlugin(join(dir, "real"), { name: "real" });
    _setBundledPluginsDirForTesting(dir);
    const names = (await listProviders()).map((p) => p.name);
    expect(names).toEqual(["real"]);
  });

  test("plugin dir without an index entry is silently skipped", async () => {
    const dir = _makeTempDir();
    mkdirSync(join(dir, "empty"), { recursive: true });
    _writePlugin(join(dir, "good"), { name: "good" });
    _setBundledPluginsDirForTesting(dir);
    const names = (await listProviders()).map((p) => p.name);
    expect(names).toEqual(["good"]);
  });

  test("broken plugin load is caught, logged, and does not abort discovery", async () => {
    const dir = _makeTempDir();
    const broken = join(dir, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "index.mjs"), "throw new Error('boom');\n");
    _writePlugin(join(dir, "good"), { name: "survives" });
    _setBundledPluginsDirForTesting(dir);
    const names = (await listProviders()).map((p) => p.name);
    expect(names).toEqual(["survives"]);
  });

  test("bundled dir not present is a no-op", async () => {
    const ghost = join(_makeTempDir(), "does-not-exist");
    _setBundledPluginsDirForTesting(ghost);
    // Falls through to the user-plugin path; with HERMES_HOME pointing at a
    // tmp dir with no plugins/ subdir, registry stays empty.
    vi.stubEnv("HERMES_HOME", _makeTempDir());
    expect(await listProviders()).toEqual([]);
  });

  test("readdirSync failure on bundled dir produces empty children list", async () => {
    // Exercises the catch arm of `_sortedChildDirs`. We use `chmod 0o000`
    // on a real temp dir so `statSync` still reports it as a directory
    // (via the chmod-victim path's metadata) but `readdirSync` fails with
    // EACCES on POSIX. Restored to 0o700 in cleanup so rmSync works.
    if (process.platform === "win32") {
      // Windows has no portable equivalent; the branch is exercised on
      // POSIX runners. CI is Linux-based.
      return;
    }
    const dir = _makeTempDir();
    const { chmodSync } = await import("node:fs");
    chmodSync(dir, 0o000);
    try {
      _setBundledPluginsDirForTesting(dir);
      expect(await listProviders()).toEqual([]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe("plugin discovery — user path", () => {
  test("loads plugins from $HERMES_HOME/plugins/model-providers/<name>/", async () => {
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    const hermesHome = _makeTempDir();
    const userPlugins = join(hermesHome, "plugins", "model-providers", "userprov");
    mkdirSync(userPlugins, { recursive: true });
    _writeIndex(userPlugins, {
      name: "userprov",
      baseUrl: "https://user.example/v1",
    });
    vi.stubEnv("HERMES_HOME", hermesHome);
    const found = await getProviderProfile("userprov");
    expect(found).not.toBeNull();
    expect(found?.baseUrl).toBe("https://user.example/v1");
  });

  test("user plugin overrides bundled profile of the same name (last-writer-wins)", async () => {
    // Direct port of upstream `test_user_plugin_overrides_bundled`.
    const bundled = _makeTempDir();
    _writePlugin(join(bundled, "gmi"), {
      name: "gmi",
      baseUrl: "https://bundled.example/v1",
    });
    _setBundledPluginsDirForTesting(bundled);

    const hermesHome = _makeTempDir();
    const userGmi = join(hermesHome, "plugins", "model-providers", "gmi");
    mkdirSync(userGmi, { recursive: true });
    _writeIndex(userGmi, {
      name: "gmi",
      aliases: ["gmi-user-override-test"],
      baseUrl: "https://user-override.example.com/v1",
    });
    vi.stubEnv("HERMES_HOME", hermesHome);

    const gmi = await getProviderProfile("gmi");
    expect(gmi).not.toBeNull();
    expect(gmi?.baseUrl).toBe("https://user-override.example.com/v1");
    expect(gmi?.aliases).toContain("gmi-user-override-test");
  });

  test("user dir absent → discovery proceeds without error", async () => {
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    // Point HERMES_HOME at a tmp dir with no `plugins/` subdirectory.
    vi.stubEnv("HERMES_HOME", _makeTempDir());
    expect(await listProviders()).toEqual([]);
  });

  test("getHermesHome throw is caught and user-dir lookup returns null", async () => {
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    // Stub the core import so getHermesHome throws — exercises the
    // `try/catch` in `_userPluginsDir`. The dynamic re-import below is
    // what registry.ts uses internally, so this is sufficient.
    const core = await import("@hermests/core");
    vi.spyOn(core, "getHermesHome").mockImplementation(() => {
      throw new Error("no home configured");
    });
    // Discovery still completes; registry stays empty.
    expect(await listProviders()).toEqual([]);
  });
});

// ── _resetRegistry and accessor seams ───────────────────────────────────────

describe("internal helpers", () => {
  test("_resetRegistry clears registry, aliases, and discovery flag", async () => {
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    registerProvider(new ProviderProfile({ name: "x", aliases: ["x-alias"] }));
    expect(_getRegistry().size).toBe(1);
    expect(_getAliases().size).toBe(1);
    // Force discovered=true via listProviders.
    await listProviders();
    _resetRegistry();
    expect(_getRegistry().size).toBe(0);
    expect(_getAliases().size).toBe(0);
    // After reset, the next call re-discovers (no profile in the empty
    // bundled dir, so registry stays empty — but the discovery flag flips).
    expect(await listProviders()).toEqual([]);
  });

  test("_getRegistry and _getAliases return live maps that reflect new registrations", () => {
    registerProvider(new ProviderProfile({ name: "live", aliases: ["live-alias"] }));
    expect(_getRegistry().has("live")).toBe(true);
    expect(_getAliases().get("live-alias")).toBe("live");
  });

  test("_setBundledPluginsDirForTesting(null) restores the default resolver", async () => {
    // After setting and then clearing the override, the next discovery uses
    // the computed default. We don't assert what that default is — only
    // that discovery still completes without throwing.
    _setBundledPluginsDirForTesting(_makeEmptyDir());
    await listProviders();
    _resetRegistry();
    _setBundledPluginsDirForTesting(null);
    // Empty $HERMES_HOME so no real user plugins interfere.
    vi.stubEnv("HERMES_HOME", _makeTempDir());
    await expect(listProviders()).resolves.toBeInstanceOf(Array);
  });
});

// ── test fixtures ──────────────────────────────────────────────────────────

const _tmpDirs: string[] = [];

afterEach(() => {
  while (_tmpDirs.length > 0) {
    const d = _tmpDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

function _makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hermests-providers-"));
  _tmpDirs.push(d);
  return d;
}

function _makeEmptyDir(): string {
  // A dir that exists but contains nothing — exercises the `_isDir → true`
  // bundled branch with no children.
  return _makeTempDir();
}

interface PluginFixture {
  name: string;
  aliases?: string[];
  baseUrl?: string;
}

function _writePlugin(dir: string, fixture: PluginFixture): void {
  mkdirSync(dir, { recursive: true });
  _writeIndex(dir, fixture);
}

function _writeIndex(dir: string, fixture: PluginFixture): void {
  // Each fixture must be loadable as ESM and self-register on import.
  // The dynamic import URL in registry.ts is a file:// URL, and we point
  // at the public package surface via a relative path inside the test.
  // We resolve the path to the providers source absolutely so the
  // generated plugin file imports our actual implementation.
  const providersSrc = join(process.cwd(), "packages", "providers", "src", "index.ts");
  const aliases = fixture.aliases ? JSON.stringify(fixture.aliases) : "[]";
  const baseUrl = JSON.stringify(fixture.baseUrl ?? "");
  const name = JSON.stringify(fixture.name);
  // Use .mjs so the file is recognized as ESM regardless of nearby
  // package.json `type` settings. Import the source directly — vitest
  // resolves .ts via its transform pipeline.
  const body =
    `import { ProviderProfile, registerProvider } from ${JSON.stringify(providersSrc)};\n` +
    `registerProvider(new ProviderProfile({ name: ${name}, aliases: ${aliases}, baseUrl: ${baseUrl} }));\n`;
  writeFileSync(join(dir, "index.mjs"), body);
}
