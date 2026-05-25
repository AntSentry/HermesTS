/**
 * Provider module registry.
 *
 * Faithful port of upstream `providers/__init__.py`.
 *
 * Provider profiles can live in two places:
 *
 *   1. Bundled plugins: `plugins/model-providers/<name>/` (shipped with hermests)
 *   2. User plugins: `$HERMES_HOME/plugins/model-providers/<name>/`
 *
 * Each plugin directory contains an entry module (`index.js`, `index.mjs`,
 * or `index.ts`) that calls `registerProvider(profile)` at import. Manifest
 * (`plugin.yaml`) is consumed by the downstream plugin manager — the
 * registry itself only cares about the entry module.
 *
 * Discovery is lazy: the first call to `getProviderProfile()` or
 * `listProviders()` scans both locations and dynamically imports every
 * plugin. User plugins override bundled plugins on name collision
 * (last-writer-wins), so third parties can monkey-patch or replace any
 * built-in profile without editing the repo.
 *
 * Divergences from upstream documented in README.md.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getHermesHome, getLogger } from "@hermests/core";

import type { ProviderProfile } from "./base.js";

const logger = getLogger("providers");

// Module-level registry state. ESM bindings give us the same singleton
// behavior Python module-level globals provide.
const _REGISTRY = new Map<string, ProviderProfile>();
const _ALIASES = new Map<string, string>();
let _discovered = false;

// Cached discovery promise — ensures concurrent callers wait for the same
// async work to finish (Python gets this for free via sync `import`; TS
// dynamic `import()` is async, so we serialize explicitly).
let _discoveryPromise: Promise<void> | null = null;

// Test seam: overrides the computed bundled-plugins dir. Production code
// never sets this; tests set it via `_setBundledPluginsDirForTesting` so
// they can exercise both the present-and-absent branches of discovery
// without touching real workspace directories.
let _bundledPluginsDirOverride: string | null = null;

/**
 * Repo-root `plugins/model-providers/` — populated at discovery time.
 *
 * Upstream computes this as `Path(__file__).parent.parent / "plugins" /
 * "model-providers"`. In TS the equivalent climbs from this source file
 * up to the workspace root, then into `plugins/model-providers/`.
 *
 * In the published workspace layout the providers package lives at
 * `packages/providers/src/registry.ts` and the plugins workspace lives
 * at `packages/plugins/`. The plugin profiles themselves get bundled at
 * `packages/plugins/model-providers/<name>/` — exposed here.
 */
function _bundledPluginsDir(): string {
  if (_bundledPluginsDirOverride !== null) {
    return _bundledPluginsDirOverride;
  }
  // `import.meta.url` works in both ESM source and compiled output.
  // resolve(...) collapses the `..` segments.
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/providers/src/ -> packages/providers/ -> packages/
  return resolve(here, "..", "..", "plugins", "model-providers");
}

/**
 * Test-only override for the bundled plugins directory. Pass `null` to
 * restore the default (climb to `packages/plugins/model-providers/`).
 */
export function _setBundledPluginsDirForTesting(path: string | null): void {
  _bundledPluginsDirOverride = path;
}

/**
 * Register a provider profile by name and aliases.
 *
 * Later registrations with the same name replace earlier ones — so user
 * plugins under `$HERMES_HOME/plugins/model-providers/` can override
 * bundled profiles without editing repo code.
 *
 * Faithful to `register_provider` (upstream py:L53-62).
 */
export function registerProvider(profile: ProviderProfile): void {
  _REGISTRY.set(profile.name, profile);
  for (const alias of profile.aliases) {
    _ALIASES.set(alias, profile.name);
  }
}

/**
 * Look up a provider profile by name or alias.
 *
 * Returns `null` if the provider has no profile (caller falls back to
 * generic). Faithful to `get_provider_profile` (upstream py:L65-73).
 *
 * Triggers lazy discovery on first call.
 */
export async function getProviderProfile(name: string): Promise<ProviderProfile | null> {
  await _ensureDiscovered();
  const canonical = _ALIASES.get(name) ?? name;
  return _REGISTRY.get(canonical) ?? null;
}

/**
 * Return all registered provider profiles (one per canonical name).
 *
 * Faithful to `list_providers` (upstream py:L76-88).
 */
export async function listProviders(): Promise<ProviderProfile[]> {
  await _ensureDiscovered();
  // Map values are already deduplicated by canonical name. Upstream uses
  // `id()` against the value set, but a Map keyed on name already gives
  // one entry per canonical profile.
  return Array.from(_REGISTRY.values());
}

