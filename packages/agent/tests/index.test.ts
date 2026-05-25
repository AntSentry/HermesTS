// Smoke test for the package barrel — keeps `src/index.ts` at 100%
// coverage by importing every re-exported symbol surface.

import { describe, expect, test } from "vitest";

import {
  AGENT_PACKAGE_DESCRIPTION,
  IterationBudget,
  SECRET_SOURCES_DESCRIPTION,
  applyAnthropicCacheControl,
  buildSystemPrompt,
  convertScratchpadToThink,
  fileMutationResultLanded,
  isMoonshotModel,
  isTableDivider,
  isWriteDenied,
  jitteredBackoff,
  nousPortalTags,
  realignMarkdownTables,
  resolveLmstudioEffort,
  safeScheduleThreadsafe,
  sanitizeGeminiSchema,
  sanitizeMoonshotToolParameters,
  summarizeManualCompression,
  t,
} from "../src/index.js";

describe("@hermests/agent barrel exports", () => {
  test("AGENT_PACKAGE_DESCRIPTION docstring is preserved", () => {
    expect(AGENT_PACKAGE_DESCRIPTION).toContain("Agent internals");
  });

  test("SECRET_SOURCES_DESCRIPTION re-exported", () => {
    expect(SECRET_SOURCES_DESCRIPTION).toContain("AFTER ~/.hermes/.env");
  });

  test("every leaf module's primary symbol is reachable through barrel", () => {
    expect(typeof IterationBudget).toBe("function");
    expect(typeof applyAnthropicCacheControl).toBe("function");
    expect(typeof buildSystemPrompt).toBe("function");
    expect(typeof convertScratchpadToThink).toBe("function");
    expect(typeof fileMutationResultLanded).toBe("function");
    expect(typeof isMoonshotModel).toBe("function");
    expect(typeof isTableDivider).toBe("function");
    expect(typeof isWriteDenied).toBe("function");
    expect(typeof jitteredBackoff).toBe("function");
    expect(typeof nousPortalTags).toBe("function");
    expect(typeof realignMarkdownTables).toBe("function");
    expect(typeof resolveLmstudioEffort).toBe("function");
    expect(typeof safeScheduleThreadsafe).toBe("function");
    expect(typeof sanitizeGeminiSchema).toBe("function");
    expect(typeof sanitizeMoonshotToolParameters).toBe("function");
    expect(typeof summarizeManualCompression).toBe("function");
    expect(typeof t).toBe("function");
  });
});
