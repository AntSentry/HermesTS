/**
 * Shared test fixtures — minimal in-memory implementations of the
 * runtime extension hooks needed by every test in this package.
 *
 * `installVirtualSkillsTool` wires a `SkillsToolHooks` impl backed by
 * an on-disk temp dir (so the real `parseFrontmatter` runs over real
 * markdown bodies) — close to what the upstream `with patch(
 * "tools.skills_tool.SKILLS_DIR", tmp_path)` pattern produces.
 *
 * Tests that need to override individual symbols (e.g.
 * `_get_disabled_skill_names`) reassign fields on the returned hooks
 * object the same way upstream uses `patch.object`.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  defaultFsHooks,
  parseFrontmatter,
  resetExtensions,
  setHermesHomeHooks,
  setSkillsToolHooks,
  skillMatchesPlatform,
  type SkillViewPayload,
  type SkillsToolHooks,
} from "../src/index.js";

export interface VirtualSkillsHandle {
  /** Absolute path to the temp dir that backs the virtual skills root. */
  readonly skillsDir: string;
  /** Mutable hooks object — tests reassign individual fns the way
   *  upstream uses `patch.object`. */
  readonly hooks: Mutable<SkillsToolHooks>;
  /** Recursively delete the temp dir. */
  cleanup(): void;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Spin up a temp-dir-backed virtual skills tool and install it as the
 * `skillsTool` hook. Returns a handle the test owns; call `cleanup()`
 * in afterEach.
 */
export function installVirtualSkillsTool(
  options: { disabled?: Set<string>; useRealParse?: boolean } = {},
): VirtualSkillsHandle {
  const skillsDir = mkdtempSync(join(tmpdir(), "hermests-agent-skills-"));

  // Default skill_view impl: walks the temp dir's `<name>/SKILL.md`
  // file and emits a payload that matches the shape the upstream
  // `tools.skills_tool.skill_view` returns. Tests can override the
  // whole function if they need a richer response.
  const skillView = (
    name: string,
    opts: { taskId?: string | null | undefined; preprocess?: boolean | undefined },
  ): string => {
    void opts;
    // Strip any leading "/" the caller might have left in.
    const normalized = name.replace(/^[/]+/, "");
    // Two acceptance paths upstream supports:
    //   1. Look up `<skillsDir>/<normalized>/SKILL.md`
    //   2. Look up the dir whose frontmatter name matches `normalized`
    const candidates: string[] = [
      join(skillsDir, normalized, "SKILL.md"),
      join(skillsDir, normalized),
    ];
    for (const path of candidates) {
      if (defaultFsHooks.existsSync(path)) {
        const skillMdPath = path.endsWith("SKILL.md") ? path : join(path, "SKILL.md");
        if (defaultFsHooks.existsSync(skillMdPath)) {
          return JSON.stringify(_buildPayload(skillMdPath, skillsDir));
        }
      }
    }

    // Search by frontmatter name as a fallback (matches upstream's
    // `skill_view` which can look up by either path or name).
    for (const entry of defaultFsHooks.walkSync(skillsDir, { followLinks: true })) {
      if (!entry.files.includes("SKILL.md")) continue;
      const candidate = join(entry.root, "SKILL.md");
      try {
        const content = defaultFsHooks.readTextSync(candidate);
        const [fm] = parseFrontmatter(content);
        if (String(fm["name"] ?? "") === normalized) {
          return JSON.stringify(_buildPayload(candidate, skillsDir));
        }
      } catch {
        // ignore
      }
    }
    return JSON.stringify({ success: false });
  };

  const hooks: Mutable<SkillsToolHooks> = {
    getSkillsDir: () => skillsDir,
    skillView,
    parseFrontmatter,
    skillMatchesPlatform: options.useRealParse === false ? () => true : skillMatchesPlatform,
    getDisabledSkillNames: () => new Set(options.disabled ?? new Set<string>()),
  };
  setSkillsToolHooks(hooks);

  return {
    skillsDir,
    hooks,
    cleanup: () => {
      try {
        rmSync(skillsDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function _buildPayload(skillMdPath: string, skillsRoot: string): SkillViewPayload {
  const raw = defaultFsHooks.readTextSync(skillMdPath);
  const [frontmatter, body] = parseFrontmatter(raw);
  const skillDir = dirname(skillMdPath);
  const relPath = skillMdPath.startsWith(skillsRoot)
    ? skillMdPath.slice(skillsRoot.length).replace(/^[/]+/, "")
    : skillMdPath;
  return {
    success: true,
    name: String(frontmatter["name"] ?? ""),
    path: relPath,
    skill_dir: skillDir,
    // The agent treats `body` as the active skill body. raw_content keeps
    // the frontmatter for the config-var inject step.
    content: body,
    raw_content: raw,
  };
}

/** Write a SKILL.md file with the given name and body. */
export function writeSkill(
  skillsDir: string,
  name: string,
  options: {
    frontmatterExtra?: string;
    body?: string;
    category?: string;
  } = {},
): string {
  const dir = options.category
    ? join(skillsDir, options.category, name)
    : join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  const fmExtra = options.frontmatterExtra ?? "";
  const body = options.body ?? "Do the thing.";
  const content = `---
name: ${name}
description: Description for ${name}.
${fmExtra}---

# ${name}

${body}
`;
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
  return dir;
}

/**
 * Install a temp HERMES_HOME so the prompt builder / skill utils write
 * the snapshot file somewhere ephemeral and tests don't blow away the
 * real one. Returns the temp dir; the caller is responsible for
 * resetting `HERMES_HOME`.
 */
export function installTempHermesHome(): {
  home: string;
  cleanup: () => void;
  prev: string | undefined;
} {
  const prev = process.env["HERMES_HOME"];
  const home = mkdtempSync(join(tmpdir(), "hermests-agent-home-"));
  process.env["HERMES_HOME"] = home;
  return {
    home,
    cleanup: () => {
      if (prev === undefined) delete process.env["HERMES_HOME"];
      else process.env["HERMES_HOME"] = prev;
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
    prev,
  };
}

/** Reset every extension hook and clear sticky env vars. */
export function resetEverything(): void {
  resetExtensions();
  setHermesHomeHooks(null);
}
