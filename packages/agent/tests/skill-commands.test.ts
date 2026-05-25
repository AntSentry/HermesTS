/**
 * Tests for `@hermests/agent/skill-commands`.
 *
 * Ports upstream `tests/agent/test_skill_commands.py` 1:1 (slug
 * normalization, platform filtering, disabled-skills, telegram
 * underscore aliasing, symlinks, template-var/inline-shell, etc.) plus
 * supplemental coverage on the registry-injection paths.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  _loadSkillPayload,
  _setIsTermuxForTests,
  _setPlatformForTests,
  _setYamlLoaderForTests,
  _skillCommandsInternals,
  buildPreloadedSkillsPrompt,
  buildPreloadedSkillsPromptTuple,
  buildSkillInvocationMessage,
  getSkillCommands,
  reloadSkills,
  resetExtensions,
  resolveSkillCommandKey,
  scanSkillCommands,
  setHermesHomeHooks,
  setSessionContextHooks,
  setSkillUsageHooks,
} from "../src/index.js";
import { installVirtualSkillsTool, writeSkill } from "./fixtures.js";

let prevHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  prevHome = process.env["HERMES_HOME"];
  tmpHome = mkdtempSync(join(tmpdir(), "skill-cmds-home-"));
  process.env["HERMES_HOME"] = tmpHome;
  delete process.env["HERMES_PLATFORM"];
  delete process.env["TERMINAL_ENV"];
  _setPlatformForTests(null);
  _setIsTermuxForTests(null);
  _setYamlLoaderForTests(null);
  resetExtensions();
  _skillCommandsInternals.skillCommands = {};
  _skillCommandsInternals.skillCommandsPlatform = null;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["HERMES_HOME"];
  else process.env["HERMES_HOME"] = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
  resetExtensions();
  _skillCommandsInternals.skillCommands = {};
  _skillCommandsInternals.skillCommandsPlatform = null;
});

describe("scanSkillCommands", () => {
  test("returns empty when no skillsTool is installed", () => {
    const result = scanSkillCommands();
    expect(result).toEqual({});
  });

  test("finds skills under the virtual SKILLS_DIR", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "my-skill");
    const result = scanSkillCommands();
    expect("/my-skill" in result).toBe(true);
    expect(result["/my-skill"]?.name).toBe("my-skill");
    v.cleanup();
  });

  test("returns empty when the virtual skills dir has no SKILL.md files", () => {
    const v = installVirtualSkillsTool();
    expect(scanSkillCommands()).toEqual({});
    v.cleanup();
  });

  test("excludes incompatible platform", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "imessage", { frontmatterExtra: "platforms: [macos]\n" });
    writeSkill(v.skillsDir, "web-search");
    _setPlatformForTests("linux");
    _setIsTermuxForTests(false);
    const result = scanSkillCommands();
    expect("/web-search" in result).toBe(true);
    expect("/imessage" in result).toBe(false);
    v.cleanup();
  });

  test("includes matching platform", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "imessage", { frontmatterExtra: "platforms: [macos]\n" });
    _setPlatformForTests("darwin");
    _setIsTermuxForTests(false);
    const result = scanSkillCommands();
    expect("/imessage" in result).toBe(true);
    v.cleanup();
  });

  test("universal skill on any platform", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "generic-tool");
    _setPlatformForTests("win32");
    const result = scanSkillCommands();
    expect("/generic-tool" in result).toBe(true);
    v.cleanup();
  });

  test("excludes disabled skills", () => {
    const v = installVirtualSkillsTool({ disabled: new Set(["disabled-skill"]) });
    writeSkill(v.skillsDir, "enabled-skill");
    writeSkill(v.skillsDir, "disabled-skill");
    const result = scanSkillCommands();
    expect("/enabled-skill" in result).toBe(true);
    expect("/disabled-skill" in result).toBe(false);
    v.cleanup();
  });

  test("finds skills in a symlinked category dir", () => {
    const v = installVirtualSkillsTool();
    const external = mkdtempSync(join(tmpdir(), "external-cat-"));
    mkdirSync(join(external, "knowledge-brain"), { recursive: true });
    writeFileSync(
      join(external, "knowledge-brain", "SKILL.md"),
      "---\nname: knowledge-brain\ndescription: K\n---\n\nbody",
      "utf-8",
    );
    try {
      symlinkSync(external, join(v.skillsDir, "linked"), "dir");
    } catch {
      // skip on hosts where symlinks are blocked
      v.cleanup();
      rmSync(external, { recursive: true, force: true });
      return;
    }
    const result = scanSkillCommands();
    expect("/knowledge-brain" in result).toBe(true);
    v.cleanup();
    rmSync(external, { recursive: true, force: true });
  });

  test("skips skill files inside .git/.github/.hub/.archive subtrees", () => {
    const v = installVirtualSkillsTool();
    const archive = join(v.skillsDir, ".archive", "skill-x");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      join(archive, "SKILL.md"),
      "---\nname: skill-x\ndescription: x\n---\n\nbody",
      "utf-8",
    );
    // iterSkillIndexFiles already prunes EXCLUDED_SKILL_DIRS, but the
    // explicit guard in scan_skill_commands covers the case where a
    // path managed to slip through (e.g. external-dir scan).
    const result = scanSkillCommands();
    expect("/skill-x" in result).toBe(false);
    v.cleanup();
  });

  test("falls back to first non-heading body line for description", () => {
    const v = installVirtualSkillsTool();
    const skillDir = join(v.skillsDir, "no-desc");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: no-desc\n---\n\n# Heading\n\nThe real description.\nMore body.",
      "utf-8",
    );
    const result = scanSkillCommands();
    expect(result["/no-desc"]?.description).toBe("The real description.");
    v.cleanup();
  });

  test("dedupes by frontmatter name", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "same-name");
    // Second skill, different folder but same frontmatter name
    const dupDir = join(v.skillsDir, "dup");
    mkdirSync(dupDir, { recursive: true });
    writeFileSync(
      join(dupDir, "SKILL.md"),
      "---\nname: same-name\ndescription: dup\n---\n\nbody",
      "utf-8",
    );
    const result = scanSkillCommands();
    expect(Object.keys(result).filter((k) => k === "/same-name")).toHaveLength(1);
    v.cleanup();
  });

  test("strips special chars from cmd key", () => {
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "jellyfin-plus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: Jellyfin + Jellystat 24h Summary\ndescription: Test skill\n---\n\nBody.\n",
      "utf-8",
    );
    const result = scanSkillCommands();
    expect("/jellyfin-jellystat-24h-summary" in result).toBe(true);
    expect("/jellyfin-+-jellystat-24h-summary" in result).toBe(false);
    v.cleanup();
  });

  test("skips skills whose name normalizes to empty slug", () => {
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "bad-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: +++\ndescription: Bad skill\n---\n\nBody.\n",
      "utf-8",
    );
    expect(scanSkillCommands()).toEqual({});
    v.cleanup();
  });

  test("strips slash chars from cmd key", () => {
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "sonarr-api");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: Sonarr v3/v4 API\ndescription: Test skill\n---\n\nBody.\n",
      "utf-8",
    );
    const result = scanSkillCommands();
    expect("/sonarr-v3v4-api" in result).toBe(true);
    for (const key of Object.keys(result)) {
      expect(key.slice(1).includes("/")).toBe(false);
    }
    v.cleanup();
  });
});

describe("getSkillCommands", () => {
  test("rescans when the platform scope changes", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "shared");
    writeSkill(v.skillsDir, "telegram-only");
    writeSkill(v.skillsDir, "discord-only");

    v.hooks.getDisabledSkillNames = (): Set<string> => {
      const p = process.env["HERMES_PLATFORM"];
      if (p === "telegram") return new Set(["telegram-only"]);
      if (p === "discord") return new Set(["discord-only"]);
      return new Set();
    };

    process.env["HERMES_PLATFORM"] = "telegram";
    let cmds = getSkillCommands();
    expect("/shared" in cmds).toBe(true);
    expect("/discord-only" in cmds).toBe(true);
    expect("/telegram-only" in cmds).toBe(false);

    process.env["HERMES_PLATFORM"] = "discord";
    cmds = getSkillCommands();
    expect("/shared" in cmds).toBe(true);
    expect("/telegram-only" in cmds).toBe(true);
    expect("/discord-only" in cmds).toBe(false);

    process.env["HERMES_PLATFORM"] = "telegram";
    cmds = getSkillCommands();
    expect("/telegram-only" in cmds).toBe(false);
    expect("/discord-only" in cmds).toBe(true);
    v.cleanup();
  });

  test("rescans when HERMES_SESSION_PLATFORM (gateway session) changes", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "shared");
    writeSkill(v.skillsDir, "telegram-only");
    writeSkill(v.skillsDir, "discord-only");

    v.hooks.getDisabledSkillNames = (): Set<string> => {
      const p = process.env["HERMES_PLATFORM"] || sessionPlatform;
      if (p === "telegram") return new Set(["telegram-only"]);
      if (p === "discord") return new Set(["discord-only"]);
      return new Set();
    };

    let sessionPlatform = "";
    setSessionContextHooks({
      getSessionEnv: (name) => (name === "HERMES_SESSION_PLATFORM" ? sessionPlatform : ""),
    });

    sessionPlatform = "telegram";
    let cmds = getSkillCommands();
    expect("/telegram-only" in cmds).toBe(false);
    expect("/discord-only" in cmds).toBe(true);

    sessionPlatform = "discord";
    cmds = getSkillCommands();
    expect("/discord-only" in cmds).toBe(false);
    expect("/telegram-only" in cmds).toBe(true);
    v.cleanup();
  });

  test("rescans when leaving a platform scope (back to none)", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "shared");
    writeSkill(v.skillsDir, "telegram-only");

    v.hooks.getDisabledSkillNames = (): Set<string> =>
      process.env["HERMES_PLATFORM"] === "telegram" ? new Set(["telegram-only"]) : new Set();

    process.env["HERMES_PLATFORM"] = "telegram";
    expect("/telegram-only" in getSkillCommands()).toBe(false);

    delete process.env["HERMES_PLATFORM"];
    expect("/telegram-only" in getSkillCommands()).toBe(true);
    expect(_skillCommandsInternals.skillCommandsPlatform).toBeNull();
    v.cleanup();
  });

  test("does not rescan when the platform is unchanged", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "shared");
    process.env["HERMES_PLATFORM"] = "telegram";
    getSkillCommands(); // prime
    let scans = 0;
    const origGetSkillsDir = v.hooks.getSkillsDir;
    v.hooks.getSkillsDir = () => {
      scans += 1;
      return origGetSkillsDir();
    };
    getSkillCommands();
    getSkillCommands();
    getSkillCommands();
    expect(scans).toBe(0);
    v.cleanup();
  });

  test("gracefully degrades when sessionContext hook throws", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "shared");
    setSessionContextHooks({
      getSessionEnv: () => {
        throw new Error("not available");
      },
    });
    const cmds = getSkillCommands();
    expect("/shared" in cmds).toBe(true);
    v.cleanup();
  });
});

describe("resolveSkillCommandKey", () => {
  test("hyphenated form matches directly", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "claude-code");
    scanSkillCommands();
    expect(resolveSkillCommandKey("claude-code")).toBe("/claude-code");
    v.cleanup();
  });

  test("underscore form resolves to hyphenated skill", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "claude-code");
    scanSkillCommands();
    expect(resolveSkillCommandKey("claude_code")).toBe("/claude-code");
    v.cleanup();
  });

  test("returns null for unknown command", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "claude-code");
    scanSkillCommands();
    expect(resolveSkillCommandKey("does_not_exist")).toBeNull();
    expect(resolveSkillCommandKey("does-not-exist")).toBeNull();
    v.cleanup();
  });

  test("returns null for empty command", () => {
    const v = installVirtualSkillsTool();
    scanSkillCommands();
    expect(resolveSkillCommandKey("")).toBeNull();
    v.cleanup();
  });

  test("hyphenated command is not mangled", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "foo-bar");
    scanSkillCommands();
    expect(resolveSkillCommandKey("foo-bar")).toBe("/foo-bar");
    expect(resolveSkillCommandKey("foo_bar")).toBe("/foo-bar");
    v.cleanup();
  });
});

describe("buildPreloadedSkillsPrompt", () => {
  test("builds prompt for multiple named skills", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "first-skill");
    writeSkill(v.skillsDir, "second-skill");
    const { prompt, loaded, missing } = buildPreloadedSkillsPrompt(["first-skill", "second-skill"]);
    expect(missing).toEqual([]);
    expect(loaded).toEqual(["first-skill", "second-skill"]);
    expect(prompt).toContain("first-skill");
    expect(prompt).toContain("second-skill");
    expect(prompt.toLowerCase()).toContain("preloaded");
    v.cleanup();
  });

  test("reports missing named skills", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "present-skill");
    const { prompt, loaded, missing } = buildPreloadedSkillsPrompt(["present-skill", "missing-skill"]);
    expect(prompt).toContain("present-skill");
    expect(loaded).toEqual(["present-skill"]);
    expect(missing).toEqual(["missing-skill"]);
    v.cleanup();
  });

  test("dedupes identifiers and skips blanks", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "alpha");
    const { loaded } = buildPreloadedSkillsPrompt(["alpha", "alpha", "  ", ""]);
    expect(loaded).toEqual(["alpha"]);
    v.cleanup();
  });

  test("tuple variant returns the same data shape", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "alpha");
    const [prompt, loaded, missing] = buildPreloadedSkillsPromptTuple(["alpha"]);
    expect(loaded).toEqual(["alpha"]);
    expect(missing).toEqual([]);
    expect(prompt).toContain("alpha");
    v.cleanup();
  });

  test("bump_use errors are swallowed", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "alpha");
    setSkillUsageHooks({
      bumpUse: () => {
        throw new Error("usage db unreachable");
      },
    });
    const { loaded } = buildPreloadedSkillsPrompt(["alpha"]);
    expect(loaded).toEqual(["alpha"]);
    v.cleanup();
  });
});

describe("buildSkillInvocationMessage", () => {
  test("builds the message for a known skill", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "test-skill", { body: "Do thing." });
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/test-skill", "do stuff");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("test-skill");
    expect(msg!).toContain("do stuff");
    v.cleanup();
  });

  test("returns null for unknown cmd key", () => {
    const v = installVirtualSkillsTool();
    scanSkillCommands();
    expect(buildSkillInvocationMessage("/nope")).toBeNull();
    v.cleanup();
  });

  test("returns null when skill load fails", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "broken-skill");
    scanSkillCommands();
    const orig = _loadSkillPayload.fn;
    _loadSkillPayload.fn = () => null;
    try {
      expect(buildSkillInvocationMessage("/broken-skill")).toBeNull();
    } finally {
      _loadSkillPayload.fn = orig;
    }
    v.cleanup();
  });

  test("loads skill referenced by relative path identifier", () => {
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "mlops", "audiocraft");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: audiocraft-audio-generation\ndescription: gen\n---\n\n# AudioCraft\n\nGenerate audio.",
      "utf-8",
    );
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/audiocraft-audio-generation", "compose");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("AudioCraft");
    expect(msg!).toContain("compose");
    v.cleanup();
  });

  test("activation message contains the skill directory and supporting-files hint", () => {
    const v = installVirtualSkillsTool();
    const dir = writeSkill(v.skillsDir, "abs-dir-skill");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "run.js"), "console.log('hi')", "utf-8");
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/abs-dir-skill", "go");
    expect(msg).not.toBeNull();
    expect(msg!).toContain(`[Skill directory: ${dir}]`);
    expect(msg!).toContain("Resolve any relative paths");
    expect(msg!).toContain("scripts/run.js");
    expect(msg!).toContain(join(dir, "scripts", "run.js"));
    v.cleanup();
  });

  test("template-var substitution and skill config injection both work", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({
        skills: { template_vars: true, config: { wiki: { path: "/tmp/w" } } },
      }),
    });
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "templated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      [
        "---",
        "name: templated",
        "description: tmpl",
        "metadata:",
        "  hermes:",
        "    config:",
        "      - key: wiki.path",
        "        description: wiki",
        "---",
        "",
        "Run: ${HERMES_SKILL_DIR}/scripts/foo.js",
      ].join("\n"),
      "utf-8",
    );
    // Skill config injection requires a `skills.config.wiki.path` value in
    // config.yaml — write one to HERMES_HOME.
    writeFileSync(
      join(tmpHome, "config.yaml"),
      "skills:\n  config:\n    wiki:\n      path: /tmp/wiki\n",
      "utf-8",
    );
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/templated");
    expect(msg).not.toBeNull();
    expect(msg!).toContain(`Run: ${dir}/scripts/foo.js`);
    expect(msg!).toContain("wiki.path = /tmp/wiki");
    v.cleanup();
  });

  test("session_id template var fills when task_id provided", () => {
    const v = installVirtualSkillsTool();
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({ skills: { template_vars: true } }),
    });
    const dir = join(v.skillsDir, "sess-templated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: sess-templated\ndescription: s\n---\n\nSession: ${HERMES_SESSION_ID}",
      "utf-8",
    );
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/sess-templated", "", "abc-123");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("Session: abc-123");
    v.cleanup();
  });

  test("session_id token left intact when task_id is missing", () => {
    const v = installVirtualSkillsTool();
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({ skills: { template_vars: true } }),
    });
    const dir = join(v.skillsDir, "sess-missing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: sess-missing\ndescription: s\n---\n\nSession: ${HERMES_SESSION_ID}",
      "utf-8",
    );
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/sess-missing");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("Session: ${HERMES_SESSION_ID}");
    v.cleanup();
  });

  test("disable template_vars via config skips substitution", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({ skills: { template_vars: false } }),
    });
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "no-sub");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: no-sub\ndescription: s\n---\n\nRun: ${HERMES_SKILL_DIR}/scripts/foo.js",
      "utf-8",
    );
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/no-sub");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("${HERMES_SKILL_DIR}/scripts/foo.js");
    v.cleanup();
  });

  test("inline_shell stays off by default", () => {
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "dyn-default-off");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: dyn-default-off\ndescription: s\n---\n\nToday: !`echo INLINE_RAN`.",
      "utf-8",
    );
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/dyn-default-off");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("!`echo INLINE_RAN`");
    v.cleanup();
  });

  test("inline_shell runs when enabled in config", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({
        skills: { template_vars: true, inline_shell: true, inline_shell_timeout: 5 },
      }),
    });
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "dyn-on");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: dyn-on\ndescription: s\n---\n\nMarker: !`echo INLINE_RAN`.",
      "utf-8",
    );
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/dyn-on");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("Marker: INLINE_RAN.");
    v.cleanup();
  });

  test("inline_shell timeout surfaced as marker, message still renders", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({
        skills: { template_vars: true, inline_shell: true, inline_shell_timeout: 1 },
      }),
    });
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "dyn-slow");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: dyn-slow\ndescription: s\n---\n\nSlow: !`sleep 5 && printf DYN_MARKER`",
      "utf-8",
    );
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/dyn-slow");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("inline-shell timeout");
    v.cleanup();
  });

  test("clamps non-positive inline_shell_timeout", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({
        skills: { template_vars: true, inline_shell: true, inline_shell_timeout: 0 },
      }),
    });
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "dyn-zero");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: dyn-zero\ndescription: s\n---\n\nM: !`echo OK`",
      "utf-8",
    );
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/dyn-zero");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("M: OK");
    v.cleanup();
  });

  test("clamps junk inline_shell_timeout", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({
        skills: { template_vars: true, inline_shell: true, inline_shell_timeout: "junk" },
      }),
    });
    const v = installVirtualSkillsTool();
    const dir = join(v.skillsDir, "dyn-junk");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: dyn-junk\ndescription: s\n---\n\nM: !`echo OK`",
      "utf-8",
    );
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/dyn-junk");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("M: OK");
    v.cleanup();
  });

  test("setup_skipped emits the skipped note", () => {
    const v = installVirtualSkillsTool();
    const dir = writeSkill(v.skillsDir, "skipped");
    scanSkillCommands();
    // Override skillView to inject setup_skipped:true
    v.hooks.skillView = () =>
      JSON.stringify({
        success: true,
        name: "skipped",
        skill_dir: dir,
        content: "body",
        raw_content: "---\nname: skipped\n---\n\nbody",
        setup_skipped: true,
      });
    const msg = buildSkillInvocationMessage("/skipped");
    expect(msg).toContain("Required environment setup was skipped");
    v.cleanup();
  });

  test("gateway_setup_hint takes precedence over setup_needed", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "gw");
    scanSkillCommands();
    v.hooks.skillView = () =>
      JSON.stringify({
        success: true,
        name: "gw",
        content: "body",
        raw_content: "---\nname: gw\n---\n\nbody",
        gateway_setup_hint: "use local CLI",
      });
    const msg = buildSkillInvocationMessage("/gw");
    expect(msg).toContain("use local CLI");
    v.cleanup();
  });

  test("setup_needed + setup_note emits the note", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "needs-setup");
    scanSkillCommands();
    v.hooks.skillView = () =>
      JSON.stringify({
        success: true,
        name: "needs-setup",
        content: "body",
        raw_content: "---\nname: needs-setup\n---\n\nbody",
        setup_needed: true,
        setup_note: "configure FOO",
      });
    const msg = buildSkillInvocationMessage("/needs-setup");
    expect(msg).toContain("configure FOO");
    v.cleanup();
  });

  test("linked_files come from the loaded skill payload when supplied", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "with-linked");
    scanSkillCommands();
    v.hooks.skillView = () =>
      JSON.stringify({
        success: true,
        name: "with-linked",
        skill_dir: join(v.skillsDir, "with-linked"),
        content: "body",
        raw_content: "---\nname: with-linked\n---\n\nbody",
        linked_files: { refs: ["docs/api.md"], extras: ["scripts/run.sh"] },
      });
    const msg = buildSkillInvocationMessage("/with-linked");
    expect(msg).toContain("docs/api.md");
    expect(msg).toContain("scripts/run.sh");
    v.cleanup();
  });

  test("supporting-file hint uses file_path argument", () => {
    const v = installVirtualSkillsTool();
    const dir = writeSkill(v.skillsDir, "test-skill");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "references", "api.md"), "reference", "utf-8");
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/test-skill", "do stuff");
    expect(msg).not.toBeNull();
    expect(msg!).toContain('file_path="<path>"');
    v.cleanup();
  });

  test("user_instruction and runtime_note are included", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "u-and-r");
    scanSkillCommands();
    const msg = buildSkillInvocationMessage("/u-and-r", "USER_HINT", null, "RT_NOTE");
    expect(msg).toContain("USER_HINT");
    expect(msg).toContain("[Runtime note: RT_NOTE]");
    v.cleanup();
  });
});

describe("reloadSkills", () => {
  test("reports added/removed/unchanged + totals", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "stay");
    writeSkill(v.skillsDir, "leave");
    scanSkillCommands();
    rmSync(join(v.skillsDir, "leave"), { recursive: true, force: true });
    writeSkill(v.skillsDir, "arrive");
    const diff = reloadSkills();
    expect(diff.added.map((e) => e.name).sort()).toEqual(["arrive"]);
    expect(diff.removed.map((e) => e.name)).toEqual(["leave"]);
    expect(diff.unchanged.sort()).toEqual(["stay"]);
    expect(diff.total).toBe(2);
    expect(diff.commands).toBe(2);
    v.cleanup();
  });
});

describe("_loadSkillPayload", () => {
  test("returns null when identifier is empty", () => {
    const v = installVirtualSkillsTool();
    expect(_loadSkillPayload.fn("")).toBeNull();
    v.cleanup();
  });

  test("returns null when no skillsTool is installed", () => {
    expect(_loadSkillPayload.fn("anything")).toBeNull();
  });

  test("resolves absolute paths under the skills root", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "abs-skill");
    const absPath = join(v.skillsDir, "abs-skill", "SKILL.md");
    const result = _loadSkillPayload.fn(absPath);
    expect(result).not.toBeNull();
    expect(result!.skillName).toBe("abs-skill");
    v.cleanup();
  });

  test("returns null when skillView responds with success=false", () => {
    const v = installVirtualSkillsTool();
    v.hooks.skillView = () => JSON.stringify({ success: false });
    expect(_loadSkillPayload.fn("ghost")).toBeNull();
    v.cleanup();
  });

  test("returns null when JSON.parse blows up (skillView returned garbage)", () => {
    const v = installVirtualSkillsTool();
    v.hooks.skillView = () => "this is not json";
    expect(_loadSkillPayload.fn("garbage")).toBeNull();
    v.cleanup();
  });

  test("handles ~/ expansion in identifier", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "tilde-skill");
    // The actual skill is under v.skillsDir, but we pass a `~/...`
    // identifier; the loader resolves ~ via homedir then falls through
    // to skillView, which (in the virtual impl) looks under the real
    // skills dir by name. We're exercising the expansion branch.
    const result = _loadSkillPayload.fn("~/maybe-skill");
    // skillView returns success=false for an unknown name; we expect null.
    expect(result).toBeNull();
    v.cleanup();
  });
});

describe("getSkillCommands with bare ~", () => {
  test("handles a bare ~ identifier without crashing", () => {
    const v = installVirtualSkillsTool();
    expect(_loadSkillPayload.fn("~")).toBeNull();
    v.cleanup();
  });
});
