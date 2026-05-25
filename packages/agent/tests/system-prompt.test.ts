// Ported from upstream system_prompt.py exercises (the orchestrator
// integration paths live in #5o; here we pin the pure-assembly contract
// against a fixture AgentLike + SystemPromptDeps).

import { describe, expect, test, vi } from "vitest";

import {
  type AgentLike,
  type SystemPromptDeps,
  buildSystemPrompt,
  buildSystemPromptParts,
  formatToolsForSystemMessage,
  invalidateSystemPrompt,
} from "../src/system-prompt.js";

function makeDeps(overrides: Partial<SystemPromptDeps> = {}): SystemPromptDeps {
  return {
    DEFAULT_AGENT_IDENTITY: "DEFAULT-ID",
    HERMES_AGENT_HELP_GUIDANCE: "HELP",
    MEMORY_GUIDANCE: "MEM-GUIDE",
    SESSION_SEARCH_GUIDANCE: "SS-GUIDE",
    SKILLS_GUIDANCE: "SKILL-GUIDE",
    KANBAN_GUIDANCE: "KAN-GUIDE",
    COMPUTER_USE_GUIDANCE: "CU-GUIDE",
    TOOL_USE_ENFORCEMENT_GUIDANCE: "ENFORCE",
    TOOL_USE_ENFORCEMENT_MODELS: ["gpt", "codex", "gemini", "grok"],
    GOOGLE_MODEL_OPERATIONAL_GUIDANCE: "GOOGLE-OPS",
    OPENAI_MODEL_EXECUTION_GUIDANCE: "OPENAI-OPS",
    PLATFORM_HINTS: { telegram: "TELEGRAM-HINT" },
    loadSoulMd: () => null,
    buildEnvironmentHints: () => null,
    buildContextFilesPrompt: () => null,
    buildNousSubscriptionPrompt: () => null,
    buildSkillsSystemPrompt: () => "",
    getToolsetForTool: () => null,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    loadSoulIdentity: false,
    skipContextFiles: true,
    validToolNames: new Set<string>(),
    toolUseEnforcement: "auto",
    model: null,
    provider: null,
    platform: null,
    passSessionId: false,
    sessionId: null,
    cachedSystemPrompt: null,
    memoryStore: null,
    memoryEnabled: false,
    userProfileEnabled: false,
    memoryManager: null,
    ...overrides,
  };
}

