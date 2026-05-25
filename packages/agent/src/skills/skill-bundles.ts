/**
 * Skill bundles — aliases that load multiple skills under one slash
 * command. Port of upstream `agent/skill_bundles.py`.
 *
 * Bundles live in `~/.hermes/skill-bundles/*.yaml` (or
 * `HERMES_BUNDLES_DIR` override). Each YAML file declares a name,
 * description, and a list of skills to load together.
 *
 * Faithful divergences from upstream:
 *   - `yaml.safe_load` / `yaml.safe_dump` map directly to the `yaml`
 *     package's `parse` / `stringify`. The TS package doesn't emit a
 *     leading `---`, which matches the upstream output for
 *     `safe_dump(..., sort_keys=False)`.
 *   - The upstream caches with `mtime: float | None`; we use `mtimeMs`
 *     (number). Semantics identical.
 *   - `from agent.skill_commands import _load_skill_payload,
 *     _build_skill_message` is performed via direct import — the late
 *     binding was upstream's way of breaking a circular import in the
 *     Python module graph; there is no cycle in the TS port.
 */

import { dirname, join } from "node:path";

import { getHermesHome } from "@hermests/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { defaultFsHooks } from "../extensions/default-fs.js";
import {
  getAgentFsHooks,
  getSkillUsageHooks,
} from "../extensions/index.js";
import {
  _buildSkillMessage,
  _loadSkillPayload,
} from "./skill-commands.js";

function _fs() {
  return getAgentFsHooks() ?? defaultFsHooks;
}

// Slug normalization — matches agent/skill-commands so a bundle and a
// skill called "Foo Bar" both resolve to "/foo-bar".
const _BUNDLE_INVALID_CHARS = /[^a-z0-9-]/g;
const _BUNDLE_MULTI_HYPHEN = /-{2,}/g;

let _bundlesCache: Record<string, BundleInfo> = {};
let _bundlesCacheMtime: number | null = null;

/** Test-only: snapshot/restore of module state. */
export const _internals = {
  get bundlesCache(): Record<string, BundleInfo> {
    return _bundlesCache;
  },
  set bundlesCache(value: Record<string, BundleInfo>) {
    _bundlesCache = value;
  },
  get bundlesCacheMtime(): number | null {
    return _bundlesCacheMtime;
  },
  set bundlesCacheMtime(value: number | null) {
    _bundlesCacheMtime = value;
  },
};

export interface BundleInfo {
  name: string;
  slug: string;
  description: string;
  skills: string[];
  instruction: string;
  path: string;
}

function _bundlesDir(): string {
  const override = process.env["HERMES_BUNDLES_DIR"];
  if (override) return _expandUser(override);
  return join(getHermesHome(), "skill-bundles");
}

