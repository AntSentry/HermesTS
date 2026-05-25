/**
 * Tests for `@hermests/agent/extensions` — the runtime extension
 * registry. Covers every setter/getter and the reset hook.
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  getAgentFsHooks,
  getAuxiliaryLlmHooks,
  getHermesHomeHooks,
  getNousManagedHooks,
  getSessionContextHooks,
  getSkillUsageHooks,
  getSkillsToolHooks,
  resetExtensions,
  setAgentFsHooks,
  setAuxiliaryLlmHooks,
  setHermesHomeHooks,
  setNousManagedHooks,
  setSessionContextHooks,
  setSkillUsageHooks,
  setSkillsToolHooks,
} from "../src/index.js";

afterEach(() => {
  resetExtensions();
});

test("each hook getter starts null and round-trips through its setter", () => {
  expect(getSkillsToolHooks()).toBeNull();
  expect(getSkillUsageHooks()).toBeNull();
  expect(getSessionContextHooks()).toBeNull();
  expect(getHermesHomeHooks()).toBeNull();
  expect(getNousManagedHooks()).toBeNull();
  expect(getAuxiliaryLlmHooks()).toBeNull();
  expect(getAgentFsHooks()).toBeNull();

  const skillsTool = {
    getSkillsDir: () => "/skills",
    skillView: () => '{"success":false}',
    parseFrontmatter: () => [{}, ""] as [Record<string, unknown>, string],
    skillMatchesPlatform: () => true,
    getDisabledSkillNames: () => new Set<string>(),
  };
  setSkillsToolHooks(skillsTool);
  expect(getSkillsToolHooks()).toBe(skillsTool);

  setSkillUsageHooks({ bumpUse: () => undefined });
  expect(getSkillUsageHooks()).not.toBeNull();

  setSessionContextHooks({ getSessionEnv: () => "" });
  expect(getSessionContextHooks()).not.toBeNull();

  setHermesHomeHooks({ ensureHermesHome: () => undefined, loadConfig: () => ({}) });
  expect(getHermesHomeHooks()).not.toBeNull();

  setNousManagedHooks({
    managedNousToolsEnabled: () => false,
    getNousSubscriptionFeatures: () => ({ nous_auth_present: false, items: () => [] }),
  });
  expect(getNousManagedHooks()).not.toBeNull();

  setAuxiliaryLlmHooks({
    callLlm: () => ({ choices: [{ message: { content: "x" } }] }),
  });
  expect(getAuxiliaryLlmHooks()).not.toBeNull();

  setAgentFsHooks({
    readTextSync: () => "",
    writeTextSync: () => undefined,
    existsSync: () => false,
    statSync: () => ({}) as unknown as import("node:fs").Stats,
    walkSync: function* () {
      // no entries
    },
    globDir: () => [],
    mkdirRecursiveSync: () => undefined,
    unlinkSync: () => undefined,
    touchSync: () => undefined,
  });
  expect(getAgentFsHooks()).not.toBeNull();
});

describe("resetExtensions", () => {
  test("clears every hook", () => {
    setSkillsToolHooks({
      getSkillsDir: () => "/",
      skillView: () => "",
      parseFrontmatter: () => [{}, ""],
      skillMatchesPlatform: () => true,
      getDisabledSkillNames: () => new Set(),
    });
    setSkillUsageHooks({ bumpUse: () => undefined });
    setSessionContextHooks({ getSessionEnv: () => "" });
    setHermesHomeHooks({ ensureHermesHome: () => undefined, loadConfig: () => ({}) });
    setNousManagedHooks({
      managedNousToolsEnabled: () => false,
      getNousSubscriptionFeatures: () => ({ nous_auth_present: false, items: () => [] }),
    });
    setAuxiliaryLlmHooks({ callLlm: () => ({ choices: [{ message: { content: null } }] }) });
    setAgentFsHooks({
      readTextSync: () => "",
      writeTextSync: () => undefined,
      existsSync: () => false,
      statSync: () => ({}) as unknown as import("node:fs").Stats,
      walkSync: function* () {
        // empty
      },
      globDir: () => [],
      mkdirRecursiveSync: () => undefined,
      unlinkSync: () => undefined,
      touchSync: () => undefined,
    });

    resetExtensions();

    expect(getSkillsToolHooks()).toBeNull();
    expect(getSkillUsageHooks()).toBeNull();
    expect(getSessionContextHooks()).toBeNull();
    expect(getHermesHomeHooks()).toBeNull();
    expect(getNousManagedHooks()).toBeNull();
    expect(getAuxiliaryLlmHooks()).toBeNull();
    expect(getAgentFsHooks()).toBeNull();
  });
});

test("setters accept null to clear a single hook", () => {
  setSkillUsageHooks({ bumpUse: () => undefined });
  setSkillUsageHooks(null);
  expect(getSkillUsageHooks()).toBeNull();
});