describe("buildSystemPromptParts — stable tier", () => {
  test("uses SOUL.md when loaded, skips default identity", () => {
    const deps = makeDeps({ loadSoulMd: () => "SOUL CONTENT" });
    const agent = makeAgent({ loadSoulIdentity: true });
    const parts = buildSystemPromptParts(agent, deps);
    expect(parts.stable).toContain("SOUL CONTENT");
    expect(parts.stable).not.toContain("DEFAULT-ID");
  });

  test("falls back to DEFAULT_AGENT_IDENTITY when SOUL.md absent", () => {
    const deps = makeDeps({ loadSoulMd: () => null });
    const agent = makeAgent({ loadSoulIdentity: true });
    const parts = buildSystemPromptParts(agent, deps);
    expect(parts.stable).toContain("DEFAULT-ID");
  });

  test("includes HELP block always", () => {
    const deps = makeDeps();
    const agent = makeAgent();
    expect(buildSystemPromptParts(agent, deps).stable).toContain("HELP");
  });

  test("memory + session_search + skill_manage guidance injected when tools present", () => {
    const deps = makeDeps();
    const agent = makeAgent({
      validToolNames: new Set(["memory", "session_search", "skill_manage"]),
    });
    const parts = buildSystemPromptParts(agent, deps);
    expect(parts.stable).toContain("MEM-GUIDE");
    expect(parts.stable).toContain("SS-GUIDE");
    expect(parts.stable).toContain("SKILL-GUIDE");
  });

  test("kanban guidance from agent overrides built-in", () => {
    const deps = makeDeps();
    const agent = makeAgent({
      validToolNames: new Set(["kanban_show"]),
      kanbanWorkerGuidance: "MY-KAN",
    });
    const parts = buildSystemPromptParts(agent, deps);
    expect(parts.stable).toContain("MY-KAN");
    expect(parts.stable).not.toContain("KAN-GUIDE");
  });

  test("falls back to KANBAN_GUIDANCE when kanban_show present and no override", () => {
    const deps = makeDeps();
    const agent = makeAgent({ validToolNames: new Set(["kanban_show"]) });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("KAN-GUIDE");
  });

  test("computer_use guidance is its own block", () => {
    const deps = makeDeps();
    const agent = makeAgent({ validToolNames: new Set(["computer_use"]) });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("CU-GUIDE");
  });

  test("nous subscription block injected when builder returns non-empty", () => {
    const deps = makeDeps({ buildNousSubscriptionPrompt: () => "NOUS-SUB" });
    const agent = makeAgent();
    expect(buildSystemPromptParts(agent, deps).stable).toContain("NOUS-SUB");
  });

  test("tool-use enforcement auto path injects for gpt model", () => {
    const deps = makeDeps();
    const agent = makeAgent({
      validToolNames: new Set(["session_search"]),
      model: "gpt-4o",
    });
    const parts = buildSystemPromptParts(agent, deps);
    expect(parts.stable).toContain("ENFORCE");
    expect(parts.stable).toContain("OPENAI-OPS");
  });

  test("tool-use enforcement injects google ops for gemini", () => {
    const deps = makeDeps();
    const agent = makeAgent({
      validToolNames: new Set(["session_search"]),
      model: "gemini-1.5-pro",
    });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("GOOGLE-OPS");
  });

  test("tool-use enforcement string 'always' injects regardless of model", () => {
    const deps = makeDeps();
    const agent = makeAgent({
      validToolNames: new Set(["session_search"]),
      model: "small-local",
      toolUseEnforcement: "always",
    });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("ENFORCE");
  });

  test("tool-use enforcement string 'off' suppresses injection", () => {
    const deps = makeDeps();
    const agent = makeAgent({
      validToolNames: new Set(["session_search"]),
      model: "gpt-4o",
      toolUseEnforcement: "off",
    });
    expect(buildSystemPromptParts(agent, deps).stable).not.toContain("ENFORCE");
  });

  test("tool-use enforcement boolean true forces injection", () => {
    const deps = makeDeps();
    const agent = makeAgent({
      validToolNames: new Set(["session_search"]),
      model: "any-model",
      toolUseEnforcement: true,
    });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("ENFORCE");
  });

  test("tool-use enforcement boolean false suppresses injection", () => {
    const deps = makeDeps();
    const agent = makeAgent({
      validToolNames: new Set(["session_search"]),
      model: "gpt-4o",
      toolUseEnforcement: false,
    });
    expect(buildSystemPromptParts(agent, deps).stable).not.toContain("ENFORCE");
  });

  test("tool-use enforcement custom list matches substring", () => {
    const deps = makeDeps();
    const agent = makeAgent({
      validToolNames: new Set(["session_search"]),
      model: "mistral-7b",
      toolUseEnforcement: ["mistral"],
    });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("ENFORCE");
  });

  test("tool-use enforcement no tools = no injection", () => {
    const deps = makeDeps();
    const agent = makeAgent({ model: "gpt-4o" });
    expect(buildSystemPromptParts(agent, deps).stable).not.toContain("ENFORCE");
  });

  test("skills-tool path queries getToolsetForTool and feeds skills prompt", () => {
    const deps = makeDeps({
      getToolsetForTool: (n) => (n === "skills_list" ? "core" : null),
      buildSkillsSystemPrompt: ({ availableToolsets }) =>
        `SKILLS:${[...availableToolsets].join(",")}`,
    });
    const agent = makeAgent({ validToolNames: new Set(["skills_list"]) });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("SKILLS:core");
  });

  test("alibaba provider injects explicit model identity", () => {
    const deps = makeDeps();
    const agent = makeAgent({
      provider: "alibaba",
      model: "alibaba/glm-4.7-coding",
    });
    const stable = buildSystemPromptParts(agent, deps).stable;
    expect(stable).toContain("glm-4.7-coding");
    expect(stable).toContain("alibaba/glm-4.7-coding");
  });

  test("alibaba provider with bare model name uses the whole name", () => {
    const deps = makeDeps();
    const agent = makeAgent({ provider: "alibaba", model: "qwen" });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("model named qwen");
  });

  test("env hints injected when builder returns non-empty", () => {
    const deps = makeDeps({ buildEnvironmentHints: () => "ENV-WSL" });
    expect(buildSystemPromptParts(makeAgent(), deps).stable).toContain("ENV-WSL");
  });

  test("platform hint from registry used when not in built-in hints", () => {
    const deps = makeDeps({
      PLATFORM_HINTS: {},
      getPlatformHint: (k) => (k === "discord" ? "DISCORD-HINT" : null),
    });
    const agent = makeAgent({ platform: "Discord" });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("DISCORD-HINT");
  });

  test("platform registry throwing is swallowed", () => {
    const deps = makeDeps({
      PLATFORM_HINTS: {},
      getPlatformHint: () => {
        throw new Error("boom");
      },
    });
    const agent = makeAgent({ platform: "slack" });
    const parts = buildSystemPromptParts(agent, deps);
    expect(parts.stable).not.toContain("slack");
  });

  test("built-in PLATFORM_HINTS lookup wins over registry", () => {
    const deps = makeDeps({
      PLATFORM_HINTS: { telegram: "TG" },
      getPlatformHint: () => "OTHER",
    });
    const agent = makeAgent({ platform: "telegram" });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("TG");
  });

  test("no platform set means no platform hint added", () => {
    const deps = makeDeps({ getPlatformHint: () => "X" });
    expect(buildSystemPromptParts(makeAgent(), deps).stable).not.toContain("X");
  });
});

