import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetHermesVersion,
  resetLoadConfig,
  setHermesVersion,
  setLoadConfig,
} from "../../src/_internal/sibling-stubs.js";
import {
  OR_HEADERS_BASE,
  aiGatewayHeaders,
  buildNvidiaNimHeaders,
  buildOrHeaders,
  codexCloudflareHeaders,
  getHeadersLogger,
} from "../../src/auxiliary-client/headers.js";

afterEach(() => {
  resetLoadConfig();
  resetHermesVersion();
  // Reflect.deleteProperty is the lint-friendly equivalent of `delete process.env.X`.
  Reflect.deleteProperty(process.env, "HERMES_OPENROUTER_CACHE");
  Reflect.deleteProperty(process.env, "HERMES_OPENROUTER_CACHE_TTL");
});

describe("OR_HEADERS_BASE", () => {
  it("matches upstream exactly and is frozen", () => {
    expect(OR_HEADERS_BASE).toEqual({
      "HTTP-Referer": "https://hermes-agent.nousresearch.com",
      "X-Title": "Hermes Agent",
      "X-OpenRouter-Categories": "productivity,cli-agent",
    });
    expect(Object.isFrozen(OR_HEADERS_BASE)).toBe(true);
  });
});

describe("buildOrHeaders", () => {
  it("returns just the base attribution headers when caching is disabled by default", () => {
    setLoadConfig(() => ({}));
    expect(buildOrHeaders()).toEqual({ ...OR_HEADERS_BASE });
  });

  it("returns a fresh object — mutating the result does not poison subsequent calls", () => {
    setLoadConfig(() => ({}));
    const a = buildOrHeaders();
    a["X-Title"] = "patched";
    expect(buildOrHeaders()["X-Title"]).toBe("Hermes Agent");
  });

  it("reads response_cache from the orConfig argument when provided", () => {
    expect(buildOrHeaders({ response_cache: true })["X-OpenRouter-Cache"]).toBe("true");
    expect(buildOrHeaders({ response_cache: true })["X-OpenRouter-Cache-TTL"]).toBe("300");
  });

  it("reads response_cache from disk config when called with undefined", () => {
    setLoadConfig(() => ({ openrouter: { response_cache: true, response_cache_ttl: 500 } }));
    const headers = buildOrHeaders();
    expect(headers["X-OpenRouter-Cache"]).toBe("true");
    expect(headers["X-OpenRouter-Cache-TTL"]).toBe("500");
  });

  it("reads response_cache from disk config when called with null", () => {
    setLoadConfig(() => ({ openrouter: { response_cache: true } }));
    expect(buildOrHeaders(null)["X-OpenRouter-Cache"]).toBe("true");
  });

  it("treats a non-object openrouter section as empty", () => {
    setLoadConfig(() => ({ openrouter: "not-an-object" }));
    expect(buildOrHeaders()).toEqual({ ...OR_HEADERS_BASE });
  });

  it("treats a missing openrouter section as empty", () => {
    setLoadConfig(() => ({ other: 1 }));
    expect(buildOrHeaders()).toEqual({ ...OR_HEADERS_BASE });
  });

  it("swallows config-load exceptions and falls back to defaults", () => {
    setLoadConfig(() => {
      throw new Error("load failed");
    });
    expect(buildOrHeaders()).toEqual({ ...OR_HEADERS_BASE });
  });

  it.each([
    ["1", true],
    ["true", true],
    ["yes", true],
    ["on", true],
    ["TRUE", true], // env var is lowercased before lookup
    ["  TRUE  ", true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["maybe", false],
  ])("HERMES_OPENROUTER_CACHE=%j → cache enabled = %s", (value, enabled) => {
    process.env.HERMES_OPENROUTER_CACHE = value;
    setLoadConfig(() => ({ openrouter: { response_cache: false } }));
    const headers = buildOrHeaders();
    if (enabled) {
      expect(headers["X-OpenRouter-Cache"]).toBe("true");
      expect(headers["X-OpenRouter-Cache-TTL"]).toBe("300");
    } else {
      expect(headers["X-OpenRouter-Cache"]).toBeUndefined();
    }
  });

  it("env-var TTL overrides config when in 1..86400 range", () => {
    process.env.HERMES_OPENROUTER_CACHE = "1";
    process.env.HERMES_OPENROUTER_CACHE_TTL = "120";
    expect(buildOrHeaders()["X-OpenRouter-Cache-TTL"]).toBe("120");
  });

  it("env-var TTL is dropped when out of range", () => {
    process.env.HERMES_OPENROUTER_CACHE = "1";
    process.env.HERMES_OPENROUTER_CACHE_TTL = "0";
    expect(buildOrHeaders()["X-OpenRouter-Cache-TTL"]).toBeUndefined();
    process.env.HERMES_OPENROUTER_CACHE_TTL = "86401";
    expect(buildOrHeaders()["X-OpenRouter-Cache-TTL"]).toBeUndefined();
  });

  it("env-var TTL is dropped when non-numeric", () => {
    process.env.HERMES_OPENROUTER_CACHE = "1";
    process.env.HERMES_OPENROUTER_CACHE_TTL = "abc";
    expect(buildOrHeaders()["X-OpenRouter-Cache-TTL"]).toBeUndefined();
  });

  it("config TTL is dropped when out of range", () => {
    expect(
      buildOrHeaders({ response_cache: true, response_cache_ttl: 0 })["X-OpenRouter-Cache-TTL"],
    ).toBeUndefined();
    expect(
      buildOrHeaders({ response_cache: true, response_cache_ttl: 86401 })["X-OpenRouter-Cache-TTL"],
    ).toBeUndefined();
  });

  it("config TTL truncates floats to integers", () => {
    expect(
      buildOrHeaders({ response_cache: true, response_cache_ttl: 60.9 })["X-OpenRouter-Cache-TTL"],
    ).toBe("60");
  });

  it("config TTL is dropped when not a finite number", () => {
    expect(
      buildOrHeaders({ response_cache: true, response_cache_ttl: "300" })["X-OpenRouter-Cache-TTL"],
    ).toBeUndefined();
    expect(
      buildOrHeaders({ response_cache: true, response_cache_ttl: Number.POSITIVE_INFINITY })[
        "X-OpenRouter-Cache-TTL"
      ],
    ).toBeUndefined();
  });
});

describe("buildNvidiaNimHeaders", () => {
  it("returns the cloud header for build.nvidia.com hostname", () => {
    expect(buildNvidiaNimHeaders("https://integrate.api.nvidia.com/v1")).toEqual({
      "X-BILLING-INVOKE-ORIGIN": "HermesAgent",
    });
  });

  it("returns a fresh object — caller mutation cannot poison the constant", () => {
    const a = buildNvidiaNimHeaders("https://integrate.api.nvidia.com/v1");
    a["X-BILLING-INVOKE-ORIGIN"] = "other";
    const b = buildNvidiaNimHeaders("https://integrate.api.nvidia.com/v1");
    expect(b["X-BILLING-INVOKE-ORIGIN"]).toBe("HermesAgent");
  });

  it("returns empty for unrelated hosts and bad inputs", () => {
    expect(buildNvidiaNimHeaders("https://api.openai.com/v1")).toEqual({});
    expect(buildNvidiaNimHeaders("https://nvidia.example/v1")).toEqual({});
    expect(buildNvidiaNimHeaders(null)).toEqual({});
    expect(buildNvidiaNimHeaders(undefined)).toEqual({});
    expect(buildNvidiaNimHeaders("")).toEqual({});
  });
});

describe("aiGatewayHeaders", () => {
  beforeEach(() => {
    setHermesVersion(() => "9.9.9-test");
  });

  it("includes attribution and version-stamped User-Agent", () => {
    expect(aiGatewayHeaders()).toEqual({
      "HTTP-Referer": "https://hermes-agent.nousresearch.com",
      "X-Title": "Hermes Agent",
      "User-Agent": "HermesAgent/9.9.9-test",
    });
  });

  it("re-reads the version each call (hot reload)", () => {
    setHermesVersion(() => "1.0.0");
    expect(aiGatewayHeaders()["User-Agent"]).toBe("HermesAgent/1.0.0");
    setHermesVersion(() => "2.0.0");
    expect(aiGatewayHeaders()["User-Agent"]).toBe("HermesAgent/2.0.0");
  });
});

describe("codexCloudflareHeaders", () => {
  it("returns just the originator+UA for non-string tokens", () => {
    const base = {
      "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
      originator: "codex_cli_rs",
    };
    expect(codexCloudflareHeaders(null)).toEqual(base);
    expect(codexCloudflareHeaders(undefined)).toEqual(base);
    expect(codexCloudflareHeaders(42)).toEqual(base);
    expect(codexCloudflareHeaders({})).toEqual(base);
    expect(codexCloudflareHeaders("")).toEqual(base);
    expect(codexCloudflareHeaders("   ")).toEqual(base);
  });

  it("returns just the base headers when the JWT has fewer than 2 parts", () => {
    const base = {
      "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
      originator: "codex_cli_rs",
    };
    expect(codexCloudflareHeaders("only-one-part")).toEqual(base);
  });

  it("extracts the chatgpt_account_id from a valid JWT payload", () => {
    const payload = {
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-abc" },
    };
    const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
    const token = `header.${b64}.signature`;
    expect(codexCloudflareHeaders(token)).toEqual({
      "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
      originator: "codex_cli_rs",
      "ChatGPT-Account-ID": "acc-abc",
    });
  });

  it("handles padding-stripped base64url payloads", () => {
    // 1-byte payload requires 2 chars of padding when re-encoded — exercise
    // the `(-segment.length) & 3` padding step.
    const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "id-1" } };
    const b64 = Buffer.from(JSON.stringify(payload), "utf-8")
      .toString("base64url")
      .replace(/=+$/, "");
    const token = `h.${b64}.s`;
    expect(codexCloudflareHeaders(token)["ChatGPT-Account-ID"]).toBe("id-1");
  });

  it("drops the account-ID header when the JWT auth claim is missing", () => {
    const b64 = Buffer.from(JSON.stringify({}), "utf-8").toString("base64url");
    expect(codexCloudflareHeaders(`h.${b64}.s`)).toEqual({
      "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
      originator: "codex_cli_rs",
    });
  });

  it("drops the account-ID header when the auth claim is not an object", () => {
    const payload = { "https://api.openai.com/auth": "string-value" };
    const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
    expect(codexCloudflareHeaders(`h.${b64}.s`)).toEqual({
      "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
      originator: "codex_cli_rs",
    });
  });

  it("drops the account-ID header when chatgpt_account_id is empty or non-string", () => {
    const payloads = [
      { "https://api.openai.com/auth": { chatgpt_account_id: "" } },
      { "https://api.openai.com/auth": { chatgpt_account_id: 12345 } },
      { "https://api.openai.com/auth": { other: "x" } },
    ];
    for (const p of payloads) {
      const b64 = Buffer.from(JSON.stringify(p), "utf-8").toString("base64url");
      expect(codexCloudflareHeaders(`h.${b64}.s`)["ChatGPT-Account-ID"]).toBeUndefined();
    }
  });

  it("tolerates a malformed JWT payload (bad base64) without throwing", () => {
    expect(codexCloudflareHeaders("h.@@@@notbase64@@@@.s")).toEqual({
      "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
      originator: "codex_cli_rs",
    });
  });

  it("tolerates non-JSON payloads without throwing", () => {
    const b64 = Buffer.from("not-json-at-all", "utf-8").toString("base64url");
    expect(codexCloudflareHeaders(`h.${b64}.s`)).toEqual({
      "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
      originator: "codex_cli_rs",
    });
  });
});

describe("getHeadersLogger", () => {
  it("returns the module's logger instance", () => {
    const logger = getHeadersLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.debug).toBe("function");
  });
});
