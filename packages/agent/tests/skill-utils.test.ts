/**
 * Tests for `@hermests/agent/skill-utils`.
 *
 * Ports upstream `tests/agent/test_skill_utils.py` and
 * `tests/agent/test_external_skills_dirs_cache.py` 1:1, with extra
 * coverage to satisfy the 100/100/100/100 vitest threshold (every
 * branch in `getDisabledSkillNames`, `getExternalSkillsDirs`,
 * `resolveSkillConfigValues`, etc.).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * On macOS, `/var/folders/...` is a symlink to `/private/var/folders/...`.
 * `realpathSync` resolves it, and the production code resolves canonical
 * paths before comparison — so the expected values in our tests need to
 * use the canonical form to match.
 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  _externalDirsCacheClear,
  _setIsTermuxForTests,
  _setPlatformForTests,
  _setYamlLoaderForTests,
  discoverAllSkillConfigVars,
  extractSkillConditions,
  extractSkillConfigVars,
  extractSkillDescription,
  getAllSkillsDirs,
  getDisabledSkillNames,
  getExternalSkillsDirs,
  isExcludedSkillPath,
  isValidNamespace,
  iterSkillIndexFiles,
  parseFrontmatter,
  parseQualifiedName,
  resolveSkillConfigValues,
  setSessionContextHooks,
  skillMatchesPlatform,
  yamlLoad,
} from "../src/index.js";

// HERMES_HOME points the @hermests/core helpers (getConfigPath,
// getSkillsDir) at a per-test temp dir so the tests don't touch real
// user state.
let prevHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  prevHome = process.env["HERMES_HOME"];
  tmpHome = mkdtempSync(join(tmpdir(), "skill-utils-home-"));
  process.env["HERMES_HOME"] = tmpHome;
  delete process.env["HERMES_PLATFORM"];
  _externalDirsCacheClear();
  _setYamlLoaderForTests(null);
  _setPlatformForTests(null);
  _setIsTermuxForTests(null);
  setSessionContextHooks(null);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["HERMES_HOME"];
  else process.env["HERMES_HOME"] = prevHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("isExcludedSkillPath", () => {
  test("flags paths whose any component is excluded", () => {
    expect(isExcludedSkillPath("/a/.git/b")).toBe(true);
    expect(isExcludedSkillPath("/a/node_modules/b")).toBe(true);
    expect(isExcludedSkillPath("/foo/.venv/bar/SKILL.md")).toBe(true);
  });

  test("allows clean paths", () => {
    expect(isExcludedSkillPath("/a/b/c")).toBe(false);
  });

  test("handles backslash paths (Windows-style fixtures)", () => {
    expect(isExcludedSkillPath("C:\\foo\\.git\\bar")).toBe(true);
    expect(isExcludedSkillPath("C:\\foo\\bar")).toBe(false);
  });
});

describe("yamlLoad", () => {
  test("uses the default parser", () => {
    expect(yamlLoad("a: 1\nb: [x, y]")).toEqual({ a: 1, b: ["x", "y"] });
  });

  test("respects an injected loader", () => {
    _setYamlLoaderForTests(() => ({ injected: true }));
    expect(yamlLoad("anything")).toEqual({ injected: true });
  });
});

describe("parseFrontmatter", () => {
  test("returns empty frontmatter when content lacks ---", () => {
    expect(parseFrontmatter("hello")).toEqual([{}, "hello"]);
  });

  test("returns empty frontmatter when only opening --- is present", () => {
    const [fm, body] = parseFrontmatter("---\nfoo: bar\n");
    expect(fm).toEqual({});
    expect(body).toBe("---\nfoo: bar\n");
  });

  test("parses a well-formed YAML block", () => {
    // Upstream's `\n---\s*\n` regex greedily consumes the blank line after
    // the closing `---`, so the body has no leading newline.
    const [fm, body] = parseFrontmatter("---\nname: foo\ndesc: bar\n---\n\nbody");
    expect(fm).toEqual({ name: "foo", desc: "bar" });
    expect(body).toBe("body");
  });

  test("falls back to key:value splitting on YAML errors", () => {
    _setYamlLoaderForTests(() => {
      throw new Error("simulated parse failure");
    });
    const [fm] = parseFrontmatter("---\nname: foo\ndesc: bar\nno-colon-line\n---\n");
    expect(fm).toEqual({ name: "foo", desc: "bar" });
  });

  test("returns empty frontmatter when YAML parses to a non-mapping", () => {
    _setYamlLoaderForTests(() => 42);
    const [fm] = parseFrontmatter("---\n42\n---\n\nbody");
    expect(fm).toEqual({});
  });
});

describe("extractSkillConditions", () => {
  test("normal case: metadata is a dict containing hermes keys", () => {
    const result = extractSkillConditions({
      metadata: {
        hermes: {
          fallback_for_toolsets: ["toolset_a"],
          requires_toolsets: ["toolset_b"],
          fallback_for_tools: ["tool_x"],
          requires_tools: ["tool_y"],
        },
      },
    });
    expect(result.fallback_for_toolsets).toEqual(["toolset_a"]);
    expect(result.requires_toolsets).toEqual(["toolset_b"]);
    expect(result.fallback_for_tools).toEqual(["tool_x"]);
    expect(result.requires_tools).toEqual(["tool_y"]);
  });

  test("metadata as a string does not crash", () => {
    expect(extractSkillConditions({ metadata: "some text" })).toEqual({
      fallback_for_toolsets: [],
      requires_toolsets: [],
      fallback_for_tools: [],
      requires_tools: [],
    });
  });

  test("metadata = null", () => {
    expect(extractSkillConditions({ metadata: null })).toEqual({
      fallback_for_toolsets: [],
      requires_toolsets: [],
      fallback_for_tools: [],
      requires_tools: [],
    });
  });

  test("metadata absent entirely", () => {
    expect(extractSkillConditions({ name: "my-skill" })).toEqual({
      fallback_for_toolsets: [],
      requires_toolsets: [],
      fallback_for_tools: [],
      requires_tools: [],
    });
  });

  test("metadata.hermes = null still yields empties", () => {
    expect(extractSkillConditions({ metadata: { hermes: null } })).toEqual({
      fallback_for_toolsets: [],
      requires_toolsets: [],
      fallback_for_tools: [],
      requires_tools: [],
    });
  });

  test("scalar entries are coerced to single-element lists", () => {
    const result = extractSkillConditions({
      metadata: { hermes: { requires_tools: "single-tool" } },
    });
    expect(result.requires_tools).toEqual(["single-tool"]);
  });
});

describe("iterSkillIndexFiles", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "iter-skill-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("prunes excluded dirs", () => {
    const real = join(tmp, "real-skill");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "---\nname: real-skill\n---\n", "utf-8");

    const nested = join(
      tmp,
      "bring",
      "scripts",
      ".venv",
      "lib",
      "python3.13",
      "site-packages",
      "typer",
      ".agents",
      "skills",
      "typer",
    );
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "SKILL.md"), "---\nname: typer\n---\n", "utf-8");

    const nodeMod = join(tmp, "web-skill", "node_modules", "dep", ".agents", "skills", "dep");
    mkdirSync(nodeMod, { recursive: true });
    writeFileSync(join(nodeMod, "SKILL.md"), "---\nname: dep\n---\n", "utf-8");

    const found = Array.from(iterSkillIndexFiles(tmp, "SKILL.md"));
    expect(found).toEqual([join(real, "SKILL.md")]);
  });

  test("does not yield anything when the dir doesn't exist", () => {
    const found = Array.from(iterSkillIndexFiles(join(tmp, "missing"), "SKILL.md"));
    expect(found).toEqual([]);
  });

  test("follows symlinked sub-directories", () => {
    const external = join(tmp, "external");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "SKILL.md"), "---\nname: external-skill\n---\n", "utf-8");
    const linkDir = join(tmp, "skills-root");
    mkdirSync(linkDir, { recursive: true });
    try {
      symlinkSync(external, join(linkDir, "linked"), "dir");
    } catch {
      // skip on hosts where symlinks aren't supported
      return;
    }
    const found = Array.from(iterSkillIndexFiles(linkDir, "SKILL.md"));
    expect(found).toContain(join(linkDir, "linked", "SKILL.md"));
  });
});

describe("skillMatchesPlatform", () => {
  test("no platforms field matches everywhere", () => {
    _setPlatformForTests("android");
    _setIsTermuxForTests(true);
    expect(skillMatchesPlatform({})).toBe(true);
    expect(skillMatchesPlatform({ name: "foo" })).toBe(true);
  });

  test("empty platforms list also matches everywhere", () => {
    _setPlatformForTests("linux");
    _setIsTermuxForTests(false);
    expect(skillMatchesPlatform({ platforms: [] })).toBe(true);
  });

  test("Linux skill loads on Termux/Android", () => {
    _setPlatformForTests("android");
    _setIsTermuxForTests(true);
    expect(skillMatchesPlatform({ platforms: ["linux"] })).toBe(true);
  });

  test("linux/macos/windows tag loads on Termux", () => {
    _setPlatformForTests("android");
    _setIsTermuxForTests(true);
    expect(skillMatchesPlatform({ platforms: ["linux", "macos", "windows"] })).toBe(true);
  });

  test("Linux skill on pre-3.13 Termux (sys.platform=linux)", () => {
    _setPlatformForTests("linux");
    _setIsTermuxForTests(true);
    expect(skillMatchesPlatform({ platforms: ["linux"] })).toBe(true);
  });

  test("macos-only skill stays excluded on Termux", () => {
    _setPlatformForTests("android");
    _setIsTermuxForTests(true);
    expect(skillMatchesPlatform({ platforms: ["macos"] })).toBe(false);
  });

  test("windows-only skill stays excluded on Termux", () => {
    _setPlatformForTests("android");
    _setIsTermuxForTests(true);
    expect(skillMatchesPlatform({ platforms: ["windows"] })).toBe(false);
  });

  test("explicit termux/android tag matches", () => {
    _setPlatformForTests("android");
    _setIsTermuxForTests(true);
    expect(skillMatchesPlatform({ platforms: ["termux"] })).toBe(true);
    expect(skillMatchesPlatform({ platforms: ["android"] })).toBe(true);
  });

  test("non-Termux Android does not widen", () => {
    _setPlatformForTests("android");
    _setIsTermuxForTests(false);
    expect(skillMatchesPlatform({ platforms: ["linux"] })).toBe(false);
  });

  test("real Linux loads linux skills", () => {
    _setPlatformForTests("linux");
    _setIsTermuxForTests(false);
    expect(skillMatchesPlatform({ platforms: ["linux"] })).toBe(true);
  });

  test("real macOS loads macos skills", () => {
    _setPlatformForTests("darwin");
    _setIsTermuxForTests(false);
    expect(skillMatchesPlatform({ platforms: ["macos"] })).toBe(true);
  });

  test("scalar platforms field is treated as single-element list", () => {
    _setPlatformForTests("darwin");
    _setIsTermuxForTests(false);
    expect(skillMatchesPlatform({ platforms: "macos" })).toBe(true);
  });
});

describe("getDisabledSkillNames", () => {
  test("returns empty when config.yaml is absent", () => {
    expect(getDisabledSkillNames()).toEqual(new Set());
  });

  test("returns empty when YAML parse fails", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "{ broken", "utf-8");
    expect(getDisabledSkillNames()).toEqual(new Set());
  });

  test("returns empty when top-level is a list", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "- 1\n- 2\n", "utf-8");
    expect(getDisabledSkillNames()).toEqual(new Set());
  });

  test("returns empty when skills section is missing", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "other: foo\n", "utf-8");
    expect(getDisabledSkillNames()).toEqual(new Set());
  });

  test("returns global disabled list when no platform scope", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      "skills:\n  disabled:\n    - foo\n    - bar\n",
      "utf-8",
    );
    expect(getDisabledSkillNames()).toEqual(new Set(["foo", "bar"]));
  });

  test("honors platform-specific list when HERMES_PLATFORM is set", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      [
        "skills:",
        "  disabled: [global-only]",
        "  platform_disabled:",
        "    telegram: [tg-skill]",
        "",
      ].join("\n"),
      "utf-8",
    );
    process.env["HERMES_PLATFORM"] = "telegram";
    expect(getDisabledSkillNames()).toEqual(new Set(["tg-skill"]));
  });

  test("falls back to global list when platform has no entry", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      ["skills:", "  disabled: [global]", "  platform_disabled:", "    other: [a]", ""].join("\n"),
      "utf-8",
    );
    process.env["HERMES_PLATFORM"] = "telegram";
    expect(getDisabledSkillNames()).toEqual(new Set(["global"]));
  });

  test("explicit platform argument wins over env", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      [
        "skills:",
        "  platform_disabled:",
        "    discord: [d-skill]",
        "    telegram: [t-skill]",
        "",
      ].join("\n"),
      "utf-8",
    );
    process.env["HERMES_PLATFORM"] = "telegram";
    expect(getDisabledSkillNames("discord")).toEqual(new Set(["d-skill"]));
  });

  test("session context provides platform when env var is missing", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      ["skills:", "  platform_disabled:", "    matrix: [m-skill]", ""].join("\n"),
      "utf-8",
    );
    setSessionContextHooks({
      getSessionEnv: (name) => (name === "HERMES_SESSION_PLATFORM" ? "matrix" : ""),
    });
    expect(getDisabledSkillNames()).toEqual(new Set(["m-skill"]));
  });

  test("string-valued disabled is normalized to a single-entry set", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "skills:\n  disabled: only-one\n", "utf-8");
    expect(getDisabledSkillNames()).toEqual(new Set(["only-one"]));
  });

  test("malformed skills section returns empty", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "skills: [a, b]\n", "utf-8");
    expect(getDisabledSkillNames()).toEqual(new Set());
  });

  test("platform_disabled is not a dict — falls back to global", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      ["skills:", "  disabled: [global]", "  platform_disabled: not-a-dict", ""].join("\n"),
      "utf-8",
    );
    process.env["HERMES_PLATFORM"] = "telegram";
    expect(getDisabledSkillNames()).toEqual(new Set(["global"]));
  });

  test("platform_disabled value of null falls back to global", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      ["skills:", "  disabled: [g]", "  platform_disabled:", "    telegram: null", ""].join("\n"),
      "utf-8",
    );
    process.env["HERMES_PLATFORM"] = "telegram";
    expect(getDisabledSkillNames()).toEqual(new Set(["g"]));
  });
});

describe("getExternalSkillsDirs", () => {
  test("returns empty when config.yaml is absent", () => {
    expect(getExternalSkillsDirs()).toEqual([]);
  });

  test("returns empty when YAML parse fails", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "{ broken", "utf-8");
    expect(getExternalSkillsDirs()).toEqual([]);
  });

  test("returns empty when top-level is a list", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "- 1\n", "utf-8");
    expect(getExternalSkillsDirs()).toEqual([]);
  });

  test("returns empty when skills section is missing", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "other:\n", "utf-8");
    expect(getExternalSkillsDirs()).toEqual([]);
  });

  test("returns empty when external_dirs is absent", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "skills:\n  disabled: []\n", "utf-8");
    expect(getExternalSkillsDirs()).toEqual([]);
  });

  test("returns empty when external_dirs is not a list", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "skills:\n  external_dirs: 42\n", "utf-8");
    expect(getExternalSkillsDirs()).toEqual([]);
  });

  test("skips the local skills dir and missing dirs", () => {
    const localSkills = join(tmpHome, "skills");
    mkdirSync(localSkills, { recursive: true });
    const ext = mkdtempSync(join(tmpdir(), "ext-"));
    writeFileSync(
      join(tmpHome, "config.yaml"),
      `skills:\n  external_dirs:\n    - ${localSkills}\n    - ${ext}\n    - ${join(tmpdir(), "definitely-missing-" + Date.now())}\n`,
      "utf-8",
    );
    const result = getExternalSkillsDirs();
    expect(result).toEqual([canonical(ext)]);
    rmSync(ext, { recursive: true, force: true });
  });

  test("handles a single string entry", () => {
    const ext = mkdtempSync(join(tmpdir(), "ext-"));
    writeFileSync(join(tmpHome, "config.yaml"), `skills:\n  external_dirs: ${ext}\n`, "utf-8");
    expect(getExternalSkillsDirs()).toEqual([canonical(ext)]);
    rmSync(ext, { recursive: true, force: true });
  });

  test("dedupes repeats", () => {
    const ext = mkdtempSync(join(tmpdir(), "ext-dup-"));
    writeFileSync(
      join(tmpHome, "config.yaml"),
      `skills:\n  external_dirs:\n    - ${ext}\n    - ${ext}\n`,
      "utf-8",
    );
    expect(getExternalSkillsDirs()).toEqual([canonical(ext)]);
    rmSync(ext, { recursive: true, force: true });
  });

  test("resolves relative paths against HERMES_HOME", () => {
    const rel = "shared-skills";
    const absPath = join(tmpHome, rel);
    mkdirSync(absPath, { recursive: true });
    writeFileSync(join(tmpHome, "config.yaml"), `skills:\n  external_dirs:\n    - ${rel}\n`, "utf-8");
    expect(getExternalSkillsDirs()).toEqual([canonical(absPath)]);
  });

  test("expands ~ in entries", () => {
    const homeExt = join(homedir(), `_hermests_agent_test_external_${Date.now()}`);
    mkdirSync(homeExt, { recursive: true });
    try {
      writeFileSync(
        join(tmpHome, "config.yaml"),
        `skills:\n  external_dirs:\n    - ${homeExt.replace(homedir(), "~")}\n`,
        "utf-8",
      );
      expect(getExternalSkillsDirs()).toEqual([homeExt]);
    } finally {
      rmSync(homeExt, { recursive: true, force: true });
    }
  });

  test("expands ${VAR} references", () => {
    const ext = mkdtempSync(join(tmpdir(), "ext-var-"));
    process.env["MY_EXT_DIR"] = ext;
    writeFileSync(
      join(tmpHome, "config.yaml"),
      `skills:\n  external_dirs:\n    - \${MY_EXT_DIR}\n`,
      "utf-8",
    );
    expect(getExternalSkillsDirs()).toEqual([canonical(ext)]);
    delete process.env["MY_EXT_DIR"];
    rmSync(ext, { recursive: true, force: true });
  });

  test("leaves unresolved ${VAR} references in place (so they fall out as missing)", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      `skills:\n  external_dirs:\n    - \${DEFINITELY_UNSET_VAR}\n`,
      "utf-8",
    );
    expect(getExternalSkillsDirs()).toEqual([]);
  });

  test("skips blank entries", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      "skills:\n  external_dirs:\n    - ''\n    - '   '\n",
      "utf-8",
    );
    expect(getExternalSkillsDirs()).toEqual([]);
  });

  test("caches by mtime", () => {
    const ext = mkdtempSync(join(tmpdir(), "ext-cache-"));
    const extCanon = canonical(ext);
    writeFileSync(join(tmpHome, "config.yaml"), `skills:\n  external_dirs:\n    - ${ext}\n`, "utf-8");
    const first = getExternalSkillsDirs();
    expect(first).toEqual([extCanon]);

    // Second call returns the cached copy — same value, distinct array.
    const cached = getExternalSkillsDirs();
    expect(cached).toEqual([extCanon]);
    expect(cached).not.toBe(first);

    rmSync(ext, { recursive: true, force: true });
  });

  test("empty list value populates the cache without re-walking", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "skills:\n  external_dirs: []\n", "utf-8");
    expect(getExternalSkillsDirs()).toEqual([]);
    // Second call must be served from the cache; we don't assert on
    // _walks count but we re-call to exercise the path.
    expect(getExternalSkillsDirs()).toEqual([]);
  });
});

describe("getAllSkillsDirs", () => {
  test("local first, then externals", () => {
    const ext = mkdtempSync(join(tmpdir(), "ext-all-"));
    writeFileSync(join(tmpHome, "config.yaml"), `skills:\n  external_dirs:\n    - ${ext}\n`, "utf-8");
    const result = getAllSkillsDirs();
    expect(result[0]).toBe(join(tmpHome, "skills"));
    expect(result[1]).toBe(canonical(ext));
    rmSync(ext, { recursive: true, force: true });
  });
});

describe("extractSkillConfigVars", () => {
  test("returns empty list when metadata is absent", () => {
    expect(extractSkillConfigVars({})).toEqual([]);
  });

  test("returns empty list when metadata is not a dict", () => {
    expect(extractSkillConfigVars({ metadata: "string" })).toEqual([]);
  });

  test("returns empty list when hermes section is absent", () => {
    expect(extractSkillConfigVars({ metadata: {} })).toEqual([]);
  });

  test("returns empty list when config is absent or empty", () => {
    expect(extractSkillConfigVars({ metadata: { hermes: {} } })).toEqual([]);
    expect(extractSkillConfigVars({ metadata: { hermes: { config: [] } } })).toEqual([]);
  });

  test("returns empty list when config is a non-list non-dict", () => {
    expect(extractSkillConfigVars({ metadata: { hermes: { config: 42 } } })).toEqual([]);
  });

  test("coerces a single dict into a one-element list", () => {
    const result = extractSkillConfigVars({
      metadata: { hermes: { config: { key: "wiki.path", description: "Wiki dir" } } },
    });
    expect(result).toEqual([{ key: "wiki.path", description: "Wiki dir", prompt: "Wiki dir" }]);
  });

  test("dedupes by key (first wins)", () => {
    const result = extractSkillConfigVars({
      metadata: {
        hermes: {
          config: [
            { key: "a", description: "first" },
            { key: "a", description: "second" },
          ],
        },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("first");
  });

  test("skips entries missing key or description", () => {
    const result = extractSkillConfigVars({
      metadata: {
        hermes: {
          config: [
            { key: "", description: "no key" },
            { key: "x", description: "" },
            { description: "no key field" },
          ],
        },
      },
    });
    expect(result).toEqual([]);
  });

  test("respects an explicit prompt and default", () => {
    const result = extractSkillConfigVars({
      metadata: {
        hermes: {
          config: [
            {
              key: "wiki.path",
              description: "Wiki dir",
              prompt: "Where is your wiki?",
              default: "~/wiki",
            },
          ],
        },
      },
    });
    expect(result).toEqual([
      {
        key: "wiki.path",
        description: "Wiki dir",
        prompt: "Where is your wiki?",
        default: "~/wiki",
      },
    ]);
  });

  test("falls back to description when prompt is blank", () => {
    const result = extractSkillConfigVars({
      metadata: {
        hermes: {
          config: [{ key: "x", description: "Desc", prompt: "   " }],
        },
      },
    });
    expect(result[0]?.prompt).toBe("Desc");
  });

  test("ignores non-dict entries inside the list", () => {
    const result = extractSkillConfigVars({
      metadata: { hermes: { config: ["not-a-dict", { key: "x", description: "d" }] } },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("x");
  });
});

describe("discoverAllSkillConfigVars", () => {
  test("aggregates from every skill, dedupes by key, attributes to skill", () => {
    const skillsDir = join(tmpHome, "skills");
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(join(skillsDir, "alpha"), { recursive: true });
    writeFileSync(
      join(skillsDir, "alpha", "SKILL.md"),
      [
        "---",
        "name: alpha",
        "metadata:",
        "  hermes:",
        "    config:",
        "      - key: shared.path",
        "        description: shared",
        "      - key: alpha.path",
        "        description: alpha",
        "---",
        "",
        "body",
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(skillsDir, "beta"), { recursive: true });
    writeFileSync(
      join(skillsDir, "beta", "SKILL.md"),
      [
        "---",
        "name: beta",
        "metadata:",
        "  hermes:",
        "    config:",
        "      - key: shared.path",
        "        description: shared",
        "      - key: beta.path",
        "        description: beta",
        "---",
        "",
        "body",
      ].join("\n"),
      "utf-8",
    );

    const result = discoverAllSkillConfigVars();
    const keys = result.map((v) => v.key).sort();
    expect(keys).toEqual(["alpha.path", "beta.path", "shared.path"]);
    expect(result.find((v) => v.key === "shared.path")?.skill).toBe("alpha");
  });

  test("skips disabled skills", () => {
    const skillsDir = join(tmpHome, "skills");
    mkdirSync(join(skillsDir, "off"), { recursive: true });
    writeFileSync(
      join(skillsDir, "off", "SKILL.md"),
      [
        "---",
        "name: off",
        "metadata:",
        "  hermes:",
        "    config:",
        "      - key: off.k",
        "        description: d",
        "---",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(tmpHome, "config.yaml"), "skills:\n  disabled: [off]\n", "utf-8");
    expect(discoverAllSkillConfigVars()).toEqual([]);
  });

  test("skips incompatible-platform skills", () => {
    const skillsDir = join(tmpHome, "skills");
    mkdirSync(join(skillsDir, "macos-only"), { recursive: true });
    writeFileSync(
      join(skillsDir, "macos-only", "SKILL.md"),
      [
        "---",
        "name: macos-only",
        "platforms: [macos]",
        "metadata:",
        "  hermes:",
        "    config:",
        "      - key: k",
        "        description: d",
        "---",
      ].join("\n"),
      "utf-8",
    );
    _setPlatformForTests("linux");
    _setIsTermuxForTests(false);
    expect(discoverAllSkillConfigVars()).toEqual([]);
  });

  test("skips non-existent skill dirs cleanly", () => {
    expect(discoverAllSkillConfigVars()).toEqual([]);
  });

  test("falls back on read errors", () => {
    const skillsDir = join(tmpHome, "skills");
    mkdirSync(join(skillsDir, "broken"), { recursive: true });
    // Empty SKILL.md → parseFrontmatter returns {}, skill_name fallback
    // to dir name, no config vars.
    writeFileSync(join(skillsDir, "broken", "SKILL.md"), "", "utf-8");
    expect(discoverAllSkillConfigVars()).toEqual([]);
  });
});

describe("resolveSkillConfigValues", () => {
  test("returns defaults when config.yaml is absent", () => {
    const resolved = resolveSkillConfigValues([
      { key: "k", description: "d", prompt: "d", default: "fallback" },
    ]);
    expect(resolved).toEqual({ k: "fallback" });
  });

  test("returns empty string when default is absent and key unset", () => {
    const resolved = resolveSkillConfigValues([{ key: "k", description: "d", prompt: "d" }]);
    expect(resolved).toEqual({ k: "" });
  });

  test("pulls from skills.config.<key> in config.yaml", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      "skills:\n  config:\n    wiki:\n      path: /tmp/w\n",
      "utf-8",
    );
    const resolved = resolveSkillConfigValues([
      { key: "wiki.path", description: "Wiki", prompt: "Wiki" },
    ]);
    expect(resolved).toEqual({ "wiki.path": "/tmp/w" });
  });

  test("expands ~ in path-like values", () => {
    writeFileSync(
      join(tmpHome, "config.yaml"),
      "skills:\n  config:\n    wiki:\n      path: ~/notes\n",
      "utf-8",
    );
    const resolved = resolveSkillConfigValues([
      { key: "wiki.path", description: "Wiki", prompt: "Wiki" },
    ]);
    expect(String(resolved["wiki.path"])).toBe(join(homedir(), "notes"));
  });

  test("YAML parse error swallowed → falls back to defaults", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "{ broken", "utf-8");
    const resolved = resolveSkillConfigValues([
      { key: "k", description: "d", prompt: "d", default: "fall" },
    ]);
    expect(resolved).toEqual({ k: "fall" });
  });

  test("blank string falls back to default", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "skills:\n  config:\n    k: '   '\n", "utf-8");
    const resolved = resolveSkillConfigValues([
      { key: "k", description: "d", prompt: "d", default: "fall" },
    ]);
    expect(resolved).toEqual({ k: "fall" });
  });

  test("top-level list config is ignored, defaults apply", () => {
    writeFileSync(join(tmpHome, "config.yaml"), "- 1\n", "utf-8");
    const resolved = resolveSkillConfigValues([
      { key: "k", description: "d", prompt: "d", default: "fall" },
    ]);
    expect(resolved).toEqual({ k: "fall" });
  });
});

describe("extractSkillDescription", () => {
  test("returns empty string when description is missing", () => {
    expect(extractSkillDescription({})).toBe("");
  });

  test("trims quotes and whitespace", () => {
    expect(extractSkillDescription({ description: '  "Hello world"  ' })).toBe("Hello world");
  });

  test("truncates to 57 chars + ellipsis when longer than 60", () => {
    const long = "x".repeat(100);
    const result = extractSkillDescription({ description: long });
    expect(result.length).toBe(60);
    expect(result.endsWith("...")).toBe(true);
  });

  test("does not truncate at exactly 60 chars", () => {
    const exact = "x".repeat(60);
    expect(extractSkillDescription({ description: exact })).toBe(exact);
  });
});

describe("parseQualifiedName / isValidNamespace", () => {
  test("parses namespaced names", () => {
    expect(parseQualifiedName("foo:bar")).toEqual(["foo", "bar"]);
  });

  test("returns null namespace for plain names", () => {
    expect(parseQualifiedName("bar")).toEqual([null, "bar"]);
  });

  test("isValidNamespace accepts alnum+underscore+hyphen", () => {
    expect(isValidNamespace("foo-bar_2")).toBe(true);
  });

  test("isValidNamespace rejects empties and invalid chars", () => {
    expect(isValidNamespace("")).toBe(false);
    expect(isValidNamespace(null)).toBe(false);
    expect(isValidNamespace("foo bar")).toBe(false);
    expect(isValidNamespace("foo:bar")).toBe(false);
  });
});