describe("buildSystemPromptParts — context tier", () => {
  test("includes caller-supplied system message", () => {
    const deps = makeDeps();
    const parts = buildSystemPromptParts(makeAgent(), deps, "caller-msg");
    expect(parts.context).toContain("caller-msg");
  });

  test("calls buildContextFilesPrompt when not skipping", () => {
    const deps = makeDeps({
      buildContextFilesPrompt: ({ skipSoul }) => `CTX-FILES skipSoul=${skipSoul}`,
    });
    const agent = makeAgent({ skipContextFiles: false });
    expect(buildSystemPromptParts(agent, deps).context).toContain("CTX-FILES skipSoul=false");
  });

  test("propagates TERMINAL_CWD into context-files builder", () => {
    const original = process.env.TERMINAL_CWD;
    process.env.TERMINAL_CWD = "/some/cwd";
    try {
      let captured: string | null | undefined;
      const deps = makeDeps({
        buildContextFilesPrompt: ({ cwd }) => {
          captured = cwd;
          return "x";
        },
      });
      buildSystemPromptParts(makeAgent({ skipContextFiles: false }), deps);
      expect(captured).toBe("/some/cwd");
    } finally {
      if (original === undefined) {
        delete process.env.TERMINAL_CWD;
      } else {
        process.env.TERMINAL_CWD = original;
      }
    }
  });
});

