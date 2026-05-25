import { afterEach, describe, expect, it } from "vitest";
import {
  resetProviderProfileResolver,
  setProviderProfileResolver,
} from "../../src/_internal/sibling-stubs.js";
import {
  API_KEY_PROVIDER_AUX_MODELS,
  API_KEY_PROVIDER_AUX_MODELS_FALLBACK,
  OMIT_TEMPERATURE,
  PROVIDERS_WITHOUT_VISION,
  PROVIDER_ALIASES,
  PROVIDER_VISION_MODELS,
  TRUTHY_ENV_VALUES,
  compressionThresholdForModel,
  fixedTemperatureForModel,
  getAuxModelForProvider,
  isArceeTrinityThinking,
  isKimiModel,
  normalizeAuxProvider,
  readMainProvider,
  resetReadMainProvider,
  setReadMainProvider,
} from "../../src/auxiliary-client/provider-config.js";

afterEach(() => {
  resetReadMainProvider();
  resetProviderProfileResolver();
});

describe("PROVIDER_ALIASES", () => {
  it("maps every documented alias to a canonical provider id", () => {
    expect(PROVIDER_ALIASES.google).toBe("gemini");
    expect(PROVIDER_ALIASES["google-gemini"]).toBe("gemini");
    expect(PROVIDER_ALIASES["google-ai-studio"]).toBe("gemini");
    expect(PROVIDER_ALIASES["x-ai"]).toBe("xai");
    expect(PROVIDER_ALIASES["x.ai"]).toBe("xai");
    expect(PROVIDER_ALIASES.grok).toBe("xai");
    expect(PROVIDER_ALIASES.glm).toBe("zai");
    expect(PROVIDER_ALIASES["z-ai"]).toBe("zai");
    expect(PROVIDER_ALIASES["z.ai"]).toBe("zai");
    expect(PROVIDER_ALIASES.zhipu).toBe("zai");
    expect(PROVIDER_ALIASES.kimi).toBe("kimi-coding");
    expect(PROVIDER_ALIASES.moonshot).toBe("kimi-coding");
    expect(PROVIDER_ALIASES["kimi-cn"]).toBe("kimi-coding-cn");
    expect(PROVIDER_ALIASES["moonshot-cn"]).toBe("kimi-coding-cn");
    expect(PROVIDER_ALIASES["gmi-cloud"]).toBe("gmi");
    expect(PROVIDER_ALIASES.gmicloud).toBe("gmi");
    expect(PROVIDER_ALIASES["minimax-china"]).toBe("minimax-cn");
    expect(PROVIDER_ALIASES.minimax_cn).toBe("minimax-cn");
    expect(PROVIDER_ALIASES.claude).toBe("anthropic");
    expect(PROVIDER_ALIASES["claude-code"]).toBe("anthropic");
    expect(PROVIDER_ALIASES.github).toBe("copilot");
    expect(PROVIDER_ALIASES["github-copilot"]).toBe("copilot");
    expect(PROVIDER_ALIASES["github-model"]).toBe("copilot");
    expect(PROVIDER_ALIASES["github-models"]).toBe("copilot");
    expect(PROVIDER_ALIASES["github-copilot-acp"]).toBe("copilot-acp");
    expect(PROVIDER_ALIASES["copilot-acp-agent"]).toBe("copilot-acp");
    expect(PROVIDER_ALIASES.tencent).toBe("tencent-tokenhub");
    expect(PROVIDER_ALIASES.tokenhub).toBe("tencent-tokenhub");
    expect(PROVIDER_ALIASES["tencent-cloud"]).toBe("tencent-tokenhub");
    expect(PROVIDER_ALIASES.tencentmaas).toBe("tencent-tokenhub");
  });

  it("is frozen so accidental mutation throws in strict mode", () => {
    expect(Object.isFrozen(PROVIDER_ALIASES)).toBe(true);
  });
});

