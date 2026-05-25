import { afterEach, describe, expect, it } from "vitest";
import { resetNousPortalTags, setNousPortalTags } from "../../src/_internal/sibling-stubs.js";
import {
  NOUS_EXTRA_BODY,
  isAuxiliaryNous,
  nousExtraBody,
  setAuxiliaryIsNous,
} from "../../src/auxiliary-client/nous-attribution.js";

afterEach(() => {
  resetNousPortalTags();
  setAuxiliaryIsNous(false);
});

describe("nousExtraBody", () => {
  it("returns a {tags} dict from the current nousPortalTags", () => {
    setNousPortalTags(() => ["client=hermes-cli/1.0", "task=aux"]);
    expect(nousExtraBody()).toEqual({ tags: ["client=hermes-cli/1.0", "task=aux"] });
  });

  it("returns a fresh object — caller mutation cannot poison subsequent calls", () => {
    const a = nousExtraBody();
    a.tags.push("mutated");
    const b = nousExtraBody();
    expect(b.tags).not.toContain("mutated");
  });

  it("reflects hot-reloaded tag updates", () => {
    setNousPortalTags(() => ["a"]);
    expect(nousExtraBody()).toEqual({ tags: ["a"] });
    setNousPortalTags(() => ["b", "c"]);
    expect(nousExtraBody()).toEqual({ tags: ["b", "c"] });
  });
});

describe("NOUS_EXTRA_BODY", () => {
  it("is the module-load-time snapshot from the default stub", () => {
    expect(NOUS_EXTRA_BODY).toEqual({ tags: ["client=hermes-cli-stub"] });
  });
});

describe("auxiliary_is_nous flag", () => {
  it("defaults to false", () => {
    expect(isAuxiliaryNous()).toBe(false);
  });
  it("flips when set", () => {
    setAuxiliaryIsNous(true);
    expect(isAuxiliaryNous()).toBe(true);
    setAuxiliaryIsNous(false);
    expect(isAuxiliaryNous()).toBe(false);
  });
});
