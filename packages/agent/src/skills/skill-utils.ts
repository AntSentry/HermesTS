/**
 * Lightweight skill metadata utilities shared by prompt-builder and the
 * skills tool — port of upstream `agent/skill_utils.py`.
 *
 * This module intentionally avoids importing the tool registry, CLI
 * config, or any heavy dependency chain so it can be imported safely at
 * any layer.
 *
 * Faithful divergences from upstream:
 *   - `sys.platform` → `process.platform`. The Termux escape hatch maps
 *     identically since Node reports `"android"` only when running under
 *     Termux/Bionic builds.
 *   - `os.path.expanduser` / `os.path.expandvars` are inlined manually
 *     because Node has no direct equivalent. Upstream py:L304-305.
 *   - Cache key uses `mtimeMs` instead of upstream's `mtime_ns` because
 *     `fs.statSync` returns ms, not ns. The semantic — invalidate when
 *     the config file is edited mid-process — is preserved exactly.
 *   - `Path.parts` → manual split by `/` because Node has no equivalent.
 *   - The lazy YAML loader caches a parser function the same way upstream
 *     caches `CSafeLoader` — but TS has no `CSafeLoader` distinction, so
 *     the cached function is always the `yaml` package's `parse`.
 */

import { dirname, isAbsolute as pathIsAbsolute, join, parse as parsePath, resolve, sep } from "node:path";

import {
  _io as _coreIo,
  getConfigPath,
  getHermesHome,
  getSkillsDir,
  isTermux,
} from "@hermests/core";
import { parse as parseYamlRaw } from "yaml";

import { getAgentFsHooks, getSessionContextHooks } from "../extensions/index.js";
import { defaultFsHooks } from "../extensions/default-fs.js";

function fs() {
  return getAgentFsHooks() ?? defaultFsHooks;
}

// ─── Platform mapping ──────────────────────────────────────────────────

export const PLATFORM_MAP: Readonly<Record<string, string>> = Object.freeze({
  macos: "darwin",
  linux: "linux",
  windows: "win32",
});

export const EXCLUDED_SKILL_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".github",
  ".hub",
  ".archive",
  ".venv",
  "venv",
  "node_modules",
  "site-packages",
  "__pycache__",
  ".tox",
  ".nox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

/**
 * True if any component of *path* is in EXCLUDED_SKILL_DIRS.
 *
 * Mirrors upstream `is_excluded_skill_path` (py:L47-62). Accepts a path
 * string and splits on the platform separator (and forward slash, which
 * is also valid on Windows and ubiquitous in test fixtures).
 */
export function isExcludedSkillPath(path: string): boolean {
  // Split on either separator so we behave identically on POSIX hosts
  // looking at Windows-style fixtures and vice-versa.
  const parts = path.split(/[\\/]+/).filter((p) => p.length > 0);
  for (const part of parts) {
    if (EXCLUDED_SKILL_DIRS.has(part)) return true;
  }
  return false;
}

// ─── Lazy YAML loader ──────────────────────────────────────────────────

let _yamlLoadFn: ((content: string) => unknown) | null = null;

/**
 * Parse YAML with lazy import. Mirrors upstream `yaml_load` (py:L70-82).
 *
 * The lazy-init wrapper is preserved so test substitution via
 * `_setYamlLoaderForTests` lines up 1:1 with upstream's `_yaml_load_fn`
 * monkey-patch sites.
 */
export function yamlLoad(content: string): unknown {
  if (_yamlLoadFn === null) {
    _yamlLoadFn = (value: string) => parseYamlRaw(value);
  }
  return _yamlLoadFn(content);
}

/** Test hook — replace the cached YAML loader. */
export function _setYamlLoaderForTests(fn: ((content: string) => unknown) | null): void {
  _yamlLoadFn = fn;
}