describe("normalizeAuxProvider", () => {
  it("returns 'auto' for null, undefined, empty string", () => {
    expect(normalizeAuxProvider(null)).toBe("auto");
    expect(normalizeAuxProvider(undefined)).toBe("auto");
    expect(normalizeAuxProvider("")).toBe("auto");
  });

  it("returns the empty string for whitespace-only input — matches upstream `('   ' or 'auto').strip()`", () => {
    // `("   " or "auto")` in Python keeps the truthy "   ", then `.strip()`
    // collapses it to "". The downstream alias lookup misses, returning "".
    expect(normalizeAuxProvider("   ")).toBe("");
  });

  it("lowercases and trims, then applies aliases", () => {
    expect(normalizeAuxProvider("  GROK  ")).toBe("xai");
    expect(normalizeAuxProvider("ZHIPU")).toBe("zai");
  });

  it("passes through unknown providers verbatim after normalization", () => {
    expect(normalizeAuxProvider("acme")).toBe("acme");
    expect(normalizeAuxProvider("  EXOTIC-thing  ")).toBe("exotic-thing");
  });

  it("rewrites 'codex' to 'openai-codex'", () => {
    expect(normalizeAuxProvider("codex")).toBe("openai-codex");
    expect(normalizeAuxProvider("CODEX")).toBe("openai-codex");
  });

  it("strips 'custom:' prefix and falls through alias lookup", () => {
    expect(normalizeAuxProvider("custom:grok")).toBe("xai");
    expect(normalizeAuxProvider("custom:my-deployment")).toBe("my-deployment");
  });

  it("returns 'custom' when 'custom:' has no suffix", () => {
    expect(normalizeAuxProvider("custom:")).toBe("custom");
    expect(normalizeAuxProvider("CUSTOM:   ")).toBe("custom");
  });

  it("resolves 'main' to the user's main provider when set", () => {
    setReadMainProvider(() => "grok");
    expect(normalizeAuxProvider("main")).toBe("xai");
    setReadMainProvider(() => "deepseek");
    expect(normalizeAuxProvider("MAIN")).toBe("deepseek");
  });

  it("collapses 'main' to 'custom' when main provider is empty/auto/main", () => {
    setReadMainProvider(() => "");
    expect(normalizeAuxProvider("main")).toBe("custom");
    setReadMainProvider(() => "auto");
    expect(normalizeAuxProvider("main")).toBe("custom");
    setReadMainProvider(() => "MAIN");
    expect(normalizeAuxProvider("main")).toBe("custom");
    setReadMainProvider(() => "   ");
    expect(normalizeAuxProvider("main")).toBe("custom");
  });
});

describe("readMainProvider injection", () => {
  it("returns empty string by default", () => {
    expect(readMainProvider()).toBe("");
  });
  it("returns the injected function's result", () => {
    setReadMainProvider(() => "gemini");
    expect(readMainProvider()).toBe("gemini");
  });
  it("reset restores the default", () => {
    setReadMainProvider(() => "x");
    resetReadMainProvider();
    expect(readMainProvider()).toBe("");
  });
});

describe("isKimiModel", () => {
  it.each([
    ["kimi-k2-turbo-preview", true],
    ["kimi", true],
    ["KIMI-K2", true],
    ["moonshot/kimi-k2", true], // slash strip keeps last segment
    ["claude-3", false],
    ["", false],
    [null, false],
    [undefined, false],
    ["openrouter/kimi-coding", true],
    ["openrouter/anthropic-claude", false],
  ])("isKimiModel(%j) → %s", (input, expected) => {
    expect(isKimiModel(input as string | null | undefined)).toBe(expected);
  });
});