function _expandUser(path: string): string {
  if (path === "~") return require("node:os").homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { homedir } = require("node:os") as typeof import("node:os");
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** Mirrors upstream `_slugify` (py:L78-82). */
export function _slugify(name: string): string {
  let cmd = name.toLowerCase().replace(/ /g, "-").replace(/_/g, "-");
  cmd = cmd.replace(_BUNDLE_INVALID_CHARS, "");
  cmd = cmd.replace(_BUNDLE_MULTI_HYPHEN, "-");
  // Python str.strip("-") — trim leading and trailing hyphens.
  cmd = cmd.replace(/^-+|-+$/g, "");
  return cmd;
}

function _iterBundleFiles(): string[] {
  const base = _bundlesDir();
  const fs = _fs();
  if (!fs.existsSync(base)) return [];
  const files: string[] = [];
  for (const ext of ["*.yaml", "*.yml"]) {
    for (const f of fs.globDir(base, [ext])) files.push(f);
  }
  files.sort();
  return files;
}

/**
 * Highest mtime across bundle files plus the dir itself. Mirrors
 * upstream `_max_mtime` (py:L95-113).
 */
function _maxMtime(files: string[]): number {
  const base = _bundlesDir();
  const fs = _fs();
  const mtimes: number[] = [];
  if (fs.existsSync(base)) {
    try {
      mtimes.push(fs.statSync(base).mtimeMs);
    } catch {
      // ignore
    }
  }
  for (const f of files) {
    try {
      mtimes.push(fs.statSync(f).mtimeMs);
    } catch {
      continue;
    }
  }
  return mtimes.length > 0 ? Math.max(...mtimes) : 0;
}

/**
 * Parse a single bundle YAML file. Returns `null` on any error —
 * upstream logs at WARNING and returns None so a broken bundle can't
 * take down slash command discovery. Mirrors upstream `_load_bundle_file`
 * (py:L116-165).
 */
function _loadBundleFile(path: string): BundleInfo | null {
  const fs = _fs();
  let raw: string;
  try {
    raw = fs.readTextSync(path);
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const obj = data as Record<string, unknown>;

  const stem = _stem(path);
  const name = String(obj["name"] ?? stem).trim();
  if (!name) return null;

  let skills = obj["skills"];
  if (skills === undefined || skills === null) skills = [];
  if (!Array.isArray(skills) || skills.length === 0) return null;
  const cleaned = (skills as unknown[]).map((s) => String(s).trim()).filter((s) => s.length > 0);
  if (cleaned.length === 0) return null;

  const description = String(obj["description"] ?? "").trim();
  const instruction = String(obj["instruction"] ?? "").trim();

  const slug = _slugify(name);
  if (!slug) return null;

  return {
    name,
    slug,
    description: description || `Load ${cleaned.length} skills as a bundle`,
    skills: cleaned,
    instruction,
    path,
  };
}

function _stem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base;
  return base.slice(0, dot);
}

/**
 * Scan the bundles directory and rebuild the cache. Returns the same
 * mapping as `getSkillBundles`. Mirrors upstream `scan_bundles`
 * (py:L168-192).
 */
export function scanBundles(): Record<string, BundleInfo> {
  const files = _iterBundleFiles();
  const out: Record<string, BundleInfo> = {};
  for (const f of files) {
    const info = _loadBundleFile(f);
    if (!info) continue;
    const key = `/${info.slug}`;
    if (key in out) {
      // Duplicate slug — first wins (alphabetical order).
      continue;
    }
    out[key] = info;
  }
  _bundlesCache = out;
  _bundlesCacheMtime = _maxMtime(files);
  return out;
}

/**
 * Return the current bundle mapping, rescanning when disk changed.
 * Mirrors upstream `get_skill_bundles` (py:L195-205).
 */
export function getSkillBundles(): Record<string, BundleInfo> {
  const files = _iterBundleFiles();
  const currentMtime = _maxMtime(files);
  if (Object.keys(_bundlesCache).length === 0 || _bundlesCacheMtime !== currentMtime) {
    scanBundles();
  }
  return _bundlesCache;
}

/**
 * Resolve a user-typed command to its canonical bundle slash key.
 * Mirrors upstream `resolve_bundle_command_key` (py:L208-218).
 */
export function resolveBundleCommandKey(command: string): string | null {
  if (!command) return null;
  const cmdKey = `/${command.replace(/_/g, "-")}`;
  return cmdKey in getSkillBundles() ? cmdKey : null;
}

export interface ReloadBundlesResult {
  added: Array<{ name: string; description: string }>;
  removed: Array<{ name: string; description: string }>;
  unchanged: string[];
  total: number;
}

/**
 * Re-scan the bundles directory and return a diff. Mirrors upstream
 * `reload_bundles` (py:L221-244).
 */
export function reloadBundles(): ReloadBundlesResult {
  const snapshot = (cmds: Record<string, BundleInfo>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(cmds)) {
      out[k.replace(/^\/+/, "")] = v?.description ?? "";
    }
    return out;
  };

  const before = snapshot(_bundlesCache);
  const newCmds = scanBundles();
  const after = snapshot(newCmds);

  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  const addedNames = [...afterKeys].filter((k) => !beforeKeys.has(k)).sort();
  const removedNames = [...beforeKeys].filter((k) => !afterKeys.has(k)).sort();
  const unchanged = [...afterKeys].filter((k) => beforeKeys.has(k)).sort();

  return {
    added: addedNames.map((n) => ({ name: n, description: after[n] ?? "" })),
    removed: removedNames.map((n) => ({ name: n, description: before[n] ?? "" })),
    unchanged,
    total: afterKeys.size,
  };
}

/**
 * Return a sorted list of bundle info dicts for display. Mirrors
 * upstream `list_bundles` (py:L247-250).
 */
export function listBundles(): BundleInfo[] {
  const bundles = getSkillBundles();
  return Object.values(bundles).slice().sort((a, b) => {
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    return 0;
  });
}

/**
 * Build the user message content for a bundle slash command invocation.
 * Mirrors upstream `build_bundle_invocation_message` (py:L253-340).
 */
