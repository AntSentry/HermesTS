/**
 * Tests for `@hermests/providers/base`.
 *
 * Combines:
 *   - In-scope cases from upstream `tests/providers/test_provider_profiles.py`
 *     (`TestBaseProfile` class — base dataclass defaults).
 *   - Additional tests to reach the 100% coverage threshold required by the
 *     repo-root `vitest.config.ts` (every public method, every branch,
 *     including `fetchModels` and the `UserAgentProvider` injection point).
 *
 * Provider-specific profile tests (`TestNvidiaProfile`, `TestKimiProfile`,
 * etc.) live in the plugin packages — see `docs/deferred-tests.md`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  OMIT_TEMPERATURE,
  ProviderProfile,
  _profileUserAgent,
  resetUserAgentProvider,
  setUserAgentProvider,
} from "../src/base.js";

// Reset the injectable UA provider between tests so test order doesn't matter.
afterEach(() => {
  resetUserAgentProvider();
  vi.restoreAllMocks();
});

describe("OMIT_TEMPERATURE", () => {
  test("is a unique sentinel value (matches upstream `object()` identity semantics)", () => {
    // Symbol identity is stable across imports of this module — the unique
    // symbol type guarantees no other value compares equal.
    expect(typeof OMIT_TEMPERATURE).toBe("symbol");
    expect(OMIT_TEMPERATURE).toBe(OMIT_TEMPERATURE);
    expect(OMIT_TEMPERATURE).not.toBe(Symbol("OMIT_TEMPERATURE"));
  });
});

describe("UserAgentProvider injection", () => {
  test("default returns the static fallback `hermes-cli`", () => {
    expect(_profileUserAgent()).toBe("hermes-cli");
  });

  test("setUserAgentProvider replaces the provider", () => {
    setUserAgentProvider(() => "hermes-cli/9.9.9");
    expect(_profileUserAgent()).toBe("hermes-cli/9.9.9");
  });

  test("resetUserAgentProvider restores the fallback", () => {
    setUserAgentProvider(() => "custom-ua");
    resetUserAgentProvider();
    expect(_profileUserAgent()).toBe("hermes-cli");
  });

  test("provider that throws falls back to `hermes-cli`", () => {
    // Mirrors upstream `try/except Exception` around the cli __version__ import.
    setUserAgentProvider(() => {
      throw new Error("kaboom");
    });
    expect(_profileUserAgent()).toBe("hermes-cli");
  });
});

describe("ProviderProfile constructor — defaults", () => {
  // Ported from upstream `TestBaseProfile` cases — every default field is
  // documented in `providers/base.py` dataclass definition.

  test("required `name` is preserved, all other fields take dataclass defaults", () => {
    const p = new ProviderProfile({ name: "test" });
    expect(p.name).toBe("test");
    expect(p.apiMode).toBe("chat_completions");
    expect(p.aliases).toEqual([]);
    expect(p.displayName).toBe("");
    expect(p.description).toBe("");
    expect(p.signupUrl).toBe("");
    expect(p.envVars).toEqual([]);
    expect(p.baseUrl).toBe("");
    expect(p.modelsUrl).toBe("");
    expect(p.authType).toBe("api_key");
    expect(p.supportsHealthCheck).toBe(true);
    expect(p.fallbackModels).toEqual([]);
    expect(p.hostname).toBe("");
    expect(p.defaultHeaders).toEqual({});
    expect(p.fixedTemperature).toBeNull();
    expect(p.defaultMaxTokens).toBeNull();
    expect(p.defaultAuxModel).toBe("");
  });

  test("every option overrides the corresponding default", () => {
    const p = new ProviderProfile({
      name: "full",
      apiMode: "responses",
      aliases: ["a", "b"],
      displayName: "Full Provider",
      description: "complete",
      signupUrl: "https://example.com/signup",
      envVars: ["X_API_KEY"],
      baseUrl: "https://api.example.com/v1",
      modelsUrl: "https://api.example.com/v1/models",
      authType: "oauth_device_code",
      supportsHealthCheck: false,
      fallbackModels: ["model-a"],
      hostname: "api.example.com",
      defaultHeaders: { "X-Custom": "1" },
      fixedTemperature: 0,
      defaultMaxTokens: 2048,
      defaultAuxModel: "aux-model",
    });
    expect(p.apiMode).toBe("responses");
    expect(p.aliases).toEqual(["a", "b"]);
    expect(p.displayName).toBe("Full Provider");
    expect(p.description).toBe("complete");
    expect(p.signupUrl).toBe("https://example.com/signup");
    expect(p.envVars).toEqual(["X_API_KEY"]);
    expect(p.baseUrl).toBe("https://api.example.com/v1");
    expect(p.modelsUrl).toBe("https://api.example.com/v1/models");
    expect(p.authType).toBe("oauth_device_code");
    expect(p.supportsHealthCheck).toBe(false);
    expect(p.fallbackModels).toEqual(["model-a"]);
    expect(p.hostname).toBe("api.example.com");
    expect(p.defaultHeaders).toEqual({ "X-Custom": "1" });
    expect(p.fixedTemperature).toBe(0);
    expect(p.defaultMaxTokens).toBe(2048);
    expect(p.defaultAuxModel).toBe("aux-model");
  });

  test("fixedTemperature accepts the OMIT_TEMPERATURE sentinel", () => {
    // Pinned upstream behavior for Kimi: omit temperature entirely.
    const p = new ProviderProfile({
      name: "kimi-like",
      fixedTemperature: OMIT_TEMPERATURE,
    });
    expect(p.fixedTemperature).toBe(OMIT_TEMPERATURE);
  });
});

describe("ProviderProfile.getHostname", () => {
  test("returns explicit hostname when set", () => {
    const p = new ProviderProfile({
      name: "x",
      hostname: "api.x.example",
      baseUrl: "https://other.example/v1",
    });
    expect(p.getHostname()).toBe("api.x.example");
  });

  test("derives hostname from baseUrl when not explicit", () => {
    const p = new ProviderProfile({
      name: "x",
      baseUrl: "https://api.gmi-serving.com/v1",
    });
    expect(p.getHostname()).toBe("api.gmi-serving.com");
  });

  test("returns empty string when neither hostname nor baseUrl is set", () => {
    const p = new ProviderProfile({ name: "x" });
    expect(p.getHostname()).toBe("");
  });

  test("returns empty string when baseUrl is unparseable", () => {
    // Upstream `urlparse(...).hostname or ""` returns "" for bare strings —
    // TS `new URL()` throws, so the catch arm covers the same intent.
    const p = new ProviderProfile({ name: "x", baseUrl: "not-a-url" });
    expect(p.getHostname()).toBe("");
  });

  test("returns empty string when URL parses but hostname is empty", () => {
    // Exercises the `|| ""` fallback inside the try block — e.g., file://
    // URLs have an empty `hostname` on most platforms.
    const p = new ProviderProfile({ name: "x", baseUrl: "file:///tmp/x" });
    expect(p.getHostname()).toBe("");
  });
});

describe("ProviderProfile hooks — defaults", () => {
  // Direct ports of upstream `TestBaseProfile` cases.

  test("prepareMessages is pass-through (returns the same reference)", () => {
    const p = new ProviderProfile({ name: "test" });
    const msgs = [{ role: "user", content: "hi" }];
    expect(p.prepareMessages(msgs)).toBe(msgs);
  });

  test("buildExtraBody returns an empty object", () => {
    const p = new ProviderProfile({ name: "test" });
    expect(p.buildExtraBody()).toEqual({});
    // Passing context does not change the default behavior.
    expect(p.buildExtraBody({ sessionId: "s1", anything: true })).toEqual({});
  });

  test("buildApiKwargsExtras returns the empty `[{}, {}]` tuple", () => {
    const p = new ProviderProfile({ name: "test" });
    const [eb, tl] = p.buildApiKwargsExtras();
    expect(eb).toEqual({});
    expect(tl).toEqual({});
    // Context is accepted and ignored.
    const [eb2, tl2] = p.buildApiKwargsExtras({
      reasoningConfig: { enabled: true },
    });
    expect(eb2).toEqual({});
    expect(tl2).toEqual({});
  });
});

describe("ProviderProfile.fetchModels", () => {
  beforeEach(() => {
    // Replace the global fetch so we can assert against headers and bodies.
    vi.stubGlobal("fetch", vi.fn());
  });

  function mockFetchOk(body: unknown): void {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });
  }

  test("returns null when neither modelsUrl nor baseUrl is set", async () => {
    const p = new ProviderProfile({ name: "no-url" });
    const result = await p.fetchModels();
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("uses modelsUrl verbatim when present", async () => {
    mockFetchOk({ data: [{ id: "m1" }, { id: "m2" }] });
    const p = new ProviderProfile({
      name: "p",
      modelsUrl: "https://catalog.example.com/api/v1/models",
      baseUrl: "https://inference.example.com/v1",
    });
    const result = await p.fetchModels();
    expect(result).toEqual(["m1", "m2"]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://catalog.example.com/api/v1/models",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  test("falls back to baseUrl + /models when modelsUrl is missing", async () => {
    mockFetchOk([{ id: "m1" }]);
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1/",
    });
    const result = await p.fetchModels();
    expect(result).toEqual(["m1"]);
    // Trailing slash on baseUrl is stripped before joining `/models`.
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/models",
      expect.any(Object),
    );
  });

  test("sends Bearer auth when apiKey is provided", async () => {
    mockFetchOk({ data: [] });
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
    });
    await p.fetchModels({ apiKey: "sk-test" });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    const headers = (call as [string, { headers: Record<string, string> }])[1].headers;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  test("omits Authorization when apiKey is not provided", async () => {
    mockFetchOk({ data: [] });
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
    });
    await p.fetchModels();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    const headers = (call as [string, { headers: Record<string, string> }])[1].headers;
    expect(headers.Authorization).toBeUndefined();
  });

  test("forwards defaultHeaders and sets a non-default User-Agent", async () => {
    mockFetchOk({ data: [] });
    setUserAgentProvider(() => "hermes-cli/test");
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
      defaultHeaders: { "X-Vendor": "abc" },
    });
    await p.fetchModels();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    const headers = (call as [string, { headers: Record<string, string> }])[1].headers;
    expect(headers["User-Agent"]).toBe("hermes-cli/test");
    expect(headers.Accept).toBe("application/json");
    expect(headers["X-Vendor"]).toBe("abc");
  });

  test("returns null when HTTP response is not ok", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    });
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
    });
    expect(await p.fetchModels()).toBeNull();
  });

  test("accepts list-shape response data (no `data` wrapper)", async () => {
    mockFetchOk([{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
    });
    expect(await p.fetchModels()).toEqual(["m1", "m2", "m3"]);
  });

  test("accepts {data: [...]}-shape response data", async () => {
    mockFetchOk({ data: [{ id: "a" }, { id: "b" }] });
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
    });
    expect(await p.fetchModels()).toEqual(["a", "b"]);
  });

  test("returns empty list when response is neither array nor {data: [...]}", async () => {
    mockFetchOk({ other: "shape" });
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
    });
    expect(await p.fetchModels()).toEqual([]);
  });

  test("skips items missing an `id` string", async () => {
    mockFetchOk({
      data: [{ id: "good" }, { id: 123 }, { name: "no-id" }, null, "not-obj"],
    });
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
    });
    expect(await p.fetchModels()).toEqual(["good"]);
  });

  test("returns null when response body fails to parse as JSON", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("unexpected token");
      },
    });
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
    });
    expect(await p.fetchModels()).toBeNull();
  });

  test("returns null and logs when fetch throws (network error)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
    });
    expect(await p.fetchModels()).toBeNull();
  });

  test("aborts the request when timeout elapses", async () => {
    // Drive the AbortController by rejecting with an AbortError when called.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const p = new ProviderProfile({
      name: "p",
      baseUrl: "https://api.example.com/v1",
    });
    const result = await p.fetchModels({ timeoutMs: 5 });
    expect(result).toBeNull();
  });
});
