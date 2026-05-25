/**
 * Tests for `@hermests/agent/skill-bundles`.
 *
 * Ports upstream `tests/agent/test_skill_bundles.py` 1:1 plus the
 * supplementary cases needed to hit 100% coverage on the YAML loading,
 * cache invalidation, and `bundlePathFor` error paths.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  _skillBundlesInternals,
  _slugify,
  buildBundleInvocationMessage,
  BundleExistsError,
  BundleNotFoundError,
  bundlePathFor,
  deleteBundle,
  getBundle,
  getSkillBundles,
  listBundles,
  reloadBundles,
  resetExtensions,
  resolveBundleCommandKey,
  saveBundle,
  scanBundles,
  setSkillUsageHooks,
} from "../src/index.js";
import { installVirtualSkillsTool, writeSkill } from "./fixtures.js";

let prevHome: string | undefined;
let prevBundlesDir: string | undefined;
let tmpHome: string;
let bundlesDir: string;

beforeEach(() => {
  prevHome = process.env["HERMES_HOME"];
  prevBundlesDir = process.env["HERMES_BUNDLES_DIR"];
  tmpHome = mkdtempSync(join(tmpdir(), "skill-bundles-home-"));
  process.env["HERMES_HOME"] = tmpHome;
  bundlesDir = join(tmpHome, "skill-bundles");
  delete process.env["HERMES_BUNDLES_DIR"];
  _skillBundlesInternals.bundlesCache = {};
  _skillBundlesInternals.bundlesCacheMtime = null;
  resetExtensions();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["HERMES_HOME"];
  else process.env["HERMES_HOME"] = prevHome;
  if (prevBundlesDir === undefined) delete process.env["HERMES_BUNDLES_DIR"];
  else process.env["HERMES_BUNDLES_DIR"] = prevBundlesDir;
  rmSync(tmpHome, { recursive: true, force: true });
  _skillBundlesInternals.bundlesCache = {};
  _skillBundlesInternals.bundlesCacheMtime = null;
  resetExtensions();
});

function makeBundleYaml(
  slug: string,
  skills: string[],
  options: { description?: string; instruction?: string; name?: string } = {},
): string {
  mkdirSync(bundlesDir, { recursive: true });
  const lines: string[] = [];
  lines.push(`name: ${options.name ?? slug}`);
  if (options.description) lines.push(`description: ${options.description}`);
  lines.push("skills:");
  for (const s of skills) lines.push(`  - ${s}`);
  if (options.instruction) {
    lines.push("instruction: |");
    for (const ln of options.instruction.split("\n")) lines.push(`  ${ln}`);
  }
  const path = join(bundlesDir, `${slug}.yaml`);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
  return path;
}

describe("_slugify", () => {
  test("basic", () => {
    expect(_slugify("Backend Dev")).toBe("backend-dev");
  });

  test("underscores", () => {
    expect(_slugify("backend_dev")).toBe("backend-dev");
  });

  test("strips invalid chars", () => {
    expect(_slugify("hello, world!")).toBe("hello-world");
  });

  test("collapses hyphens", () => {
    expect(_slugify("a--b---c")).toBe("a-b-c");
  });

  test("empty input", () => {
    expect(_slugify("")).toBe("");
    expect(_slugify("!!!")).toBe("");
  });
});

describe("scanBundles", () => {
  test("empty dir → empty map", () => {
    expect(scanBundles()).toEqual({});
  });

  test("finds a single bundle", () => {
    makeBundleYaml("backend", ["skill-a", "skill-b"]);
    const result = scanBundles();
    expect("/backend" in result).toBe(true);
    expect(result["/backend"]?.name).toBe("backend");
    expect(result["/backend"]?.skills).toEqual(["skill-a", "skill-b"]);
  });

  test("skips invalid YAML files", () => {
    mkdirSync(bundlesDir, { recursive: true });
    writeFileSync(join(bundlesDir, "broken.yaml"), "{not: valid yaml: [", "utf-8");
    makeBundleYaml("good", ["skill-a"]);
    const result = scanBundles();
    expect("/good" in result).toBe(true);
    expect("/broken" in result).toBe(false);
  });

  test("skips bundle without skills list", () => {
    mkdirSync(bundlesDir, { recursive: true });
    writeFileSync(join(bundlesDir, "noskills.yaml"), "name: noskills\nskills: []\n", "utf-8");
    expect("/noskills" in scanBundles()).toBe(false);
  });

  test("skips bundle whose skills entries are all blank", () => {
    mkdirSync(bundlesDir, { recursive: true });
    writeFileSync(
      join(bundlesDir, "blankskills.yaml"),
      "name: blankskills\nskills:\n  - ''\n  - '  '\n",
      "utf-8",
    );
    expect("/blankskills" in scanBundles()).toBe(false);
  });

  test("skips top-level list YAML", () => {
    mkdirSync(bundlesDir, { recursive: true });
    writeFileSync(join(bundlesDir, "list.yaml"), "- a\n- b\n", "utf-8");
    expect(scanBundles()).toEqual({});
  });

  test("rejects a YAML file with only whitespace as the name field", () => {
    mkdirSync(bundlesDir, { recursive: true });
    writeFileSync(
      join(bundlesDir, "blank-name.yaml"),
      "name: '   '\nskills:\n  - foo\n",
      "utf-8",
    );
    expect(scanBundles()).toEqual({});
  });

  test("skips file whose name normalizes to an empty slug", () => {
    mkdirSync(bundlesDir, { recursive: true });
    writeFileSync(join(bundlesDir, "junk.yaml"), "name: '+++'\nskills:\n  - foo\n", "utf-8");
    expect(scanBundles()).toEqual({});
  });

  test("duplicate slug — first wins (alphabetical filename order)", () => {
    makeBundleYaml("alpha", ["s1"], { name: "alpha" });
    makeBundleYaml("alpha-dup", ["s2"], { name: "ALPHA" });
    const result = scanBundles();
    expect("/alpha" in result).toBe(true);
    expect(result["/alpha"]?.skills).toEqual(["s2"]);
  });

  test("uses filename as fallback name", () => {
    mkdirSync(bundlesDir, { recursive: true });
    writeFileSync(join(bundlesDir, "fallback.yaml"), "skills:\n  - foo\n", "utf-8");
    const result = scanBundles();
    expect("/fallback" in result).toBe(true);
    expect(result["/fallback"]?.name).toBe("fallback");
  });

  test("description defaults from skills count", () => {
    makeBundleYaml("nodesc", ["a", "b"]);
    expect(scanBundles()["/nodesc"]?.description).toBe("Load 2 skills as a bundle");
  });
});

describe("getSkillBundles", () => {
  test("returns the cached map without touching disk if mtime unchanged", () => {
    makeBundleYaml("a", ["s1"]);
    const first = getSkillBundles();
    const second = getSkillBundles();
    expect(second).toEqual(first);
  });

  test("rescans when dir mtime changes", async () => {
    makeBundleYaml("a", ["s1"]);
    expect("/a" in getSkillBundles()).toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    makeBundleYaml("b", ["s2"]);
    const result = getSkillBundles();
    expect("/a" in result).toBe(true);
    expect("/b" in result).toBe(true);
  });
});

describe("resolveBundleCommandKey", () => {
  test("exact match", () => {
    makeBundleYaml("my-bundle", ["s1"]);
    scanBundles();
    expect(resolveBundleCommandKey("my-bundle")).toBe("/my-bundle");
  });

  test("underscore alias", () => {
    makeBundleYaml("my-bundle", ["s1"]);
    scanBundles();
    expect(resolveBundleCommandKey("my_bundle")).toBe("/my-bundle");
  });

  test("unknown returns null", () => {
    scanBundles();
    expect(resolveBundleCommandKey("missing")).toBeNull();
  });

  test("empty input returns null", () => {
    expect(resolveBundleCommandKey("")).toBeNull();
  });
});

describe("buildBundleInvocationMessage", () => {
  test("loads all referenced skills", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "skill-a", { body: "Skill A content." });
    writeSkill(v.skillsDir, "skill-b", { body: "Skill B content." });
    makeBundleYaml("combo", ["skill-a", "skill-b"]);
    scanBundles();
    const result = buildBundleInvocationMessage("/combo");
    expect(result).not.toBeNull();
    const [msg, loaded, missing] = result!;
    expect(new Set(loaded)).toEqual(new Set(["skill-a", "skill-b"]));
    expect(missing).toEqual([]);
    expect(msg).toContain("Skill A content.");
    expect(msg).toContain("Skill B content.");
    expect(msg).toContain("combo");
    v.cleanup();
  });

  test("skips missing skills, reports them in header", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "skill-a");
    makeBundleYaml("combo", ["skill-a", "skill-ghost"]);
    scanBundles();
    const result = buildBundleInvocationMessage("/combo");
    expect(result).not.toBeNull();
    const [msg, loaded, missing] = result!;
    expect(loaded).toEqual(["skill-a"]);
    expect(missing).toEqual(["skill-ghost"]);
    expect(msg).toContain("skill-ghost");
    v.cleanup();
  });

  test("returns null for unknown bundle", () => {
    expect(buildBundleInvocationMessage("/nope")).toBeNull();
  });

  test("returns null when no skills load", () => {
    installVirtualSkillsTool();
    makeBundleYaml("ghost", ["nonexistent-skill"]);
    scanBundles();
    expect(buildBundleInvocationMessage("/ghost")).toBeNull();
  });

  test("includes user instruction in header", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "skill-a");
    makeBundleYaml("combo", ["skill-a"]);
    scanBundles();
    const result = buildBundleInvocationMessage("/combo", "extra context here");
    expect(result).not.toBeNull();
    expect(result![0]).toContain("extra context here");
    v.cleanup();
  });

  test("includes bundle instruction in header", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "skill-a");
    makeBundleYaml("combo", ["skill-a"], { instruction: "Always check tests first." });
    scanBundles();
    const result = buildBundleInvocationMessage("/combo");
    expect(result).not.toBeNull();
    expect(result![0]).toContain("Always check tests first.");
    v.cleanup();
  });

  test("dedupes referenced skills", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "skill-a");
    makeBundleYaml("combo", ["skill-a", "skill-a"]);
    scanBundles();
    const result = buildBundleInvocationMessage("/combo");
    expect(result).not.toBeNull();
    expect(result![1]).toEqual(["skill-a"]);
    v.cleanup();
  });

  test("bump_use errors are swallowed", () => {
    const v = installVirtualSkillsTool();
    writeSkill(v.skillsDir, "skill-a");
    makeBundleYaml("combo", ["skill-a"]);
    scanBundles();
    setSkillUsageHooks({
      bumpUse: () => {
        throw new Error("db down");
      },
    });
    const result = buildBundleInvocationMessage("/combo", "user note");
    expect(result).not.toBeNull();
    expect(result![1]).toEqual(["skill-a"]);
    v.cleanup();
  });
});

describe("saveBundle / deleteBundle / getBundle", () => {
  test("save creates a YAML file with all metadata", () => {
    const path = saveBundle("test-bundle", ["s1", "s2"], { description: "d", instruction: "i" });
    expect(path.startsWith(bundlesDir)).toBe(true);
    const content = require("node:fs").readFileSync(path, "utf-8") as string;
    expect(content).toContain("test-bundle");
    expect(content).toContain("s1");
    expect(content).toContain("s2");
    expect(content).toContain("description: d");
    expect(content).toContain("instruction: i");
  });

  test("save refuses to overwrite by default", () => {
    saveBundle("dup", ["s1"]);
    expect(() => saveBundle("dup", ["s2"])).toThrow(BundleExistsError);
  });

  test("save overwrites with overwrite=true", () => {
    saveBundle("dup", ["s1"]);
    saveBundle("dup", ["s2"], { overwrite: true });
    const info = getBundle("dup");
    expect(info).not.toBeNull();
    expect(info!.skills).toEqual(["s2"]);
  });

  test("save requires at least one skill", () => {
    expect(() => saveBundle("empty", [])).toThrow(/at least one skill/);
  });

  test("save requires a name", () => {
    expect(() => saveBundle("", ["s1"])).toThrow(/name is required/);
  });

  test("save without description/instruction omits those keys", () => {
    const path = saveBundle("plain", ["s1"]);
    const content = require("node:fs").readFileSync(path, "utf-8") as string;
    expect(content).not.toContain("description:");
    expect(content).not.toContain("instruction:");
  });

  test("delete removes the file", () => {
    saveBundle("doomed", ["s1"]);
    expect(getBundle("doomed")).not.toBeNull();
    deleteBundle("doomed");
    expect(getBundle("doomed")).toBeNull();
  });

  test("delete on missing bundle raises BundleNotFoundError", () => {
    expect(() => deleteBundle("ghost")).toThrow(BundleNotFoundError);
  });

  test("bundlePathFor refuses empty-slug names", () => {
    expect(() => bundlePathFor("+++")).toThrow(/empty slug/);
  });

  test("HERMES_BUNDLES_DIR override is honoured (including ~ expansion)", () => {
    const override = mkdtempSync(join(tmpdir(), "bundles-override-"));
    process.env["HERMES_BUNDLES_DIR"] = override;
    const path = bundlePathFor("alpha");
    expect(path.startsWith(override)).toBe(true);
    rmSync(override, { recursive: true, force: true });
  });

  test("HERMES_BUNDLES_DIR with ~ prefix expands to homedir", () => {
    process.env["HERMES_BUNDLES_DIR"] = "~/_hermests-bundles-test";
    const path = bundlePathFor("alpha");
    expect(path).toContain("_hermests-bundles-test");
  });

  test("HERMES_BUNDLES_DIR with bare ~ expands to homedir", () => {
    process.env["HERMES_BUNDLES_DIR"] = "~";
    const path = bundlePathFor("alpha");
    expect(path.endsWith("alpha.yaml")).toBe(true);
  });
});

describe("reloadBundles", () => {
  test("reports added and removed bundles", () => {
    makeBundleYaml("old", ["s1"]);
    scanBundles();
    rmSync(join(bundlesDir, "old.yaml"));
    makeBundleYaml("new", ["s2"]);
    const diff = reloadBundles();
    const added = new Set(diff.added.map((e) => e.name));
    const removed = new Set(diff.removed.map((e) => e.name));
    expect(added.has("new")).toBe(true);
    expect(removed.has("old")).toBe(true);
    expect(diff.total).toBe(1);
  });
});

describe("listBundles", () => {
  test("returns bundles sorted by slug", () => {
    makeBundleYaml("zebra", ["s1"]);
    makeBundleYaml("apple", ["s2"]);
    makeBundleYaml("mango", ["s3"]);
    scanBundles();
    const infoList = listBundles();
    const slugs = infoList.map((b) => b.slug);
    expect(slugs).toEqual([...slugs].sort());
  });
});