describe("buildSystemPromptParts — volatile tier", () => {
  test("emits memory + user blocks when store present", () => {
    const memStore = {
      formatForSystemPrompt: vi.fn((section: "memory" | "user") =>
        section === "memory" ? "MEM-BLOCK" : "USER-BLOCK",
      ),
      loadFromDisk: vi.fn(),
    };
    const agent = makeAgent({
      memoryStore: memStore,
      memoryEnabled: true,
      userProfileEnabled: true,
    });
    const parts = buildSystemPromptParts(agent, makeDeps());
    expect(parts.volatile).toContain("MEM-BLOCK");
    expect(parts.volatile).toContain("USER-BLOCK");
  });

  test("skips memory block when memoryEnabled false but still emits user block", () => {
    const memStore = {
      formatForSystemPrompt: vi.fn((section) => `${section}-block`),
      loadFromDisk: vi.fn(),
    };
    const agent = makeAgent({
      memoryStore: memStore,
      memoryEnabled: false,
      userProfileEnabled: true,
    });
    const parts = buildSystemPromptParts(agent, makeDeps());
    expect(parts.volatile).not.toContain("memory-block");
    expect(parts.volatile).toContain("user-block");
  });

  test("null memory store skips memory section entirely", () => {
    const agent = makeAgent();
    const parts = buildSystemPromptParts(agent, makeDeps());
    // Timestamp line always present.
    expect(parts.volatile).toContain("Conversation started:");
  });

  test("external memory manager block injected when non-null", () => {
    const mgr = { buildSystemPrompt: vi.fn(() => "EXT-MEM") };
    const agent = makeAgent({ memoryManager: mgr });
    expect(buildSystemPromptParts(agent, makeDeps()).volatile).toContain("EXT-MEM");
  });

  test("external memory manager throwing is swallowed", () => {
    const mgr = {
      buildSystemPrompt: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    const agent = makeAgent({ memoryManager: mgr });
    const parts = buildSystemPromptParts(agent, makeDeps());
    expect(parts.volatile).toContain("Conversation started:");
  });

  test("session/model/provider lines added when present", () => {
    const agent = makeAgent({
      passSessionId: true,
      sessionId: "sess-1",
      model: "gpt-4o",
      provider: "openai",
    });
    const parts = buildSystemPromptParts(agent, makeDeps());
    expect(parts.volatile).toContain("Session ID: sess-1");
    expect(parts.volatile).toContain("Model: gpt-4o");
    expect(parts.volatile).toContain("Provider: openai");
  });

  test("session id omitted when passSessionId false", () => {
    const agent = makeAgent({ passSessionId: false, sessionId: "sess-1" });
    expect(buildSystemPromptParts(agent, makeDeps()).volatile).not.toContain("Session ID");
  });

  test("memoryEnabled with non-string store result skips line", () => {
    const memStore = {
      formatForSystemPrompt: vi.fn(() => null),
      loadFromDisk: vi.fn(),
    };
    const agent = makeAgent({
      memoryStore: memStore,
      memoryEnabled: true,
      userProfileEnabled: true,
    });
    const parts = buildSystemPromptParts(agent, makeDeps());
    expect(parts.volatile).toContain("Conversation started:");
  });

  test("validToolNames passed as readonly array also recognized", () => {
    const deps = makeDeps();
    const agent = makeAgent({ validToolNames: ["memory"] as const });
    expect(buildSystemPromptParts(agent, deps).stable).toContain("MEM-GUIDE");
  });
});

describe("buildSystemPrompt", () => {
  test("joins stable + context + volatile with double newline", () => {
    const deps = makeDeps({ loadSoulMd: () => "SOUL" });
    const agent = makeAgent({ loadSoulIdentity: true });
    const out = buildSystemPrompt(agent, deps, "caller-sys");
    expect(out).toContain("SOUL");
    expect(out).toContain("HELP");
    expect(out).toContain("caller-sys");
    expect(out).toContain("Conversation started:");
  });
});

describe("invalidateSystemPrompt", () => {
  test("clears cache and reloads memory when present", () => {
    const memStore = {
      formatForSystemPrompt: vi.fn(() => null),
      loadFromDisk: vi.fn(),
    };
    const agent = makeAgent({ cachedSystemPrompt: "stale", memoryStore: memStore });
    invalidateSystemPrompt(agent);
    expect(agent.cachedSystemPrompt).toBe(null);
    expect(memStore.loadFromDisk).toHaveBeenCalledOnce();
  });

  test("clears cache when memory store absent", () => {
    const agent = makeAgent({ cachedSystemPrompt: "stale" });
    invalidateSystemPrompt(agent);
    expect(agent.cachedSystemPrompt).toBe(null);
  });
});

describe("formatToolsForSystemMessage", () => {
  test("returns [] when no tools", () => {
    expect(formatToolsForSystemMessage(makeAgent())).toBe("[]");
  });

  test("serializes tool definitions to JSON with required=null", () => {
    const agent = makeAgent({
      tools: [
        { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } },
      ],
    });
    const out = formatToolsForSystemMessage(agent);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual([
      { name: "f", description: "d", parameters: { type: "object" }, required: null },
    ]);
  });

  test("uses defaults for missing description/parameters", () => {
    const agent = makeAgent({
      tools: [{ type: "function", function: { name: "g" } }],
    });
    const parsed = JSON.parse(formatToolsForSystemMessage(agent));
    expect(parsed[0].description).toBe("");
    expect(parsed[0].parameters).toEqual({});
  });
});