describe("isArceeTrinityThinking", () => {
  it.each([
    ["trinity-large-thinking", true],
    ["arcee/trinity-large-thinking", true],
    ["TRINITY-LARGE-THINKING", true],
    ["trinity-large", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("isArceeTrinityThinking(%j) → %s", (input, expected) => {
    expect(isArceeTrinityThinking(input as string | null | undefined)).toBe(expected);
  });
});

describe("fixedTemperatureForModel", () => {
  it("returns OMIT_TEMPERATURE for Kimi models", () => {
    expect(fixedTemperatureForModel("kimi-k2")).toBe(OMIT_TEMPERATURE);
    expect(fixedTemperatureForModel("openrouter/kimi-coding")).toBe(OMIT_TEMPERATURE);
  });

  it("returns 0.5 for Arcee Trinity Thinking", () => {
    expect(fixedTemperatureForModel("trinity-large-thinking")).toBe(0.5);
    expect(fixedTemperatureForModel("arcee/trinity-large-thinking")).toBe(0.5);
  });

  it("returns null for every other model", () => {
    expect(fixedTemperatureForModel("claude-haiku-4-5-20251001")).toBeNull();
    expect(fixedTemperatureForModel(null)).toBeNull();
    expect(fixedTemperatureForModel(undefined)).toBeNull();
    expect(fixedTemperatureForModel("")).toBeNull();
  });

  it("accepts the upstream baseUrl parameter and ignores it", () => {
    // Mirrors upstream signature even though the value is unused today.
    expect(fixedTemperatureForModel("claude", "https://api.anthropic.com")).toBeNull();
    expect(fixedTemperatureForModel("kimi-k2", null)).toBe(OMIT_TEMPERATURE);
    expect(fixedTemperatureForModel("trinity-large-thinking", undefined)).toBe(0.5);
  });
});

describe("compressionThresholdForModel", () => {
  it("returns 0.75 for Arcee Trinity Thinking", () => {
    expect(compressionThresholdForModel("trinity-large-thinking")).toBe(0.75);
    expect(compressionThresholdForModel("arcee/trinity-large-thinking")).toBe(0.75);
  });
  it("returns null for every other model", () => {
    expect(compressionThresholdForModel("claude-haiku-4-5")).toBeNull();
    expect(compressionThresholdForModel(null)).toBeNull();
    expect(compressionThresholdForModel(undefined)).toBeNull();
    expect(compressionThresholdForModel("kimi")).toBeNull();
  });
});

describe("getAuxModelForProvider", () => {
  it("returns the profile.default_aux_model when set", () => {
    setProviderProfileResolver((id) =>
      id === "acme" ? { default_aux_model: "acme-flash" } : null,
    );
    expect(getAuxModelForProvider("acme")).toBe("acme-flash");
  });

  it("falls back to the legacy table when profile has no default_aux_model", () => {
    setProviderProfileResolver((id) => (id === "gemini" ? { default_aux_model: "" } : null));
    expect(getAuxModelForProvider("gemini")).toBe("gemini-3-flash-preview");
  });

  it("falls back to the legacy table when profile lookup is missing", () => {
    setProviderProfileResolver(() => null);
    expect(getAuxModelForProvider("zai")).toBe("glm-4.5-flash");
    expect(getAuxModelForProvider("anthropic")).toBe("claude-haiku-4-5-20251001");
  });

  it("returns empty string when the provider has neither profile nor fallback", () => {
    setProviderProfileResolver(() => null);
    expect(getAuxModelForProvider("unknown-provider")).toBe("");
  });

  it("swallows exceptions from the provider profile lookup and falls back", () => {
    setProviderProfileResolver(() => {
      throw new Error("profile lookup boom");
    });
    expect(getAuxModelForProvider("gemini")).toBe("gemini-3-flash-preview");
    expect(getAuxModelForProvider("nothing")).toBe("");
  });
});

describe("aux-model fallback tables", () => {
  it("exposes the documented fallback table verbatim", () => {
    expect(API_KEY_PROVIDER_AUX_MODELS_FALLBACK).toEqual({
      gemini: "gemini-3-flash-preview",
      zai: "glm-4.5-flash",
      "kimi-coding": "kimi-k2-turbo-preview",
      stepfun: "step-3.5-flash",
      "kimi-coding-cn": "kimi-k2-turbo-preview",
      gmi: "google/gemini-3.1-flash-lite-preview",
      minimax: "MiniMax-M2.7",
      "minimax-oauth": "MiniMax-M2.7-highspeed",
      "minimax-cn": "MiniMax-M2.7",
      anthropic: "claude-haiku-4-5-20251001",
      "ai-gateway": "google/gemini-3-flash",
      "opencode-zen": "gemini-3-flash",
      "opencode-go": "glm-5",
      kilocode: "google/gemini-3-flash-preview",
      "ollama-cloud": "nemotron-3-nano:30b",
      "tencent-tokenhub": "hy3-preview",
    });
  });

  it("API_KEY_PROVIDER_AUX_MODELS aliases the fallback table by reference", () => {
    expect(API_KEY_PROVIDER_AUX_MODELS).toBe(API_KEY_PROVIDER_AUX_MODELS_FALLBACK);
  });

  it("freezes the fallback table", () => {
    expect(Object.isFrozen(API_KEY_PROVIDER_AUX_MODELS_FALLBACK)).toBe(true);
  });
});

describe("vision-related tables", () => {
  it("PROVIDER_VISION_MODELS exposes the documented overrides", () => {
    expect(PROVIDER_VISION_MODELS).toEqual({ xiaomi: "mimo-v2.5", zai: "glm-5v-turbo" });
    expect(Object.isFrozen(PROVIDER_VISION_MODELS)).toBe(true);
  });

  it("PROVIDERS_WITHOUT_VISION contains kimi-coding and kimi-coding-cn", () => {
    expect(PROVIDERS_WITHOUT_VISION.has("kimi-coding")).toBe(true);
    expect(PROVIDERS_WITHOUT_VISION.has("kimi-coding-cn")).toBe(true);
    expect(PROVIDERS_WITHOUT_VISION.has("anthropic")).toBe(false);
    expect(PROVIDERS_WITHOUT_VISION.size).toBe(2);
  });
});

describe("TRUTHY_ENV_VALUES", () => {
  it("contains the documented truthy strings", () => {
    expect(TRUTHY_ENV_VALUES.has("1")).toBe(true);
    expect(TRUTHY_ENV_VALUES.has("true")).toBe(true);
    expect(TRUTHY_ENV_VALUES.has("yes")).toBe(true);
    expect(TRUTHY_ENV_VALUES.has("on")).toBe(true);
    expect(TRUTHY_ENV_VALUES.has("0")).toBe(false);
    expect(TRUTHY_ENV_VALUES.has("TRUE")).toBe(false); // lowercase only
    expect(TRUTHY_ENV_VALUES.size).toBe(4);
  });
});

describe("OMIT_TEMPERATURE sentinel", () => {
  it("is a unique symbol with identity semantics", () => {
    expect(typeof OMIT_TEMPERATURE).toBe("symbol");
    const other = Symbol("OMIT_TEMPERATURE");
    expect(OMIT_TEMPERATURE).not.toBe(other);
    expect(OMIT_TEMPERATURE).toBe(OMIT_TEMPERATURE);
  });
});
