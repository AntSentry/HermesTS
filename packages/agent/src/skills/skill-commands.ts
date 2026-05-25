/**
 * Shared slash command helpers for skills — port of upstream
 * `agent/skill_commands.py`.
 *
 * Shared between CLI and gateway so both surfaces can invoke skills via
 * `/skill-name` commands.
 *
 * Faithful divergences from upstream:
 *   - `tools.skills_tool` symbols (`SKILLS_DIR`, `skill_view`,
 *     `_parse_frontmatter`, `skill_matches_platform`,
 *     `_get_disabled_skill_names`) are wired through the extension
 *     registry (`@hermests/agent/extensions`) instead of via late
 *     `from tools.skills_tool import …` statements. Tests install
 *     fakes; the integrator (#5o) wires the real `@hermests/tools`
 *     package at startup.
 *   - `tools.skill_usage.bump_use` follows the same pattern.
 *   - `gateway.session_context.get_session_env` likewise routes through
 *     the registry.
 *   - The activation-note strings are byte-identical to upstream so the
 *     model behaviour is unaffected.
 */

import { dirname, isAbsolute as pathIsAbsolute, join, relative, sep } from "node:path";

import { displayHermesHome, _io as _coreIo } from "@hermests/core";

import { defaultFsHooks } from "../extensions/default-fs.js";
import {
  getAgentFsHooks,
  getSessionContextHooks,
  getSkillUsageHooks,
  getSkillsToolHooks,
  type SkillViewPayload,
} from "../extensions/index.js";
import {
  expandInlineShell as _expandInlineShell,
  loadSkillsConfig as _loadSkillsConfig,
  substituteTemplateVars as _substituteTemplateVars,
} from "./skill-preprocessing.js";
import {
  extractSkillConfigVars,
  getExternalSkillsDirs,
  iterSkillIndexFiles,
  parseFrontmatter,
  resolveSkillConfigValues,
} from "./skill-utils.js";

function _fs() {
  return getAgentFsHooks() ?? defaultFsHooks;
}

// Module-level mutable state — mirrors upstream's globals.
let _skillCommands: Record<string, SkillCommandInfo> = {};
let _skillCommandsPlatform: string | null = null;

// Patterns for sanitizing skill names into clean hyphen-separated slugs.
const _SKILL_INVALID_CHARS = /[^a-z0-9-]/g;
const _SKILL_MULTI_HYPHEN = /-{2,}/g;

export interface SkillCommandInfo {
  name: string;
  description: string;
  skill_md_path: string;
  skill_dir: string;
}

/** Internal: snapshot of the module's state. Test-only. */
export const _internals = {
  get skillCommands(): Record<string, SkillCommandInfo> {
    return _skillCommands;
  },
  set skillCommands(value: Record<string, SkillCommandInfo>) {
    _skillCommands = value;
  },
  get skillCommandsPlatform(): string | null {
    return _skillCommandsPlatform;
  },
  set skillCommandsPlatform(value: string | null) {
    _skillCommandsPlatform = value;
  },
};

/** Mirrors upstream `_resolve_skill_commands_platform` (py:L30-51). */
function _resolveSkillCommandsPlatform(): string | null {
  let resolvedPlatform: string | undefined;
  try {
    const hooks = getSessionContextHooks();
    resolvedPlatform =
      process.env["HERMES_PLATFORM"] ??
      (hooks ? hooks.getSessionEnv("HERMES_SESSION_PLATFORM", "") : "");
  } catch {
    resolvedPlatform = process.env["HERMES_PLATFORM"];
  }
  return resolvedPlatform ? resolvedPlatform : null;
}

// Spy-compatible reference so tests can wrap scanSkillCommands the way
// upstream wraps `scan_skill_commands` via `patch.wraps(...)`.
const _scanRef = { fn: null as null | (() => Record<string, SkillCommandInfo>) };

interface LoadedSkillTuple {
  loadedSkill: SkillViewPayload;
  skillDir: string | null;
  skillName: string;
}

/**
 * Load a skill by name/path and return `(loaded_payload, skill_dir,
 * display_name)`. Mirrors upstream `_load_skill_payload` (py:L53-118).
 *
 * Test-only: tests patch this symbol the same way upstream patches
 * `agent.skill_commands._load_skill_payload`.
 */
