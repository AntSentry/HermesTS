// Ported from upstream portal_tags tests (no dedicated upstream test
// file — exercised via auxiliary_client and conversation_loop request
// shape tests).

import { afterEach, describe, expect, test } from "vitest";

import {
  hermesClientTag,
  nousPortalTags,
  resetHermesVersionProvider,
  setHermesVersionProvider,
} from "../src/portal-tags.js";

afterEach(() => {
  resetHermesVersionProvider();
});

describe("hermesClientTag", () => {
  test("falls back to 'unknown' when no provider wired", () => {
    expect(hermesClientTag()).toBe("client=hermes-client-vunknown");
  });

  test("uses injected provider", () => {
    setHermesVersionProvider(() => "1.2.3");
    expect(hermesClientTag()).toBe("client=hermes-client-v1.2.3");
  });

  test("provider error falls back to 'unknown'", () => {
    setHermesVersionProvider(() => {
      throw new Error("boom");
    });
    expect(hermesClientTag()).toBe("client=hermes-client-vunknown");
  });
});

describe("nousPortalTags", () => {
  test("returns the canonical tag pair", () => {
    setHermesVersionProvider(() => "0.13.0");
    expect(nousPortalTags()).toEqual([
      "product=hermes-agent",
      "client=hermes-client-v0.13.0",
    ]);
  });

  test("returns a fresh array each call (mutation does not bleed)", () => {
    const first = nousPortalTags();
    first.push("extra=1");
    expect(nousPortalTags()).toHaveLength(2);
  });
});
