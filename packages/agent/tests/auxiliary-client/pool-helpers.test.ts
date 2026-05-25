import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CredentialPoolLike,
  type PooledCredentialLike,
  resetLoadPool,
  setLoadPool,
} from "../../src/_internal/sibling-stubs.js";
import {
  peekPoolEntry,
  poolRuntimeApiKey,
  poolRuntimeBaseUrl,
  selectPoolEntry,
} from "../../src/auxiliary-client/pool-helpers.js";

afterEach(() => {
  resetLoadPool();
});

function makePool(overrides: Partial<CredentialPoolLike> = {}): CredentialPoolLike {
  return {
    has_credentials: () => true,
    select: () => ({ runtime_api_key: "sk-1" }) as PooledCredentialLike,
    ...overrides,
  };
}

describe("selectPoolEntry", () => {
  it("returns the loaded pool's selection", () => {
    const entry: PooledCredentialLike = { runtime_api_key: "sk-X" };
    setLoadPool(() => makePool({ select: () => entry }));
    expect(selectPoolEntry("acme")).toEqual({ poolExists: true, entry });
  });

  it("returns (false, null) when loadPool throws", () => {
    setLoadPool(() => {
      throw new Error("disk failure");
    });
    expect(selectPoolEntry("boom")).toEqual({ poolExists: false, entry: null });
  });

  it("returns (false, null) when pool is null", () => {
    setLoadPool(() => null);
    expect(selectPoolEntry("missing")).toEqual({ poolExists: false, entry: null });
  });

  it("returns (false, null) when pool has no credentials", () => {
    setLoadPool(() => makePool({ has_credentials: () => false }));
    expect(selectPoolEntry("empty")).toEqual({ poolExists: false, entry: null });
  });

  it("returns (true, null) when select() throws", () => {
    setLoadPool(() =>
      makePool({
        select: () => {
          throw new Error("rotation locked");
        },
      }),
    );
    expect(selectPoolEntry("rot")).toEqual({ poolExists: true, entry: null });
  });
});

describe("peekPoolEntry", () => {
  it("returns null when loadPool throws", () => {
    setLoadPool(() => {
      throw new Error("disk failure");
    });
    expect(peekPoolEntry("boom")).toBeNull();
  });

  it("returns null when pool is null or has no credentials", () => {
    setLoadPool(() => null);
    expect(peekPoolEntry("none")).toBeNull();
    setLoadPool(() => makePool({ has_credentials: () => false }));
    expect(peekPoolEntry("empty")).toBeNull();
  });

  it("prefers pool.current() over pool.peek() when current returns a value", () => {
    const currentEntry: PooledCredentialLike = { runtime_api_key: "current" };
    const peekEntry: PooledCredentialLike = { runtime_api_key: "peek" };
    const current = vi.fn(() => currentEntry);
    const peek = vi.fn(() => peekEntry);
    setLoadPool(() => makePool({ current, peek }));
    expect(peekPoolEntry("x")).toBe(currentEntry);
    expect(current).toHaveBeenCalledTimes(1);
    expect(peek).not.toHaveBeenCalled();
  });

  it("falls back to pool.peek() when pool.current returns null", () => {
    const peekEntry: PooledCredentialLike = { runtime_api_key: "peek" };
    setLoadPool(() =>
      makePool({
        current: () => null,
        peek: () => peekEntry,
      }),
    );
    expect(peekPoolEntry("x")).toBe(peekEntry);
  });

  it("falls back to pool.peek() when pool has no current() method", () => {
    const peekEntry: PooledCredentialLike = { runtime_api_key: "peek-only" };
    setLoadPool(() =>
      makePool({
        peek: () => peekEntry,
      }),
    );
    // remove the default current by setting it explicitly via overrides
    expect(peekPoolEntry("x")).toBe(peekEntry);
  });

  it("returns null when pool has neither current nor peek", () => {
    setLoadPool(() => makePool({}));
    expect(peekPoolEntry("x")).toBeNull();
  });

  it("returns null when current() throws", () => {
    setLoadPool(() =>
      makePool({
        current: () => {
          throw new Error("nope");
        },
        peek: () => ({ runtime_api_key: "unreachable" }),
      }),
    );
    expect(peekPoolEntry("x")).toBeNull();
  });
});

describe("poolRuntimeApiKey", () => {
  it("returns empty string for null/undefined entry", () => {
    expect(poolRuntimeApiKey(null)).toBe("");
    expect(poolRuntimeApiKey(undefined)).toBe("");
  });

  it("prefers runtime_api_key over access_token", () => {
    expect(poolRuntimeApiKey({ runtime_api_key: "rt-1", access_token: "fb-1" })).toBe("rt-1");
  });

  it("falls back to access_token when runtime_api_key is empty", () => {
    expect(poolRuntimeApiKey({ runtime_api_key: "", access_token: "fb-1" })).toBe("fb-1");
    expect(poolRuntimeApiKey({ access_token: "fb-only" })).toBe("fb-only");
  });

  it("trims whitespace and stringifies non-strings", () => {
    expect(poolRuntimeApiKey({ runtime_api_key: "   token   " })).toBe("token");
    expect(poolRuntimeApiKey({ runtime_api_key: 12345 as unknown as string })).toBe("12345");
  });

  it("returns empty string when both keys are absent", () => {
    expect(poolRuntimeApiKey({})).toBe("");
  });
});

describe("poolRuntimeBaseUrl", () => {
  it("returns the trimmed fallback for null/undefined entry", () => {
    expect(poolRuntimeBaseUrl(null, "  https://x/  ")).toBe("https://x");
    expect(poolRuntimeBaseUrl(undefined)).toBe("");
  });

  it("walks runtime_base_url → inference_base_url → base_url → fallback", () => {
    expect(
      poolRuntimeBaseUrl({
        runtime_base_url: "https://rt/",
        inference_base_url: "https://inf/",
        base_url: "https://base/",
      }),
    ).toBe("https://rt");
    expect(
      poolRuntimeBaseUrl({
        inference_base_url: "https://inf/",
        base_url: "https://base/",
      }),
    ).toBe("https://inf");
    expect(poolRuntimeBaseUrl({ base_url: "https://base/" })).toBe("https://base");
    expect(poolRuntimeBaseUrl({}, "https://fb/")).toBe("https://fb");
  });

  it("strips multiple trailing slashes from the resolved URL", () => {
    expect(poolRuntimeBaseUrl({ runtime_base_url: "https://api////" })).toBe("https://api");
  });
});