export const _loadSkillPayload = {
  fn: ((skillIdentifier: string, taskId: string | null = null): LoadedSkillTuple | null => {
    const rawIdentifier = (skillIdentifier ?? "").trim();
    if (!rawIdentifier) return null;

    const hooks = getSkillsToolHooks();
    if (!hooks) return null;

    let normalized: string;
    try {
      const skillsRoot = hooks.getSkillsDir();
      const identifierPath = _expandUser(rawIdentifier);
      if (pathIsAbsolute(identifierPath)) {
        const trustedRoots: string[] = [skillsRoot];
        try {
          for (const dir of getExternalSkillsDirs()) trustedRoots.push(dir);
        } catch {
          // ignore
        }

        let resolved: string | null = null;
        for (const root of trustedRoots) {
          const rel = _relativeToOrNull(identifierPath, root);
          if (rel !== null) {
            resolved = rel;
            break;
          }
        }
        if (resolved === null) {
          try {
            const realIdent = _coreIo.realpathSync(identifierPath);
            const realRoot = _coreIo.realpathSync(skillsRoot);
            const rel = _relativeToOrNull(realIdent, realRoot);
            resolved = rel ?? rawIdentifier;
          } catch {
            resolved = rawIdentifier;
          }
        }
        normalized = resolved;
      } else {
        // lstrip("/") on a non-absolute path is a no-op on POSIX, but
        // protects against accidental leading slashes from callers.
        normalized = rawIdentifier.replace(/^[/]+/, "");
      }

      const raw = hooks.skillView(normalized, { taskId, preprocess: false });
      const parsed = JSON.parse(raw) as SkillViewPayload;
      if (!parsed.success) return null;

      const skillName = String(parsed.name ?? normalized);
      const skillPath = String(parsed.path ?? "");
      let skillDir: string | null = null;
      const absSkillDir = parsed.skill_dir;
      if (absSkillDir) {
        skillDir = String(absSkillDir);
      } else if (skillPath) {
        try {
          skillDir = join(skillsRoot, dirname(skillPath));
        } catch {
          skillDir = null;
        }
      }
      return { loadedSkill: parsed, skillDir, skillName };
    } catch {
      return null;
    }
  }) as (skillIdentifier: string, taskId?: string | null) => LoadedSkillTuple | null,
};

function _expandUser(path: string): string {
  if (path === "~") return _coreIo.homedir();
  if (path.startsWith("~/") || path.startsWith(`~${sep}`)) {
    return join(_coreIo.homedir(), path.slice(2));
  }
  return path;
}

function _relativeToOrNull(target: string, base: string): string | null {
  if (target === base) return "";
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (target.startsWith(baseWithSep)) {
    return target.slice(baseWithSep.length);
  }
  // Cross-platform tolerance: also accept forward slashes in fixtures.
  const fwd = base.endsWith("/") ? base : base + "/";
  if (target.startsWith(fwd)) return target.slice(fwd.length);
  return null;
}

/**
 * Resolve and inject skill-declared config values into the message
 * parts. Mirrors upstream `_inject_skill_config` (py:L121-157).
 */
function _injectSkillConfig(loadedSkill: SkillViewPayload, parts: string[]): void {
  try {
    const rawContent = String(loadedSkill.raw_content ?? loadedSkill.content ?? "");
    if (!rawContent) return;
    const [frontmatter] = parseFrontmatter(rawContent);
    const configVars = extractSkillConfigVars(frontmatter);
    if (configVars.length === 0) return;
    const resolved = resolveSkillConfigValues(configVars);
    if (Object.keys(resolved).length === 0) return;

    const lines: string[] = ["", `[Skill config (from ${displayHermesHome()}/config.yaml):`];
    for (const [key, value] of Object.entries(resolved)) {
      const displayVal = value ? String(value) : "(not set)";
      lines.push(`  ${key} = ${displayVal}`);
    }
    lines.push("]");
    parts.push(...lines);
  } catch {
    // Non-critical — skill still loads without config injection.
  }
}

