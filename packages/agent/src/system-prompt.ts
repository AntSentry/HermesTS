/**
 * System-prompt assembly for the agent.
 *
 * Faithful port of upstream `agent/system_prompt.py`.
 *
 * The agent's system prompt is built once per session and reused across
 * all turns — only context compression triggers a rebuild. This keeps
 * the upstream prefix cache warm. Three tiers (`stable`, `context`,
 * `volatile`) are joined with `\n\n`.
 *
 * Faithful divergences:
 *   - Upstream imports several constants and helpers from
 *     `agent.prompt_builder` (DEFAULT_AGENT_IDENTITY, MEMORY_GUIDANCE,
 *     PLATFORM_HINTS, TOOL_USE_ENFORCEMENT_GUIDANCE, etc.) and lazy-
 *     resolves runtime helpers via the `_ra()` lazy `import run_agent`
 *     shim. The prompt-builder port lives in sub-task #5f and the
 *     integrators (`AIAgent`, `run_agent.*` helpers) live in sub-task
 *     #5o. Until both land, this module declares the symbol surface as
 *     a `SystemPromptDeps` interface that the caller supplies. The
 *     #5f / #5o porters wire the real implementations at construction.
 *   - The `_ra()` lazy-monkey-patch contract becomes constructor DI in
 *     TS (`SystemPromptDeps`). This is the recommended replacement
 *     documented in the agent brief §5 row 1.
 *   - `agent/system_prompt.py` reads `agent.platform`, `agent.model`,
 *     `agent.valid_tool_names`, etc. via Python attribute access. We
 *     mirror the same shape in the `AgentLike` interface using only
 *     fields actually read by the prompt-assembly code paths.
 */

import { formatInZone, now as hermesNow } from "@hermests/core";

/** Subset of the AIAgent object that system-prompt assembly reads. */
export interface AgentLike {
  loadSoulIdentity: boolean;
  skipContextFiles: boolean;
  validToolNames: ReadonlySet<string> | readonly string[];
  /** "auto" | true | false | string[] — matches upstream `_tool_use_enforcement`. */
  toolUseEnforcement: "auto" | boolean | string[] | string;
  model: string | null;
  provider: string | null;
  platform: string | null;
  passSessionId: boolean;
  sessionId: string | null;
  /** Optional kanban-worker block resolved at agent init. */
  kanbanWorkerGuidance?: string | null;
  /** Cache mutated by `invalidateSystemPrompt`. */
  cachedSystemPrompt: string | null;
  /** Memory store handle. `null` when memory is disabled. */
  memoryStore: MemoryStoreLike | null;
  memoryEnabled: boolean;
  userProfileEnabled: boolean;
  /** External memory provider manager (set by 5k context-compression). */
  memoryManager: MemoryManagerLike | null;
  /** Agent's bound tool definitions — `[{type, function: {name, ...}}, ...]`. */
  tools?: ReadonlyArray<ToolDefinition>;
}

/** Tool definition shape used by `formatToolsForSystemMessage`. */
export interface ToolDefinition {
  type?: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

/** Memory-store subset used here — `format_for_system_prompt(section)`. */
export interface MemoryStoreLike {
  formatForSystemPrompt(section: "memory" | "user"): string | null;
  loadFromDisk(): void;
}

/** External memory manager subset — `build_system_prompt(): string | null`. */
export interface MemoryManagerLike {
  buildSystemPrompt(): string | null;
}

/**
 * Constructor injection for prompt-builder symbols / runtime helpers.
 * The #5f porter populates these; tests pass in whatever fixture
 * surface they need.
 */
export interface SystemPromptDeps {
  // Constants from prompt_builder.py
  DEFAULT_AGENT_IDENTITY: string;
  HERMES_AGENT_HELP_GUIDANCE: string;
  MEMORY_GUIDANCE: string;
  SESSION_SEARCH_GUIDANCE: string;
  SKILLS_GUIDANCE: string;
  KANBAN_GUIDANCE: string;
  COMPUTER_USE_GUIDANCE: string;
  TOOL_USE_ENFORCEMENT_GUIDANCE: string;
  TOOL_USE_ENFORCEMENT_MODELS: readonly string[];
  GOOGLE_MODEL_OPERATIONAL_GUIDANCE: string;
  OPENAI_MODEL_EXECUTION_GUIDANCE: string;
  PLATFORM_HINTS: Readonly<Record<string, string>>;

