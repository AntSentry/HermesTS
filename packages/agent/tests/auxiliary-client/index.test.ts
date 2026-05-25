import { describe, expect, it } from "vitest";
import * as aux from "../../src/auxiliary-client/index.js";
import * as pkg from "../../src/index.js";

describe("auxiliary-client/index barrel", () => {
  it("re-exports the slice 1 public surface", () => {
    const expected = [
      // constants
      "OPENROUTER_MODEL",
      "NOUS_MODEL",
      "NOUS_DEFAULT_BASE_URL",
      "ANTHROPIC_DEFAULT_BASE_URL",
      "CODEX_AUX_BASE_URL",
      // content-converter
      "convertContentForResponses",
      // headers
      "OR_HEADERS_BASE",
      "buildOrHeaders",
      "buildNvidiaNimHeaders",
      "aiGatewayHeaders",
      "codexCloudflareHeaders",
      "getHeadersLogger",
      // nous-attribution
      "nousExtraBody",
      "NOUS_EXTRA_BODY",
      "isAuxiliaryNous",
      "setAuxiliaryIsNous",
      // openai-proxy
      "OpenAI",
      "isOpenAIClient",
      // pool-helpers
      "selectPoolEntry",
      "peekPoolEntry",
      "poolRuntimeApiKey",
      "poolRuntimeBaseUrl",
      // provider-config
      "OMIT_TEMPERATURE",
      "PROVIDER_ALIASES",
      "normalizeAuxProvider",
      "isKimiModel",
      "isArceeTrinityThinking",
      "fixedTemperatureForModel",
      "compressionThresholdForModel",
      "API_KEY_PROVIDER_AUX_MODELS",
      "API_KEY_PROVIDER_AUX_MODELS_FALLBACK",
      "PROVIDER_VISION_MODELS",
      "PROVIDERS_WITHOUT_VISION",
      "TRUTHY_ENV_VALUES",
      "getAuxModelForProvider",
      "readMainProvider",
      "setReadMainProvider",
      "resetReadMainProvider",
      // url-utils
      "safeInstanceof",
      "extractUrlQueryParams",
      "toOpenAIBaseUrl",
    ];
    for (const name of expected) {
      expect(aux).toHaveProperty(name);
    }
  });
});

describe("@hermests/agent package index", () => {
  it("exposes the auxiliaryClient namespace", () => {
    expect(pkg.auxiliaryClient).toBeDefined();
    expect(typeof pkg.auxiliaryClient.normalizeAuxProvider).toBe("function");
    expect(pkg.auxiliaryClient.OPENROUTER_MODEL).toBe("google/gemini-3-flash-preview");
  });
});