/**
 * Format a loaded skill into a user/system message payload. Mirrors
 * upstream `_build_skill_message` (py:L160-260).
 *
 * Test-only export: upstream tests patch fields like
 * `_load_skill_payload`, `_build_skill_message`, etc.
 */
export const _buildSkillMessage = {
  fn: ((
    loadedSkill: SkillViewPayload,
    skillDir: string | null,
    activationNote: string,
    options: {
      userInstruction?: string;
      runtimeNote?: string;
      sessionId?: string | null;
    } = {},
  ): string => {
    const userInstruction = options.userInstruction ?? "";
    const runtimeNote = options.runtimeNote ?? "";
    const sessionId = options.sessionId ?? null;

    const skillsToolHooks = getSkillsToolHooks();
    const skillsRoot = skillsToolHooks ? skillsToolHooks.getSkillsDir() : "";

    let content = String(loadedSkill.content ?? "");

    // ── Template substitution and inline-shell expansion ──
    const skillsCfg = _loadSkillsConfig();
    if (skillsCfg["template_vars"] !== false) {
      content = _substituteTemplateVars(content, skillDir ?? null, sessionId);
    }
    if (skillsCfg["inline_shell"] === true) {
      const rawTimeout = skillsCfg["inline_shell_timeout"];
      const timeout =
        typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
          ? Math.trunc(rawTimeout)
          : 10;
      content = _expandInlineShell(content, skillDir ?? null, timeout > 0 ? timeout : 10);
    }

    const parts: string[] = [activationNote, "", content.trim()];

    // ── Skill directory hint ──
    if (skillDir) {
      parts.push("");
      parts.push(`[Skill directory: ${skillDir}]`);
      parts.push(
        "Resolve any relative paths in this skill (e.g. `scripts/foo.js`, " +
          "`templates/config.yaml`) against that directory, then run them " +
          "with the terminal tool using the absolute path.",
      );
    }

    // ── Skill config injection ──
    _injectSkillConfig(loadedSkill, parts);

    if (loadedSkill.setup_skipped) {
      parts.push(
        "",
        "[Skill setup note: Required environment setup was skipped. Continue loading the skill and explain any reduced functionality if it matters.]",
      );
    } else if (loadedSkill.gateway_setup_hint) {
      parts.push("", `[Skill setup note: ${loadedSkill.gateway_setup_hint}]`);
    } else if (loadedSkill.setup_needed && loadedSkill.setup_note) {
      parts.push("", `[Skill setup note: ${loadedSkill.setup_note}]`);
    }

    const supporting: string[] = [];
    const linkedFiles = loadedSkill.linked_files ?? {};
    for (const entries of Object.values(linkedFiles)) {
      if (Array.isArray(entries)) supporting.push(...entries);
    }

    if (supporting.length === 0 && skillDir) {
      for (const subdir of ["references", "templates", "scripts", "assets"]) {
        const subdirPath = join(skillDir, subdir);
        if (!_dirExists(subdirPath)) continue;
        for (const filePath of _rglobFiles(subdirPath)) {
          const rel = relative(skillDir, filePath);
          supporting.push(rel);
        }
      }
    }

    if (supporting.length > 0 && skillDir) {
      let skillViewTarget: string;
      try {
        const rel = relative(skillsRoot, skillDir);
        if (!rel || rel.startsWith("..")) throw new Error("not under skills root");
        skillViewTarget = rel;
      } catch {
        skillViewTarget = _basename(skillDir);
      }
      parts.push("");
      parts.push("[This skill has supporting files:]");
      for (const sf of supporting) {
        parts.push(`- ${sf}  ->  ${join(skillDir, sf)}`);
      }
      parts.push(
        `\nLoad any of these with skill_view(name="${skillViewTarget}", ` +
          'file_path="<path>"), or run scripts directly by absolute path ' +
          `(e.g. \`node ${skillDir}/scripts/foo.js\`).`,
      );
    }

    if (userInstruction) {
      parts.push(
        "",
        `The user has provided the following instruction alongside the skill invocation: ${userInstruction}`,
      );
    }
    if (runtimeNote) {
      parts.push("", `[Runtime note: ${runtimeNote}]`);
    }

    return parts.join("\n");
  }) as (
    loadedSkill: SkillViewPayload,
    skillDir: string | null,
    activationNote: string,
    options?: { userInstruction?: string; runtimeNote?: string; sessionId?: string | null },
  ) => string,
};