/**
 * Serialize discovery: every caller awaits the same Promise on first use.
 * Once discovery resolves, callers see the populated registry directly
 * without re-entering the async path.
 */
async function _ensureDiscovered(): Promise<void> {
  if (_discovered) {
    return;
  }
  if (_discoveryPromise === null) {
    _discoveryPromise = _discoverProviders().then(() => {
      _discovered = true;
    });
  }
  await _discoveryPromise;
}

/**
 * Force the registry to re-discover on next access. Test-only helper.
 *
 * Equivalent to the `_clear_provider_caches` helper inside upstream
 * `tests/providers/test_plugin_discovery.py`.
 */
export function _resetRegistry(): void {
  _REGISTRY.clear();
  _ALIASES.clear();
  _discovered = false;
  _discoveryPromise = null;
}

/** Internal accessor for tests that need to inspect the live registry map. */
export function _getRegistry(): ReadonlyMap<string, ProviderProfile> {
  return _REGISTRY;
}

/** Internal accessor for tests that need to inspect the alias map. */
export function _getAliases(): ReadonlyMap<string, string> {
  return _ALIASES;
}

/**
 * Return `$HERMES_HOME/plugins/model-providers/` if it exists.
 *
 * Faithful to `_user_plugins_dir` (upstream py:L91-99).
 */
function _userPluginsDir(): string | null {
  try {
    const d = join(getHermesHome(), "plugins", "model-providers");
    return _isDir(d) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Find the plugin entry module within a directory. Returns the first
 * matching path or `null` if none exists.
 *
 * Upstream looks for `__init__.py`. In TS/ESM we accept three forms in
 * priority order so plugins authored as either compiled JS or source TS
 * (under a TS-native runtime like Bun) both work:
 *   - index.js
 *   - index.mjs
 *   - index.ts
 */
function _findPluginEntry(pluginDir: string): string | null {
  for (const name of ["index.js", "index.mjs", "index.ts"]) {
    const candidate = join(pluginDir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Import a single plugin directory so it self-registers.
 *
 * `source` is "bundled" or "user", used only for log messages.
 *
 * Faithful to `_import_plugin_dir` (upstream py:L102-137).
 */
async function _importPluginDir(pluginDir: string, source: string): Promise<void> {
  const entry = _findPluginEntry(pluginDir);
  if (!entry) {
    return;
  }

  try {
    // ESM dynamic import is cached by URL — re-importing the same plugin
    // dir is a no-op, which matches the upstream `sys.modules` check.
    await import(pathToFileURL(entry).href);
  } catch (exc) {
    logger.warning(
      `Failed to load ${source} provider plugin ${basename(pluginDir)}: ${String(exc)}`,
    );
  }
}

/**
 * Populate the registry by importing every provider plugin.
 *
 * Order:
 *   1. Bundled plugins at `<workspace>/packages/plugins/model-providers/<name>/`
 *   2. User plugins at `$HERMES_HOME/plugins/model-providers/<name>/`
 *
 * Each step imports its plugins, which call `registerProvider()` at
 * module-level. Later steps win on name collision.
 *
 * Divergence: upstream has a third step that imports `providers/<name>.py`
 * legacy single-file modules via `pkgutil.iter_modules`. TS/ESM has no
 * direct analogue (no editable-install + `.ts` hot-import without a build
 * step), so that path is intentionally not ported. The README documents
 * the divergence.
 *
 * Faithful to `_discover_providers` (upstream py:L140-191).
 */
async function _discoverProviders(): Promise<void> {
  // 1. Bundled plugins — shipped with hermests.
  const bundled = _bundledPluginsDir();
  if (_isDir(bundled)) {
    const children = _sortedChildDirs(bundled);
    for (const child of children) {
      await _importPluginDir(child, "bundled");
    }
  }

  // 2. User plugins — under $HERMES_HOME/plugins/model-providers/<name>/.
  //    These can override any bundled profile of the same name
  //    (last-writer-wins in registerProvider()).
  const userDir = _userPluginsDir();
  if (userDir !== null) {
    const children = _sortedChildDirs(userDir);
    for (const child of children) {
      await _importPluginDir(child, "user");
    }
  }
}

// ── filesystem helpers (private, tested via the public discovery API) ───────

function _isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function _sortedChildDirs(parent: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith("_") || name.startsWith(".")) {
      continue;
    }
    const full = join(parent, name);
    if (_isDir(full)) {
      out.push(full);
    }
  }
  return out;
}
