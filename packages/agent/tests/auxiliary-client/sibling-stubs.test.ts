import { afterEach, describe, expect, it } from "vitest";
import {
  getHermesHome,
  getProviderProfile,
  hermesVersion,
  loadConfig,
  loadPool,
  nousPortalTags,
  resetGetHermesHome,
  resetHermesVersion,
  resetLoadConfig,
  resetLoadPool,
  resetNousPortalTags,
  resetProviderProfileResolver,
  setGetHermesHome,
  setHermesVersion,
  setLoadConfig,
  setLoadPool,
  setNousPortalTags,
  setProviderProfileResolver,
} from "../../src/_internal/sibling-stubs.js";

afterEach(() => {
  resetGetHermesHome();
  resetHermesVersion();
  resetLoadConfig();
  resetLoadPool();
  resetNousPortalTags();
  resetProviderProfileResolver();
});

describe("load_pool stub", () => {
  it("throws by default — integrator must register a real impl", () => {
    expect(() => loadPool("any")).toThrow(/no implementation/);
  });
  it("delegates to the registered function", () => {
    setLoadPool((p) => ({
      has_credentials: () => p === "ok",
      select: () => null,
    }));
    expect(loadPool("ok")?.has_credentials()).toBe(true);
    expect(loadPool("nope")?.has_credentials()).toBe(false);
  });
  it("reset restores the throwing default", () => {
    setLoadPool(() => null);
    resetLoadPool();
    expect(() => loadPool("x")).toThrow();
  });
});

describe("provider profile stub", () => {
  it("returns null by default", () => {
    expect(getProviderProfile("anything")).toBeNull();
  });
  it("delegates and resets", () => {
    setProviderProfileResolver((id) => (id === "x" ? { default_aux_model: "m" } : null));
    expect(getProviderProfile("x")).toEqual({ default_aux_model: "m" });
    expect(getProviderProfile("y")).toBeNull();
    resetProviderProfileResolver();
    expect(getProviderProfile("x")).toBeNull();
  });
});

describe("hermes_cli config stubs", () => {
  it("loadConfig defaults to {}", () => {
    expect(loadConfig()).toEqual({});
  });
  it("getHermesHome defaults to /tmp/.hermes-stub", () => {
    expect(getHermesHome()).toBe("/tmp/.hermes-stub");
  });
  it("setters override and reset clears", () => {
    setLoadConfig(() => ({ a: 1 }));
    expect(loadConfig()).toEqual({ a: 1 });
    resetLoadConfig();
    expect(loadConfig()).toEqual({});

    setGetHermesHome(() => "/custom/home");
    expect(getHermesHome()).toBe("/custom/home");
    resetGetHermesHome();
    expect(getHermesHome()).toBe("/tmp/.hermes-stub");
  });
});

describe("nousPortalTags stub", () => {
  it("returns a single stub tag by default", () => {
    expect(nousPortalTags()).toEqual(["client=hermes-cli-stub"]);
  });
  it("setters override and reset clears", () => {
    setNousPortalTags(() => ["a", "b"]);
    expect(nousPortalTags()).toEqual(["a", "b"]);
    resetNousPortalTags();
    expect(nousPortalTags()).toEqual(["client=hermes-cli-stub"]);
  });
});

describe("hermesVersion stub", () => {
  it("returns 0.0.0-stub by default", () => {
    expect(hermesVersion()).toBe("0.0.0-stub");
  });
  it("setters override and reset clears", () => {
    setHermesVersion(() => "1.2.3");
    expect(hermesVersion()).toBe("1.2.3");
    resetHermesVersion();
    expect(hermesVersion()).toBe("0.0.0-stub");
  });
});