function _dirExists(path: string): boolean {
  try {
    const fs = _fs();
    return fs.existsSync(path) && fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function _basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

function* _rglobFiles(root: string): Generator<string, void, void> {
  const fs = _fs();
  const collected: string[] = [];
  for (const entry of fs.walkSync(root, { followLinks: false })) {
    for (const file of entry.files) {
      collected.push(join(entry.root, file));
    }
  }
  // upstream sorts by str()
  collected.sort();
  for (const path of collected) yield path;
}

/**
 * Scan `~/.hermes/skills/` and external dirs, returning a `/command →
 * info` map. Mirrors upstream `scan_skill_commands` (py:L263-326).
 */
export function scanSkillCommands(): Record<string, SkillCommandInfo> {
  _skillCommandsPlatform = _resolveSkillCommandsPlatform();
  _skillCommands = {};

  try {
    const hooks = getSkillsToolHooks();
    if (!hooks) return _skillCommands;

    const skillsRoot = hooks.getSkillsDir();
    const disabled = hooks.getDisabledSkillNames();
    const seenNames = new Set<string>();

    // Scan local dir first, then external dirs.
    const dirsToScan: string[] = [];
    // upstream checks SKILLS_DIR.exists() before appending — we do the
    // same by deferring to fs hooks for existence.
    if (_dirExistsLoose(skillsRoot)) dirsToScan.push(skillsRoot);
    for (const ext of getExternalSkillsDirs()) dirsToScan.push(ext);

    for (const scanDir of dirsToScan) {
      for (const skillMd of iterSkillIndexFiles(scanDir, "SKILL.md")) {
        const parts = skillMd.split(/[\\/]/);
        if (parts.some((p) => p === ".git" || p === ".github" || p === ".hub" || p === ".archive")) {
          continue;
        }
        try {
          const fs = _fs();
          const content = fs.readTextSync(skillMd);
          const [frontmatter, body] = hooks.parseFrontmatter(content);
          if (!hooks.skillMatchesPlatform(frontmatter)) continue;
          const name = String(frontmatter["name"] ?? _basename(dirname(skillMd)));
          if (seenNames.has(name)) continue;
          if (disabled.has(name)) continue;

          let description = String(frontmatter["description"] ?? "");
          if (!description) {
            for (const lineRaw of body.trim().split("\n")) {
              const line = lineRaw.trim();
              if (line && !line.startsWith("#")) {
                description = line.slice(0, 80);
                break;
              }
            }
          }
          seenNames.add(name);

          // Normalize to hyphen-separated slug.
          let cmdName = name.toLowerCase().replace(/ /g, "-").replace(/_/g, "-");
          cmdName = cmdName.replace(_SKILL_INVALID_CHARS, "");
          cmdName = cmdName.replace(_SKILL_MULTI_HYPHEN, "-");
          // Trim leading/trailing hyphens (Python str.strip("-")).
          cmdName = cmdName.replace(/^-+|-+$/g, "");
          if (!cmdName) continue;
          _skillCommands[`/${cmdName}`] = {
            name,
            description: description || `Invoke the ${name} skill`,
            skill_md_path: skillMd,
            skill_dir: dirname(skillMd),
          };
        } catch {
          continue;
        }
      }
    }
  } catch {
    // Top-level try/except matches upstream `except Exception: pass`.
  }
  return _skillCommands;
}

_scanRef.fn = scanSkillCommands;

function _dirExistsLoose(path: string): boolean {
  try {
    return _fs().existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Return the current skill-commands mapping (scan first if empty,
 * rescan when platform scope changes). Mirrors upstream
 * `get_skill_commands` (py:L329-341).
 */
export function getSkillCommands(): Record<string, SkillCommandInfo> {
  if (Object.keys(_skillCommands).length === 0 || _skillCommandsPlatform !== _resolveSkillCommandsPlatform()) {
    (_scanRef.fn ?? scanSkillCommands)();
  }
  return _skillCommands;
}

export interface ReloadSkillsResult {
  added: Array<{ name: string; description: string }>;
  removed: Array<{ name: string; description: string }>;
  unchanged: string[];
  total: number;
  commands: number;
}

/**
 * Re-scan the skills directory and return a diff. Mirrors upstream
 * `reload_skills` (py:L344-406).
 */
export function reloadSkills(): ReloadSkillsResult {
  const snapshot = (cmds: Record<string, SkillCommandInfo>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [slashKey, info] of Object.entries(cmds)) {
      const bare = slashKey.replace(/^\/+/, "");
      out[bare] = info?.description ?? "";
    }
    return out;
  };

  const before = snapshot(_skillCommands);
  const newCommands = scanSkillCommands();
  const after = snapshot(newCommands);

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
    commands: Object.keys(newCommands).length,
  };
}

/**
 * Resolve a user-typed `/command` to its canonical skill_cmds key.
 * Mirrors upstream `resolve_skill_command_key` (py:L409-425).
 *
 * Hyphens and underscores are treated interchangeably to match
 * Telegram's bot-command name munging.
 */
export function resolveSkillCommandKey(command: string): string | null {
  if (!command) return null;
  const cmdKey = `/${command.replace(/_/g, "-")}`;
  const commands = getSkillCommands();
  return cmdKey in commands ? cmdKey : null;
}

/**
 * Build the user message content for a skill slash command invocation.
 * Mirrors upstream `build_skill_invocation_message` (py:L428-472).
 */
export function buildSkillInvocationMessage(
  cmdKey: string,
  userInstruction = "",
  taskId: string | null = null,
  runtimeNote = "",
): string | null {
  const commands = getSkillCommands();
  const skillInfo = commands[cmdKey];
  if (!skillInfo) return null;

  const loaded = _loadSkillPayload.fn(skillInfo.skill_dir, taskId);
  if (!loaded) return null;

  const { loadedSkill, skillDir, skillName } = loaded;

  // Track active usage for Curator lifecycle management (#17782).
  try {
    const usage = getSkillUsageHooks();
    if (usage) usage.bumpUse(skillName);
  } catch {
    // Non-critical — skill invocation proceeds regardless.
  }

  const activationNote =
    `[IMPORTANT: The user has invoked the "${skillName}" skill, indicating they want ` +
    "you to follow its instructions. The full skill content is loaded below.]";
  return _buildSkillMessage.fn(loadedSkill, skillDir, activationNote, {
    userInstruction,
    runtimeNote,
    sessionId: taskId,
  });
}

/**
 * Load one or more skills for session-wide CLI preloading. Mirrors
 * upstream `build_preloaded_skills_prompt` (py:L475-523).
 */
export function buildPreloadedSkillsPrompt(
  skillIdentifiers: string[],
  taskId: string | null = null,
): { prompt: string; loaded: string[]; missing: string[] } {
  const promptParts: string[] = [];
  const loadedNames: string[] = [];
  const missing: string[] = [];

  const seen = new Set<string>();
  for (const rawIdentifier of skillIdentifiers) {
    const identifier = (rawIdentifier ?? "").trim();
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

    const activationNote =
      `[IMPORTANT: The user launched this CLI session with the "${skillName}" skill ` +
      "preloaded. Treat its instructions as active guidance for the duration of this " +
      "session unless the user overrides them.]";
    promptParts.push(
      _buildSkillMessage.fn(loadedSkill, skillDir, activationNote, { sessionId: taskId }),
    );
    loadedNames.push(skillName);
  }

  return { prompt: promptParts.join("\n\n"), loaded: loadedNames, missing };
}

// Tuple-style result helper for cases where the caller wants Python
// parity. Exported alongside the object-style result.
export function buildPreloadedSkillsPromptTuple(
  skillIdentifiers: string[],
  taskId: string | null = null,
): [string, string[], string[]] {
  const r = buildPreloadedSkillsPrompt(skillIdentifiers, taskId);
  return [r.prompt, r.loaded, r.missing];
}