// ─── Frontmatter parsing ──────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown string. Returns `[frontmatter,
 * body]`. Uses the YAML loader for full nested support and falls back to
 * simple `key: value` splitting when YAML parsing fails — matches
 * upstream py:L88-122.
 */
export function parseFrontmatter(content: string): [Record<string, unknown>, string] {
  let frontmatter: Record<string, unknown> = {};
  let body = content;

  if (!content.startsWith("---")) {
    return [frontmatter, body];
  }

  // Upstream regex: r"\n---\s*\n" applied to content[3:]
  const tail = content.slice(3);
  const endMatch = /\n---\s*\n/.exec(tail);
  if (!endMatch) {
    return [frontmatter, body];
  }

  const yamlContent = content.slice(3, endMatch.index + 3);
  body = content.slice(endMatch.index + endMatch[0].length + 3);

  try {
    const parsed = yamlLoad(yamlContent);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // Fallback: simple key:value parsing for malformed YAML.
    frontmatter = {};
    for (const lineRaw of yamlContent.trim().split("\n")) {
      const line = lineRaw;
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      frontmatter[key] = value;
    }
  }

  return [frontmatter, body];
}

// ─── Platform matching ─────────────────────────────────────────────────

/**
 * Override hook for `process.platform`. Defaults to the Node value but
 * tests substitute it the way upstream patches `sys.platform`.
 */
function _defaultPlatformGet(): string {
  return process.platform as string;
}

export const _platformProvider: { get(): string } = {
  get: _defaultPlatformGet,
};

/** Test hook — replace the platform provider (and restore via reset). */
export function _setPlatformForTests(platform: string | null): void {
  _platformProvider.get = platform === null ? _defaultPlatformGet : () => platform;
}

/**
 * Termux indirection: tests stub this without having to monkey-patch
 * `@hermests/core`. Defaults to the real `isTermux()`.
 */
function _defaultTermuxGet(): boolean {
  return isTermux();
}

export const _termuxProvider: { get(): boolean } = {
  get: _defaultTermuxGet,
};

/** Test hook — replace the Termux provider. */
export function _setIsTermuxForTests(value: boolean | null): void {
  _termuxProvider.get = value === null ? _defaultTermuxGet : () => value;
}

/**
 * Return True when the skill is compatible with the current OS.
 *
 * Faithful to upstream `skill_matches_platform` (py:L128-169). The
 * Termux escape hatch is preserved: skills tagged `linux` load when
 * running under Termux regardless of whether Python (or Node) reports
 * the platform as `"linux"` or `"android"`.
 */
export function skillMatchesPlatform(frontmatter: Record<string, unknown>): boolean {
  const platformsRaw = frontmatter["platforms"];
  if (!platformsRaw) return true;

  const platforms: unknown[] = Array.isArray(platformsRaw) ? platformsRaw : [platformsRaw];
  if (platforms.length === 0) return true;

  const current = _platformProvider.get();
  const runningInTermux = _termuxProvider.get();

  for (const platform of platforms) {
    const normalized = String(platform).toLowerCase().trim();
    const mapped = PLATFORM_MAP[normalized] ?? normalized;
    if (current.startsWith(mapped)) return true;
    if (runningInTermux && mapped === "linux") return true;
    if (runningInTermux && (mapped === "termux" || mapped === "android")) return true;
  }
  return false;
}

// ─── Disabled skills ───────────────────────────────────────────────────

function _normalizeStringSet(values: unknown): Set<string> {
  if (values === null || values === undefined) return new Set();
  const list = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
  const out = new Set<string>();
  for (const v of list) {
    const s = String(v).trim();
    if (s) out.add(s);
  }
  return out;
}

/**
 * Read disabled skill names from config.yaml.
 *
 * Mirrors upstream `get_disabled_skill_names` (py:L175-214). Reads the
 * config file directly to stay lightweight; honors `HERMES_PLATFORM`,
 * `HERMES_SESSION_PLATFORM`, and the explicit *platform* argument when
 * resolving which platform-scoped disabled list applies.
 *
 * Upstream `from gateway.session_context import get_session_env` is
 * routed through the extension registry — without an installed
 * sessionContext hook the session-platform check is silently skipped,
 * matching upstream's "if the import fails we still degrade cleanly"
 * intent.
 */
export function getDisabledSkillNames(platform: string | null = null): Set<string> {
  const configPath = getConfigPath();
  if (!fs().existsSync(configPath)) return new Set();

  let parsed: unknown;
  try {
    parsed = yamlLoad(fs().readTextSync(configPath));
  } catch {
    return new Set();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Set();
  }

  const skillsCfg = (parsed as Record<string, unknown>)["skills"];
  if (!skillsCfg || typeof skillsCfg !== "object" || Array.isArray(skillsCfg)) {
    return new Set();
  }

  // Resolve which platform's list applies: explicit arg > HERMES_PLATFORM
  // env > gateway session context. Mirrors upstream's late
  // `from gateway.session_context import get_session_env` (py:L202).
  const sessionHooks = getSessionContextHooks();
  const resolvedPlatform =
    platform ??
    process.env["HERMES_PLATFORM"] ??
    (sessionHooks ? sessionHooks.getSessionEnv("HERMES_SESSION_PLATFORM", "") : "");

  if (resolvedPlatform) {
    const platformDisabledMap = (skillsCfg as Record<string, unknown>)["platform_disabled"];
    if (platformDisabledMap && typeof platformDisabledMap === "object" && !Array.isArray(platformDisabledMap)) {
      const candidate = (platformDisabledMap as Record<string, unknown>)[resolvedPlatform];
      if (candidate !== undefined && candidate !== null) {
        return _normalizeStringSet(candidate);
      }
    }
  }
  return _normalizeStringSet((skillsCfg as Record<string, unknown>)["disabled"]);
}

// ─── External skills directories ───────────────────────────────────────

interface ExternalDirsCacheKey {
  path: string;
  mtimeMs: number;
}

const _EXTERNAL_DIRS_CACHE = new Map<string, string[]>();

/** Test hook — drop the in-process cache. Mirrors upstream py:L237-238. */
export function _externalDirsCacheClear(): void {
  _EXTERNAL_DIRS_CACHE.clear();
}

function _cacheKeyToString(key: ExternalDirsCacheKey): string {
  return `${key.path}::${key.mtimeMs}`;
}

/**
 * Read `skills.external_dirs` from config.yaml and return validated
 * paths. Mirrors upstream `get_external_skills_dirs` (py:L241-324).
 *
 * Cached in-process by (config path, mtime) so a config edit mid-run is
 * picked up automatically. The cache keeps banner construction cheap
 * when 120+ skills each call this during startup.
 */
export function getExternalSkillsDirs(): string[] {
  const configPath = getConfigPath();
  if (!fs().existsSync(configPath)) return [];

  let cacheKey: ExternalDirsCacheKey | null = null;
  try {
    const st = fs().statSync(configPath);
    cacheKey = { path: configPath, mtimeMs: st.mtimeMs };
  } catch {
    cacheKey = null;
  }

  if (cacheKey !== null) {
    const cached = _EXTERNAL_DIRS_CACHE.get(_cacheKeyToString(cacheKey));
    if (cached !== undefined) {
      // Return a copy so callers can't mutate the cached list.
      return [...cached];
    }
  }

  let parsed: unknown;
  try {
    parsed = yamlLoad(fs().readTextSync(configPath));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const skillsCfg = (parsed as Record<string, unknown>)["skills"];
  if (!skillsCfg || typeof skillsCfg !== "object" || Array.isArray(skillsCfg)) {
    return [];
  }

  let rawDirs = (skillsCfg as Record<string, unknown>)["external_dirs"];
  if (rawDirs === undefined || rawDirs === null || rawDirs === "" || (Array.isArray(rawDirs) && rawDirs.length === 0)) {
    const empty: string[] = [];
    if (cacheKey !== null) _EXTERNAL_DIRS_CACHE.set(_cacheKeyToString(cacheKey), [...empty]);
    return empty;
  }
  if (typeof rawDirs === "string") rawDirs = [rawDirs];
  if (!Array.isArray(rawDirs)) return [];

  // Resolve relative paths against HERMES_HOME (mirrors upstream).
  const hermesHome = getHermesHome();
  const localSkills = resolveCanonical(getSkillsDir());

  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of rawDirs as unknown[]) {
    const trimmed = String(entry).trim();
    if (!trimmed) continue;
    const expanded = _expandUserAndVars(trimmed);
    let p = expanded;
    if (!pathIsAbsolute(p)) {
      p = resolveCanonical(join(hermesHome, p));
    } else {
      p = resolveCanonical(p);
    }
    if (p === localSkills) continue;
    if (seen.has(p)) continue;
    if (_isDir(p)) {
      seen.add(p);
      result.push(p);
    }
  }

  if (cacheKey !== null) _EXTERNAL_DIRS_CACHE.set(_cacheKeyToString(cacheKey), [...result]);
  return result;
}

function _isDir(path: string): boolean {
  try {
    return fs().statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveCanonical(path: string): string {
  try {
    return _coreIo.realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Expand `~` and `${VAR}` references in *value*.
 *
 * Mirrors Python's `os.path.expanduser(os.path.expandvars(...))` chain
 * — but Node has no equivalent so we re-implement it explicitly. Only
 * the leading `~` is expanded (matches upstream); `${VAR}` is expanded
 * anywhere in the string.
 */
function _expandUserAndVars(value: string): string {
  // expandvars first to match upstream nesting order
  const varsExpanded = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const fromEnv = process.env[name];
    return fromEnv ?? `\${${name}}`;
  });
  if (varsExpanded === "~") {
    return _coreIo.homedir();
  }
  if (varsExpanded.startsWith("~/") || varsExpanded.startsWith(`~${sep}`)) {
    return join(_coreIo.homedir(), varsExpanded.slice(2));
  }
  return varsExpanded;
}

/**
 * Return all skill directories: local first, then external in config
 * order. Mirrors upstream `get_all_skills_dirs` (py:L327-335). The local
 * dir is always first and always included even if it doesn't exist —
 * callers handle absence.
 */
export function getAllSkillsDirs(): string[] {
  return [getSkillsDir(), ...getExternalSkillsDirs()];
}

// ─── Condition extraction ──────────────────────────────────────────────

export interface SkillConditions {
  fallback_for_toolsets: unknown[];
  requires_toolsets: unknown[];
  fallback_for_tools: unknown[];
  requires_tools: unknown[];
}

/**
 * Extract conditional activation fields from parsed frontmatter.
 * Mirrors upstream `extract_skill_conditions` (py:L341-355).
 */
export function extractSkillConditions(frontmatter: Record<string, unknown>): SkillConditions {
  const metadataRaw = frontmatter["metadata"];
  const metadata =
    metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
      ? (metadataRaw as Record<string, unknown>)
      : {};
  const hermesRaw = metadata["hermes"];
  const hermes =
    hermesRaw && typeof hermesRaw === "object" && !Array.isArray(hermesRaw)
      ? (hermesRaw as Record<string, unknown>)
      : {};
  return {
    fallback_for_toolsets: _ensureList(hermes["fallback_for_toolsets"]),
    requires_toolsets: _ensureList(hermes["requires_toolsets"]),
    fallback_for_tools: _ensureList(hermes["fallback_for_tools"]),
    requires_tools: _ensureList(hermes["requires_tools"]),
  };
}

function _ensureList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

// ─── Skill config extraction ───────────────────────────────────────────

export interface SkillConfigVar {
  key: string;
  description: string;
  prompt: string;
  default?: unknown;
  skill?: string;
}

/**
 * Extract config variable declarations from parsed frontmatter.
 *
 * Mirrors upstream `extract_skill_config_vars` (py:L361-417). Skills
 * declare config.yaml settings they need under
 * `metadata.hermes.config[]`. Invalid or incomplete entries are
 * silently skipped.
 */
export function extractSkillConfigVars(frontmatter: Record<string, unknown>): SkillConfigVar[] {
  const metadataRaw = frontmatter["metadata"];
  if (!metadataRaw || typeof metadataRaw !== "object" || Array.isArray(metadataRaw)) return [];
  const hermesRaw = (metadataRaw as Record<string, unknown>)["hermes"];
  if (!hermesRaw || typeof hermesRaw !== "object" || Array.isArray(hermesRaw)) return [];
  let raw = (hermesRaw as Record<string, unknown>)["config"];
  if (!raw) return [];
  if (typeof raw === "object" && !Array.isArray(raw)) raw = [raw];
  if (!Array.isArray(raw)) return [];

  const result: SkillConfigVar[] = [];
  const seen = new Set<string>();
  for (const itemRaw of raw) {
    if (!itemRaw || typeof itemRaw !== "object" || Array.isArray(itemRaw)) continue;
    const item = itemRaw as Record<string, unknown>;
    const key = String(item["key"] ?? "").trim();
    if (!key || seen.has(key)) continue;
    const desc = String(item["description"] ?? "").trim();
    if (!desc) continue;
    const entry: SkillConfigVar = {
      key,
      description: desc,
      prompt: desc,
    };
    const defaultVal = item["default"];
    if (defaultVal !== undefined && defaultVal !== null) entry.default = defaultVal;
    const promptText = item["prompt"];
    if (typeof promptText === "string" && promptText.trim()) {
      entry.prompt = promptText.trim();
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

/**
 * Scan every enabled skill and collect their config variable
 * declarations. Mirrors upstream `discover_all_skill_config_vars`
 * (py:L420-456). Disabled and platform-incompatible skills are excluded.
 */
export function discoverAllSkillConfigVars(): SkillConfigVar[] {
  const allVars: SkillConfigVar[] = [];
  const seenKeys = new Set<string>();
  const disabled = getDisabledSkillNames();

  for (const skillsDir of getAllSkillsDirs()) {
    if (!_isDir(skillsDir)) continue;
    for (const skillFile of iterSkillIndexFiles(skillsDir, "SKILL.md")) {
      let raw: string;
      try {
        raw = fs().readTextSync(skillFile);
      } catch {
        continue;
      }
      const [frontmatter] = parseFrontmatter(raw);
      const skillName = String(frontmatter["name"] ?? _basename(dirname(skillFile)));
      if (disabled.has(skillName)) continue;
      if (!skillMatchesPlatform(frontmatter)) continue;

      const configVars = extractSkillConfigVars(frontmatter);
      for (const v of configVars) {
        if (!seenKeys.has(v.key)) {
          v.skill = skillName;
          allVars.push(v);
          seenKeys.add(v.key);
        }
      }
    }
  }
  return allVars;
}

function _basename(path: string): string {
  return parsePath(path).base;
}

// ─── Skill config value resolution ────────────────────────────────────

export const SKILL_CONFIG_PREFIX = "skills.config";

function _resolveDotpath(config: Record<string, unknown>, dottedKey: string): unknown {
  const parts = dottedKey.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current && typeof current === "object" && !Array.isArray(current) && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return current;
}

/**
 * Resolve current values for skill config vars from config.yaml.
 *
 * Mirrors upstream `resolve_skill_config_values` (py:L477-512). Skill
 * config is stored under `skills.config.<key>`. Returns a dict mapping
 * logical keys (as declared by skills) to their current values, or the
 * declared default if the key isn't set. Path-like values are expanded
 * via `os.path.expanduser`.
 */
export function resolveSkillConfigValues(
  configVars: SkillConfigVar[],
): Record<string, unknown> {
  const configPath = getConfigPath();
  let config: Record<string, unknown> = {};
  if (fs().existsSync(configPath)) {
    try {
      const parsed = yamlLoad(fs().readTextSync(configPath));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // ignore — upstream uses `except Exception: pass`.
    }
  }

  const resolved: Record<string, unknown> = {};
  for (const v of configVars) {
    const logicalKey = v.key;
    const storageKey = `${SKILL_CONFIG_PREFIX}.${logicalKey}`;
    let value = _resolveDotpath(config, storageKey);

    if (value === null || (typeof value === "string" && !value.trim())) {
      value = v.default !== undefined ? v.default : "";
    }

    if (typeof value === "string" && (value.includes("~") || value.includes("${"))) {
      value = _expandUserAndVars(value);
    }

    resolved[logicalKey] = value;
  }
  return resolved;
}

// ─── Description extraction ────────────────────────────────────────────

/**
 * Extract a truncated description from parsed frontmatter. Mirrors
 * upstream `extract_skill_description` (py:L518-526).
 */
export function extractSkillDescription(frontmatter: Record<string, unknown>): string {
  const rawDesc = frontmatter["description"];
  if (!rawDesc) return "";
  let desc = String(rawDesc).trim();
  // Strip a single leading/trailing matching quote char (upstream uses
  // .strip("'\"") which removes any of those chars from both ends).
  while (desc.length > 0 && (desc[0] === '"' || desc[0] === "'")) desc = desc.slice(1);
  while (desc.length > 0 && (desc[desc.length - 1] === '"' || desc[desc.length - 1] === "'")) {
    desc = desc.slice(0, -1);
  }
  if (desc.length > 60) {
    return `${desc.slice(0, 57)}...`;
  }
  return desc;
}

// ─── File iteration ────────────────────────────────────────────────────

/**
 * Walk *skillsDir* yielding sorted paths matching *filename*.
 *
 * Mirrors upstream `iter_skill_index_files` (py:L532-544). Excludes
 * Hermes metadata, VCS, virtualenv/dependency, and cache directories so
 * dependencies cannot register nested skills.
 *
 * `followLinks=True` matches upstream — symlinked skill dirs (which
 * `tests/agent/test_skill_commands.py` exercises) must be discovered.
 */
export function* iterSkillIndexFiles(skillsDir: string, filename: string): Generator<string, void, void> {
  const matches: string[] = [];
  for (const entry of fs().walkSync(skillsDir, { followLinks: true })) {
    // Filter dirs in place so the walker prunes EXCLUDED_SKILL_DIRS
    // before descending.
    for (let i = entry.dirs.length - 1; i >= 0; i--) {
      if (EXCLUDED_SKILL_DIRS.has(entry.dirs[i]!)) {
        entry.dirs.splice(i, 1);
      }
    }
    if (entry.files.includes(filename)) {
      matches.push(join(entry.root, filename));
    }
  }
  // Sort by relative path to match upstream's sort key.
  const skillsDirResolved = resolveCanonical(skillsDir);
  const sorted = matches.slice().sort((a, b) => {
    const ra = _relativeOrAbs(a, skillsDirResolved);
    const rb = _relativeOrAbs(b, skillsDirResolved);
    if (ra < rb) return -1;
    if (ra > rb) return 1;
    return 0;
  });
  for (const path of sorted) yield path;
}

function _relativeOrAbs(path: string, base: string): string {
  // Mirror Python's Path.relative_to: returns the relative form, or
  // raises ValueError on mismatch. We approximate by stripping the
  // common prefix when present; otherwise return the absolute path.
  const resolvedPath = (function () {
    try {
      return _coreIo.realpathSync(path);
    } catch {
      return resolve(path);
    }
  })();
  if (resolvedPath === base) return "";
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (resolvedPath.startsWith(baseWithSep)) {
    return resolvedPath.slice(baseWithSep.length);
  }
  // Fall back to the input path so sort is stable.
  return path;
}

// ─── Namespace helpers ────────────────────────────────────────────────

const _NAMESPACE_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Split `"namespace:skill-name"` into `[namespace, bareName]`. Returns
 * `[null, name]` when there is no `':'`. Mirrors upstream
 * `parse_qualified_name` (py:L552-559).
 */
export function parseQualifiedName(name: string): [string | null, string] {
  if (!name.includes(":")) return [null, name];
  const idx = name.indexOf(":");
  return [name.slice(0, idx), name.slice(idx + 1)];
}

/**
 * Check whether *candidate* is a valid namespace (`[a-zA-Z0-9_-]+`).
 * Mirrors upstream `is_valid_namespace` (py:L562-566).
 */
export function isValidNamespace(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  return _NAMESPACE_RE.test(candidate);
}
