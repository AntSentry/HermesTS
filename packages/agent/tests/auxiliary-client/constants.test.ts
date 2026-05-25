import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  CODEX_AUX_BASE_URL,
  NOUS_DEFAULT_BASE_URL,
  NOUS_MODEL,
  OPENROUTER_MODEL,
} from "../../src/auxiliary-client/constants.js";

describe("auxiliary-client constants", () => {
  it("pins the OpenRouter and Nous default model to gemini-3-flash-preview", () => {
    expect(OPENROUTER_MODEL).toBe("google/gemini-3-flash-preview");
    expect(NOUS_MODEL).toBe("google/gemini-3-flash-preview");
  });

  it("pins the Nous Portal default base URL", () => {
    expect(NOUS_DEFAULT_BASE_URL).toBe("https://inference-api.nousresearch.com/v1");
  });

  it("pins the native Anthropic base URL", () => {
    expect(ANTHROPIC_DEFAULT_BASE_URL).toBe("https://api.anthropic.com");
  });

  it("pins the Codex OAuth base URL with no default model", () => {
    expect(CODEX_AUX_BASE_URL).toBe("https://chatgpt.com/backend-api/codex");
  });
});
