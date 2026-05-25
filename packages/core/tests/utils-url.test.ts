// Ported from tests/test_base_url_hostname.py

import { describe, expect, test } from "vitest";
import { baseUrlHostMatches, baseUrlHostname } from "../src/utils.js";

describe("baseUrlHostname", () => {
  test("empty returns empty string", () => {
    expect(baseUrlHostname("")).toBe("");
    expect(baseUrlHostname(null)).toBe("");
    expect(baseUrlHostname(undefined)).toBe("");
  });

  test("plain host without scheme", () => {
    expect(baseUrlHostname("api.openai.com")).toBe("api.openai.com");
    expect(baseUrlHostname("api.openai.com/v1")).toBe("api.openai.com");
  });

  test("https URL extracts hostname only", () => {
    expect(baseUrlHostname("https://api.openai.com/v1")).toBe("api.openai.com");
    expect(baseUrlHostname("https://api.x.ai/v1")).toBe("api.x.ai");
    expect(baseUrlHostname("https://api.anthropic.com")).toBe("api.anthropic.com");
  });

  test("hostname case insensitive", () => {
    expect(baseUrlHostname("https://API.OpenAI.com/v1")).toBe("api.openai.com");
  });

  test("trailing dot stripped", () => {
    expect(baseUrlHostname("https://api.openai.com./v1")).toBe("api.openai.com");
  });

  test("path containing provider host is not the hostname", () => {
    expect(baseUrlHostname("https://proxy.example.test/api.openai.com/v1")).toBe(
      "proxy.example.test",
    );
    expect(
      baseUrlHostname("https://proxy.example.test/api.anthropic.com/v1"),
    ).toBe("proxy.example.test");
  });

  test("host suffix is not the provider", () => {
    expect(baseUrlHostname("https://api.openai.com.example/v1")).toBe(
      "api.openai.com.example",
    );
    expect(baseUrlHostname("https://api.x.ai.example/v1")).toBe("api.x.ai.example");
  });

  test("port is ignored", () => {
    expect(baseUrlHostname("https://api.openai.com:443/v1")).toBe("api.openai.com");
  });

  test("whitespace stripped", () => {
    expect(baseUrlHostname("  https://api.openai.com/v1  ")).toBe("api.openai.com");
  });

  test("returns empty for malformed URL the WHATWG parser rejects", () => {
    // Bare colon with no host — URL constructor throws. Faithful to the
    // catch-all return in base_url_hostname (py:L335-339).
    expect(baseUrlHostname("http://")).toBe("");
  });
});

describe("baseUrlHostMatches — exact and subdomain", () => {
  test("exact domain matches", () => {
    expect(baseUrlHostMatches("https://openrouter.ai/api/v1", "openrouter.ai")).toBe(
      true,
    );
    expect(baseUrlHostMatches("https://moonshot.ai", "moonshot.ai")).toBe(true);
  });

  test("subdomain matches", () => {
    expect(baseUrlHostMatches("https://api.moonshot.ai/v1", "moonshot.ai")).toBe(true);
    expect(baseUrlHostMatches("https://api.kimi.com/v1", "api.kimi.com")).toBe(true);
    expect(baseUrlHostMatches("https://portal.qwen.ai/v1", "portal.qwen.ai")).toBe(
      true,
    );
  });
});

describe("baseUrlHostMatches — negative cases", () => {
  test("path segment containing domain does not match", () => {
    expect(baseUrlHostMatches("https://evil.test/moonshot.ai/v1", "moonshot.ai")).toBe(
      false,
    );
    expect(
      baseUrlHostMatches("https://proxy.example.test/openrouter.ai/v1", "openrouter.ai"),
    ).toBe(false);
    expect(baseUrlHostMatches("https://proxy/api.kimi.com/v1", "api.kimi.com")).toBe(
      false,
    );
  });

  test("host suffix does not match", () => {
    expect(baseUrlHostMatches("https://moonshot.ai.evil/v1", "moonshot.ai")).toBe(
      false,
    );
    expect(
      baseUrlHostMatches("https://openrouter.ai.example/v1", "openrouter.ai"),
    ).toBe(false);
  });

  test("host prefix does not match", () => {
    expect(baseUrlHostMatches("https://fake-openrouter.ai/v1", "openrouter.ai")).toBe(
      false,
    );
  });
});

describe("baseUrlHostMatches — edge cases", () => {
  test("empty base URL returns false", () => {
    expect(baseUrlHostMatches("", "openrouter.ai")).toBe(false);
    expect(baseUrlHostMatches(null, "openrouter.ai")).toBe(false);
    expect(baseUrlHostMatches(undefined, "openrouter.ai")).toBe(false);
  });

  test("empty domain returns false", () => {
    expect(baseUrlHostMatches("https://openrouter.ai/v1", "")).toBe(false);
    expect(baseUrlHostMatches("https://openrouter.ai/v1", null)).toBe(false);
    expect(baseUrlHostMatches("https://openrouter.ai/v1", undefined)).toBe(false);
  });

  test("case insensitive", () => {
    expect(baseUrlHostMatches("https://OpenRouter.AI/v1", "openrouter.ai")).toBe(true);
    expect(baseUrlHostMatches("https://openrouter.ai/v1", "OPENROUTER.AI")).toBe(true);
  });

  test("trailing dot on domain stripped", () => {
    expect(baseUrlHostMatches("https://openrouter.ai/v1", "openrouter.ai.")).toBe(true);
  });
});

describe("ollama.com URL host check (GHSA-76xc-57q6-vm5m)", () => {
  test("ollama.com path injection rejected", () => {
    expect(
      baseUrlHostMatches("http://127.0.0.1:9000/ollama.com/v1", "ollama.com"),
    ).toBe(false);
  });

  test("ollama.com subdomain lookalike rejected", () => {
    expect(
      baseUrlHostMatches("http://ollama.com.attacker.test:9000/v1", "ollama.com"),
    ).toBe(false);
  });

  test("ollama.com.localtest.me rejected", () => {
    expect(
      baseUrlHostMatches("http://ollama.com.localtest.me:9000/v1", "ollama.com"),
    ).toBe(false);
  });

  test("ollama.ai is not ollama.com", () => {
    expect(baseUrlHostMatches("https://ollama.ai/v1", "ollama.com")).toBe(false);
  });

  test("localhost Ollama port is not ollama.com", () => {
    expect(baseUrlHostMatches("http://localhost:11434/v1", "ollama.com")).toBe(false);
  });

  test("genuine ollama.com matches", () => {
    expect(baseUrlHostMatches("https://ollama.com/api/generate", "ollama.com")).toBe(
      true,
    );
  });

  test("ollama.com subdomain matches", () => {
    expect(baseUrlHostMatches("https://api.ollama.com/v1", "ollama.com")).toBe(true);
  });
});