export function buildBundleInvocationMessage(
  cmdKey: string,
  userInstruction = "",
  taskId: string | null = null,
): [string, string[], string[]] | null {
  const bundles = getSkillBundles();
  const info = bundles[cmdKey];
  if (!info) return null;

  const loadedNames: string[] = [];
  const missing: string[] = [];
  const skillBlocks: string[] = [];
  const seen = new Set<string>();

  const bundleName = info.name;
  const skills = info.skills;
  const extraInstruction = info.instruction;

  for (const skillIdRaw of skills) {
    const identifier = (skillIdRaw ?? "").trim();
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);

    const loaded = _loadSkillPayload.fn(identifier, taskId);
    if (!loaded) {
      missing.push(identifier);
      continue;
    }
    const { loadedSkill, skillDir, skillName } = loaded;

    try {
      const usage = getSkillUsageHooks();
      if (usage) usage.bumpUse(skillName);
    } catch {
      // ignore
    }

    const activationNote = `[Loaded as part of the "${bundleName}" skill bundle.]`;
    skillBlocks.push(
      _buildSkillMessage.fn(loadedSkill, skillDir, activationNote, {
        sessionId: taskId,
      }),
    );
    loadedNames.push(skillName);
  }

  if (skillBlocks.length === 0) return null;

  const headerLines = [
    `[IMPORTANT: The user has invoked the "${bundleName}" skill bundle, ` +
      `loading ${loadedNames.length} skills together. Treat every skill below ` +
      "as active guidance for this turn.]",
    "",
    `Bundle: ${bundleName}`,
    `Skills loaded: ${loadedNames.join(", ")}`,
  ];
  if (missing.length > 0) {
    headerLines.push(`Skills missing (skipped): ${missing.join(", ")}`);
  }
  if (extraInstruction) {
    headerLines.push("", `Bundle instruction: ${extraInstruction}`);
  }
  if (userInstruction) {
    headerLines.push("", `User instruction: ${userInstruction}`);
  }

  const header = headerLines.join("\n");
  return [`${header}\n\n${skillBlocks.join("\n\n")}`, loadedNames, missing];
}

// ─── File-level CRUD ───────────────────────────────────────────────────

/** Mirrors upstream `bundle_path_for` (py:L348-353). */
export function bundlePathFor(name: string): string {
  const slug = _slugify(name);
  if (!slug) {
    throw new Error(`Bundle name ${JSON.stringify(name)} normalizes to an empty slug`);
  }
  return join(_bundlesDir(), `${slug}.yaml`);
}

/**
 * Custom error type — analogue of Python's `FileExistsError`.
 */
export class BundleExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleExistsError";
  }
}

/**
 * Custom error type — analogue of Python's `FileNotFoundError`.
 */
export class BundleNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleNotFoundError";
  }
}

/**
 * Write a bundle to disk and invalidate the cache. Mirrors upstream
 * `save_bundle` (py:L356-391).
 */
export function saveBundle(
  name: string,
  skills: string[],
  options: {
    description?: string;
    instruction?: string;
    overwrite?: boolean;
  } = {},
): string {
  const trimmedName = (name ?? "").trim();
  if (!trimmedName) {
    throw new Error("Bundle name is required");
  }
  const cleanedSkills = (skills ?? []).map((s) => String(s).trim()).filter((s) => s.length > 0);
  if (cleanedSkills.length === 0) {
    throw new Error("Bundle must reference at least one skill");
  }

  const fs = _fs();
  const path = bundlePathFor(trimmedName);
  if (fs.existsSync(path) && !options.overwrite) {
    throw new BundleExistsError(`Bundle already exists at ${path}`);
  }

  fs.mkdirRecursiveSync(dirname(path));
  const payload: Record<string, unknown> = { name: trimmedName, skills: cleanedSkills };
  if (options.description) payload["description"] = options.description;
  if (options.instruction) payload["instruction"] = options.instruction;

  fs.writeTextSync(path, stringifyYaml(payload, { sortMapEntries: false }));
  scanBundles();
  return path;
}

/**
 * Delete a bundle by name. Mirrors upstream `delete_bundle` (py:L394-403).
 */
export function deleteBundle(name: string): string {
  const fs = _fs();
  const path = bundlePathFor(name);
  if (!fs.existsSync(path)) {
    throw new BundleNotFoundError(`No bundle at ${path}`);
  }
  fs.unlinkSync(path);
  scanBundles();
  return path;
}

/**
 * Look up a bundle by name (slug-normalized). Mirrors upstream
 * `get_bundle` (py:L407-410).
 */
export function getBundle(name: string): BundleInfo | null {
  const slug = _slugify(name);
  return getSkillBundles()[`/${slug}`] ?? null;
}