  // Runtime helpers — the `_ra()` lazy-resolved set.
  loadSoulMd: () => string | null;
  buildEnvironmentHints: () => string | null;
  /**
   * Build the cwd-discovered context-files block. `cwd === null` means
   * "use process.cwd()". `skipSoul` is the SOUL.md-already-loaded flag.
   */
  buildContextFilesPrompt: (opts: { cwd: string | null; skipSoul: boolean }) => string | null;
  buildNousSubscriptionPrompt: (validToolNames: ReadonlySet<string>) => string | null;
  buildSkillsSystemPrompt: (opts: {
    availableTools: ReadonlySet<string>;
    availableToolsets: ReadonlySet<string>;
  }) => string;
  /** Tool-name → toolset-name resolver. Returns `null` when unknown. */
  getToolsetForTool: (toolName: string) => string | null;
  /** Optional platform-hint registry lookup (gateway). */
  getPlatformHint?: (platformKey: string) => string | null;
}

function toSet(names: ReadonlySet<string> | readonly string[]): Set<string> {
  // `new Set(iterable)` accepts both Set and array — no need to branch.
  return new Set(names);
}

function hasTool(names: Set<string>, name: string): boolean {
  return names.has(name);
}

function joinClean(parts: ReadonlyArray<string | null | undefined>): string {
  const cleaned: string[] = [];
  for (const p of parts) {
    if (p && p.trim()) {
      cleaned.push(p.trim());
    }
  }
  return cleaned.join("\n\n");
}

/** Shape returned by `buildSystemPromptParts`. */
export interface SystemPromptParts {
  stable: string;
  context: string;
  volatile: string;
}

/**
 * Assemble the system prompt as three ordered parts.
 *
 * Tier semantics match upstream:
 *   - `stable`   — identity, tool guidance, skills prompt, env hints,
 *     platform hints, model-family operational guidance.
 *   - `context`  — context files (AGENTS.md, .cursorrules, …) plus
 *     the caller-supplied `systemMessage`.
 *   - `volatile` — memory snapshot, USER profile, external memory
 *     block, timestamp line.
 */
export function buildSystemPromptParts(
  agent: AgentLike,
  deps: SystemPromptDeps,
  systemMessage: string | null = null,
): SystemPromptParts {
  const validToolSet = toSet(agent.validToolNames);

  // ── Stable tier ─────────────────────────────────────────────────────
  const stableParts: string[] = [];

  let soulLoaded = false;
  if (agent.loadSoulIdentity || !agent.skipContextFiles) {
    const soulContent = deps.loadSoulMd();
    if (soulContent) {
      stableParts.push(soulContent);
      soulLoaded = true;
    }
  }

  if (!soulLoaded) {
    stableParts.push(deps.DEFAULT_AGENT_IDENTITY);
  }

  stableParts.push(deps.HERMES_AGENT_HELP_GUIDANCE);

  // Tool-aware behavioral guidance — order matches upstream.
  const toolGuidance: string[] = [];
  if (hasTool(validToolSet, "memory")) {
    toolGuidance.push(deps.MEMORY_GUIDANCE);
  }
  if (hasTool(validToolSet, "session_search")) {
    toolGuidance.push(deps.SESSION_SEARCH_GUIDANCE);
  }
  if (hasTool(validToolSet, "skill_manage")) {
    toolGuidance.push(deps.SKILLS_GUIDANCE);
  }
  const kanbanGuidance = agent.kanbanWorkerGuidance;
  if (kanbanGuidance) {
    toolGuidance.push(kanbanGuidance);
  } else if (kanbanGuidance == null && hasTool(validToolSet, "kanban_show")) {
    toolGuidance.push(deps.KANBAN_GUIDANCE);
  }
  if (toolGuidance.length > 0) {
    stableParts.push(toolGuidance.join(" "));
  }

  if (hasTool(validToolSet, "computer_use")) {
    stableParts.push(deps.COMPUTER_USE_GUIDANCE);
  }

  const nousPrompt = deps.buildNousSubscriptionPrompt(validToolSet);
  if (nousPrompt) {
    stableParts.push(nousPrompt);
  }

  // Tool-use enforcement decision (`agent._tool_use_enforcement`).
  if (validToolSet.size > 0) {
    const enforce = agent.toolUseEnforcement;
    const modelLower = (agent.model ?? "").toLowerCase();
    let inject = false;

    if (enforce === true) {
      inject = true;
    } else if (
      typeof enforce === "string" &&
      ["true", "always", "yes", "on"].includes(enforce.toLowerCase())
    ) {
      inject = true;
    } else if (enforce === false) {
      inject = false;
    } else if (
      typeof enforce === "string" &&
      ["false", "never", "no", "off"].includes(enforce.toLowerCase())
    ) {
      inject = false;
    } else if (Array.isArray(enforce)) {
      inject = enforce.some((p) => typeof p === "string" && modelLower.includes(p.toLowerCase()));
    } else {
      // "auto" or any unrecognised value — use hardcoded defaults.
      inject = deps.TOOL_USE_ENFORCEMENT_MODELS.some((p) => modelLower.includes(p));
    }

    if (inject) {
      stableParts.push(deps.TOOL_USE_ENFORCEMENT_GUIDANCE);
      if (modelLower.includes("gemini") || modelLower.includes("gemma")) {
        stableParts.push(deps.GOOGLE_MODEL_OPERATIONAL_GUIDANCE);
      }
      if (
        modelLower.includes("gpt") ||
        modelLower.includes("codex") ||
        modelLower.includes("grok")
      ) {
        stableParts.push(deps.OPENAI_MODEL_EXECUTION_GUIDANCE);
      }
    }
  }

  const hasSkillsTools = ["skills_list", "skill_view", "skill_manage"].some((n) =>
    hasTool(validToolSet, n),
  );
  if (hasSkillsTools) {
    const availToolsets = new Set<string>();
    for (const toolName of validToolSet) {
      const ts = deps.getToolsetForTool(toolName);
      if (ts) {
        availToolsets.add(ts);
      }
    }
    const skillsPrompt = deps.buildSkillsSystemPrompt({
      availableTools: validToolSet,
      availableToolsets: availToolsets,
    });
    if (skillsPrompt) {
      stableParts.push(skillsPrompt);
    }
  }

  // Alibaba Coding Plan API workaround — explicit model identity in
  // the system prompt. Upstream guarantees `agent.model` is non-null
  // when `agent.provider === "alibaba"`.
  if (agent.provider === "alibaba" && agent.model) {
    const fullModel = agent.model;
    const lastSlash = fullModel.lastIndexOf("/");
    const modelShort = lastSlash === -1 ? fullModel : fullModel.slice(lastSlash + 1);
    stableParts.push(
      `You are powered by the model named ${modelShort}. ` +
        `The exact model ID is ${fullModel}. ` +
        `When asked what model you are, always answer based on this information, ` +
        `not on any model name returned by the API.`,
    );
  }

  const envHints = deps.buildEnvironmentHints();
  if (envHints) {
    stableParts.push(envHints);
  }

  const platformKey = (agent.platform ?? "").toLowerCase().trim();
  if (platformKey in deps.PLATFORM_HINTS) {
    stableParts.push(deps.PLATFORM_HINTS[platformKey]!);
  } else if (platformKey && deps.getPlatformHint) {
    try {
      const hint = deps.getPlatformHint(platformKey);
      if (hint) {
        stableParts.push(hint);
      }
    } catch {
      /* swallow — matches upstream `except Exception: pass` */
    }
  }

  // ── Context tier ────────────────────────────────────────────────────
  const contextParts: string[] = [];

  if (systemMessage !== null) {
    contextParts.push(systemMessage);
  }

  if (!agent.skipContextFiles) {
    const contextCwd = process.env.TERMINAL_CWD || null;
    const contextFiles = deps.buildContextFilesPrompt({
      cwd: contextCwd,
      skipSoul: soulLoaded,
    });
    if (contextFiles) {
      contextParts.push(contextFiles);
    }
  }

  // ── Volatile tier ───────────────────────────────────────────────────
  const volatileParts: string[] = [];

  if (agent.memoryStore !== null) {
    if (agent.memoryEnabled) {
      const memBlock = agent.memoryStore.formatForSystemPrompt("memory");
      if (memBlock) {
        volatileParts.push(memBlock);
      }
    }
    if (agent.userProfileEnabled) {
      const userBlock = agent.memoryStore.formatForSystemPrompt("user");
      if (userBlock) {
        volatileParts.push(userBlock);
      }
    }
  }

  if (agent.memoryManager !== null) {
    try {
      const extBlock = agent.memoryManager.buildSystemPrompt();
      if (extBlock) {
        volatileParts.push(extBlock);
      }
    } catch {
      /* swallow — matches upstream */
    }
  }

  // Date-only (not minute-precision) so the system prompt is byte-stable
  // for the full day — upstream comment cites @iamfoz / PR #20451.
  const nowDate = hermesNow();
  const dateStr = formatInZone(nowDate, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  let timestampLine = `Conversation started: ${dateStr}`;
  if (agent.passSessionId && agent.sessionId) {
    timestampLine += `\nSession ID: ${agent.sessionId}`;
  }
  if (agent.model) {
    timestampLine += `\nModel: ${agent.model}`;
  }
  if (agent.provider) {
    timestampLine += `\nProvider: ${agent.provider}`;
  }
  volatileParts.push(timestampLine);

  return {
    stable: joinClean(stableParts),
    context: joinClean(contextParts),
    volatile: joinClean(volatileParts),
  };
}

/**
 * Assemble the full system prompt from all layers.
 *
 * Called once per session (cache lives on `agent.cachedSystemPrompt`)
 * and only rebuilt after context compression events.
 */
export function buildSystemPrompt(
  agent: AgentLike,
  deps: SystemPromptDeps,
  systemMessage: string | null = null,
): string {
  const parts = buildSystemPromptParts(agent, deps, systemMessage);
  return joinClean([parts.stable, parts.context, parts.volatile]);
}

/**
 * Invalidate the cached system prompt, forcing a rebuild on the next
 * turn. Also reloads memory from disk so the rebuilt prompt captures
 * any writes from this session.
 */
export function invalidateSystemPrompt(agent: AgentLike): void {
  agent.cachedSystemPrompt = null;
  if (agent.memoryStore !== null) {
    agent.memoryStore.loadFromDisk();
  }
}

/**
 * Format tool definitions for the system message in the trajectory
 * format. Returns a JSON string — upstream uses
 * `json.dumps(formatted_tools, ensure_ascii=False)`.
 */
export function formatToolsForSystemMessage(agent: AgentLike): string {
  if (!agent.tools || agent.tools.length === 0) {
    return "[]";
  }

  const formatted = agent.tools.map((tool) => {
    const fn = tool.function;
    return {
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters ?? {},
      required: null,
    };
  });
  return JSON.stringify(formatted);
}
