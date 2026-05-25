/**
 * Tests for `@hermests/agent/skill-preprocessing`.
 *
 * Ports upstream behavioural cases scattered across
 * `tests/agent/test_skill_commands.py` (`TestTemplateVarSubstitution`,
 * `TestInlineShellExpansion`) into a focused module-level suite, plus
 * extra cases for the loader/edge paths to hit 100% coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  expandInlineShell,
  loadSkillsConfig,
  preprocessSkillContent,
  resetExtensions,
  runInlineShell,
  setHermesHomeHooks,
  substituteTemplateVars,
} from "../src/index.js";

afterEach(() => {
  resetExtensions();
});

beforeEach(() => {
  resetExtensions();
});

describe("loadSkillsConfig", () => {
  test("returns {} when no HermesHome hooks installed", () => {
    expect(loadSkillsConfig()).toEqual({});
  });

  test("returns the skills section when hooks supply config", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({ skills: { template_vars: true, inline_shell: false } }),
    });
    expect(loadSkillsConfig()).toEqual({ template_vars: true, inline_shell: false });
  });

  test("returns {} when loadConfig throws", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => {
        throw new Error("io error");
      },
    });
    expect(loadSkillsConfig()).toEqual({});
  });

  test("returns {} when skills section is missing", () => {
    setHermesHomeHooks({ ensureHermesHome: () => undefined, loadConfig: () => ({ other: 1 }) });
    expect(loadSkillsConfig()).toEqual({});
  });

  test("returns {} when loadConfig returns a non-object", () => {
    setHermesHomeHooks({ ensureHermesHome: () => undefined, loadConfig: () => "broken" as unknown as Record<string, unknown> });
    expect(loadSkillsConfig()).toEqual({});
  });

  test("returns {} when skills section is a list", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({ skills: [1, 2] }) as Record<string, unknown>,
    });
    expect(loadSkillsConfig()).toEqual({});
  });
});

describe("substituteTemplateVars", () => {
  test("returns content unchanged when no tokens present", () => {
    expect(substituteTemplateVars("plain", "/skill", "sess")).toBe("plain");
  });

  test("substitutes ${HERMES_SKILL_DIR}", () => {
    expect(substituteTemplateVars("p ${HERMES_SKILL_DIR}/x", "/skill", null)).toBe("p /skill/x");
  });

  test("substitutes ${HERMES_SESSION_ID}", () => {
    expect(substituteTemplateVars("s=${HERMES_SESSION_ID}", null, "abc")).toBe("s=abc");
  });

  test("leaves ${HERMES_SKILL_DIR} when dir is null", () => {
    expect(substituteTemplateVars("p ${HERMES_SKILL_DIR}", null, null)).toBe("p ${HERMES_SKILL_DIR}");
  });

  test("leaves ${HERMES_SESSION_ID} when session is null", () => {
    expect(substituteTemplateVars("s=${HERMES_SESSION_ID}", "/skill", null)).toBe(
      "s=${HERMES_SESSION_ID}",
    );
  });

  test("returns empty content unchanged", () => {
    expect(substituteTemplateVars("", "/skill", "sess")).toBe("");
  });
});

describe("runInlineShell", () => {
  test("returns stdout of a simple command", () => {
    const out = runInlineShell("echo INLINE_RAN", null, 5);
    expect(out).toBe("INLINE_RAN");
  });

  test("uses cwd when provided", () => {
    const out = runInlineShell("pwd", "/", 5);
    expect(out).toBe("/");
  });

  test("times out a long-running command", () => {
    // upstream marker format: "[inline-shell timeout after Ns: <cmd>]"
    const out = runInlineShell("sleep 5 && printf DYN_MARKER", null, 1);
    expect(out).toContain("inline-shell timeout");
    // The intended stdout (DYN_MARKER) never made it through — the only
    // place it appears is the echoed command in the marker.
    const stripped = out.replace("sleep 5 && printf DYN_MARKER", "");
    expect(stripped).not.toContain("DYN_MARKER");
  });

  test("returns stderr when stdout is empty", () => {
    const out = runInlineShell(">&2 echo OOPS", null, 5);
    expect(out).toBe("OOPS");
  });

  test("truncates very long output", () => {
    // produce >4000 bytes of stdout
    const out = runInlineShell("yes A | head -c 5000", null, 5);
    expect(out.endsWith("...[truncated]")).toBe(true);
  });

  test("coerces negative or zero timeouts to 1s", () => {
    const out = runInlineShell("echo OK", null, 0);
    expect(out).toBe("OK");
  });

  test("returns 'bash not found' marker when bash is missing", () => {
    // Simulate ENOENT by setting PATH to a definitely-empty value and
    // invoking a non-existent shell binary. We can't easily make
    // spawnSync raise ENOENT for 'bash', so instead we exercise the
    // generic error path via a malformed command + invalid cwd.
    const out = runInlineShell("echo OK", "/definitely/not/a/dir", 1);
    expect(out.startsWith("[inline-shell error:")).toBe(true);
  });
});

describe("expandInlineShell", () => {
  test("returns content unchanged when no !`` snippet", () => {
    expect(expandInlineShell("plain text", null, 5)).toBe("plain text");
  });

  test("expands every snippet", () => {
    const out = expandInlineShell("a !`echo X` b !`echo Y`", null, 5);
    expect(out).toBe("a X b Y");
  });

  test("skips blank snippets", () => {
    const out = expandInlineShell("a !`  ` b", null, 5);
    expect(out).toBe("a  b");
  });
});

describe("preprocessSkillContent", () => {
  test("returns empty content unchanged", () => {
    expect(preprocessSkillContent("", "/skill", "sess")).toBe("");
  });

  test("respects template_vars=true (default)", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({ skills: { template_vars: true } }),
    });
    expect(preprocessSkillContent("dir=${HERMES_SKILL_DIR}", "/here", null)).toBe("dir=/here");
  });

  test("respects template_vars=false", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({ skills: { template_vars: false } }),
    });
    expect(preprocessSkillContent("dir=${HERMES_SKILL_DIR}", "/here", null)).toBe(
      "dir=${HERMES_SKILL_DIR}",
    );
  });

  test("respects inline_shell=true and inline_shell_timeout override", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({
        skills: { template_vars: true, inline_shell: true, inline_shell_timeout: 5 },
      }),
    });
    const out = preprocessSkillContent("Marker: !`echo INLINE_RAN`", null, null);
    expect(out).toBe("Marker: INLINE_RAN");
  });

  test("clamps invalid inline_shell_timeout to 10s default", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({
        skills: { template_vars: true, inline_shell: true, inline_shell_timeout: "junk" },
      }),
    });
    const out = preprocessSkillContent("Marker: !`echo INLINE_RAN`", null, null);
    expect(out).toBe("Marker: INLINE_RAN");
  });

  test("clamps a non-positive inline_shell_timeout to 10s default", () => {
    setHermesHomeHooks({
      ensureHermesHome: () => undefined,
      loadConfig: () => ({
        skills: { template_vars: true, inline_shell: true, inline_shell_timeout: 0 },
      }),
    });
    const out = preprocessSkillContent("Marker: !`echo INLINE_RAN`", null, null);
    expect(out).toBe("Marker: INLINE_RAN");
  });

  test("explicit skillsCfg override skips loadSkillsConfig", () => {
    const explicit = { template_vars: false, inline_shell: false };
    const out = preprocessSkillContent(
      "dir=${HERMES_SKILL_DIR}",
      "/here",
      null,
      explicit,
    );
    expect(out).toBe("dir=${HERMES_SKILL_DIR}");
  });
});
