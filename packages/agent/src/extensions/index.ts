/**
 * Runtime extension registry for cross-package wiring.
 *
 * Faithful divergence from upstream py: upstream uses `from X import Y`
 * inside function bodies to break circular imports and to defer the
 * `tools.*` / `gateway.*` import cost until the function is actually
 * called. TypeScript has no equivalent of Python's late `import`
 * mechanism inside a function body — `import()` returns a Promise and
 * can't be used inside sync helpers like `scanSkillCommands`.
 *
 * Instead, downstream packages register their entry points here at
 * startup, and the agent code looks them up at call time. The registry
 * is a plain object so tests can install fakes per case via
 * `setSkillsToolHooks({...})` and reset with `resetExtensions()`.
 *
 * Modules wired through this registry (and the upstream symbol each
 * replaces):
 *
 *   - `skillsTool`     replaces  `tools.skills_tool.{SKILLS_DIR,
 *                                  skill_view, skill_matches_platform,
 *                                  _parse_frontmatter,
 *                                  _get_disabled_skill_names}`
 *   - `skillUsage`     replaces  `tools.skill_usage.bump_use`
 *   - `sessionContext` replaces  `gateway.session_context.get_session_env`
 *   - `nousManaged`    replaces  `hermes_cli.nous_subscription` +
 *                                  `tools.tool_backend_helpers`
 *   - `hermesHome`     replaces  `hermes_cli.config.ensure_hermes_home` +
 *                                  `hermes_cli.config.load_config`
 *   - `auxiliaryLlm`   replaces  `agent.auxiliary_client.call_llm`
 *                                  (will be wired by #5j once landed)
 *
 * Tests in this package install minimal in-memory fakes; the integrator
 * sub-task (#5o) wires the real packages at startup.
 */

import type { Stats } from "node:fs";

// ─── Skills tool surface (tools.skills_tool) ────────────────────────────

/**
 * Subset of upstream `tools.skills_tool.skill_view` return shape that
 * `skill_commands._load_skill_payload` reads. Other fields exist but
 * the skill plumbing only consumes these.
 */
export interface SkillViewPayload {
  success: boolean;
  name?: string | null;
  path?: string | null;
  skill_dir?: string | null;
  content?: string | null;
  raw_content?: string | null;
  setup_skipped?: boolean;
  setup_needed?: boolean;
  setup_note?: string;
  gateway_setup_hint?: string;
  linked_files?: Record<string, string[] | undefined>;
}

export interface SkillsToolHooks {
  /** Absolute path to the local skills directory (mirrors `tools.skills_tool.SKILLS_DIR`). */
  getSkillsDir(): string;
  /**
   * Load a skill view by name or path. Mirrors `skill_view(name, task_id, preprocess)`
   * and returns the JSON-encoded string the upstream emits (the caller parses it).
   */
  skillView(
    name: string,
    options: { taskId?: string | null | undefined; preprocess?: boolean | undefined },
  ): string;
  /**
   * Parse a SKILL.md frontmatter block. Upstream alias of
   * `agent.skill_utils.parse_frontmatter` but kept routable via the
   * tools shim so `scan_skill_commands` can match upstream symbol patching.
   */
  parseFrontmatter(content: string): [Record<string, unknown>, string];
  /** Platform-compat predicate — mirrors `tools.skills_tool.skill_matches_platform`. */
  skillMatchesPlatform(frontmatter: Record<string, unknown>): boolean;
  /** Disabled skill name set — mirrors `tools.skills_tool._get_disabled_skill_names`. */
  getDisabledSkillNames(): Set<string>;
}

// ─── skill_usage ────────────────────────────────────────────────────────

export interface SkillUsageHooks {
  /** Increments active-usage count for a skill. Best-effort; throws are swallowed by callers. */
  bumpUse(skillName: string): void;
}

// ─── gateway.session_context ────────────────────────────────────────────

export interface SessionContextHooks {
  /**
   * Mirrors `gateway.session_context.get_session_env(name, default)`.
   * Returns the per-session env value or *defaultValue*.
   */
  getSessionEnv(name: string, defaultValue?: string): string;
}

// ─── hermes_cli.config bits used by prompt_builder.load_soul_md ─────────

export interface HermesHomeHooks {
  /** Ensures HERMES_HOME exists. Mirrors `hermes_cli.config.ensure_hermes_home`. */
  ensureHermesHome(): void;
  /** Returns the parsed config.yaml mapping, or `{}` on any error. */
  loadConfig(): Record<string, unknown>;
}

// ─── hermes_cli.nous_subscription / tools.tool_backend_helpers ──────────

export interface NousSubscriptionFeature {
  /** Stable identifier (e.g. `"web"`, `"modal"`). */
  key: string;
  /** Display label rendered into the prompt. */
  label: string;
  /** True if the feature is managed by the active Nous subscription. */
  managed_by_nous: boolean;
  /** True if some provider is currently configured for this feature. */
  active: boolean;
  /** Provider name in use (for the "currently using X" line). */
  current_provider?: string | null;
  /** True if the feature ships included with the subscription by default. */
  included_by_default: boolean;
}

export interface NousSubscriptionFeatures {
  /** True when valid Nous auth is present. */
  nous_auth_present: boolean;
  /** Iterable of features rendered into the prompt block. */
  items(): Iterable<NousSubscriptionFeature>;
}

export interface NousManagedHooks {
  /** Mirrors `tools.tool_backend_helpers.managed_nous_tools_enabled`. */
  managedNousToolsEnabled(): boolean;
  /** Mirrors `hermes_cli.nous_subscription.get_nous_subscription_features`. */
  getNousSubscriptionFeatures(): NousSubscriptionFeatures;
}

// ─── auxiliary_client (#5j) ─────────────────────────────────────────────

/**
 * Minimal OpenAI-shaped response object that `title_generator` consumes.
 * Matches the shape upstream returns from `agent.auxiliary_client.call_llm`.
 */
export interface AuxiliaryLlmResponse {
  choices: Array<{ message: { content: string | null | undefined } }>;
}

export interface CallLlmOptions {
  task: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  timeout?: number;
  main_runtime?: Record<string, unknown> | null;
}

export interface AuxiliaryLlmHooks {
  /** Mirrors `agent.auxiliary_client.call_llm`. */
  callLlm(options: CallLlmOptions): AuxiliaryLlmResponse;
}

// ─── Filesystem hooks (testability) ─────────────────────────────────────

/**
 * Mockable filesystem hooks. The skill plumbing reads the filesystem
 * synchronously — Python's `Path.read_text` is blocking and upstream
 * relies on that — so the same blocking-IO contract is preserved here.
 *
 * Tests substitute a snapshot-style impl that maps a `string` path to a
 * `string` body so a temp-dir round-trip per test is avoided.
 */
export interface AgentFsHooks {
  readTextSync(path: string): string;
  writeTextSync(path: string, data: string): void;
  existsSync(path: string): boolean;
  statSync(path: string): Stats;
  /** Recursive walk yielding absolute paths to every file (followLinks=true). */
  walkSync(root: string, options: { followLinks: boolean }): IterableIterator<{
    root: string;
    dirs: string[];
    files: string[];
  }>;
  /** `glob`-style listing of a directory, returning absolute paths. */
  globDir(dir: string, patterns: string[]): string[];
  mkdirRecursiveSync(path: string): void;
  unlinkSync(path: string): void;
  /** Mirrors `os.utime(path, None)` — bumps mtime to current time. */
  touchSync(path: string): void;
}

// ─── Registry shape ─────────────────────────────────────────────────────

export interface AgentExtensions {
  skillsTool: SkillsToolHooks | null;
  skillUsage: SkillUsageHooks | null;
  sessionContext: SessionContextHooks | null;
  hermesHome: HermesHomeHooks | null;
  nousManaged: NousManagedHooks | null;
  auxiliaryLlm: AuxiliaryLlmHooks | null;
  fs: AgentFsHooks | null;
}

const _registry: AgentExtensions = {
  skillsTool: null,
  skillUsage: null,
  sessionContext: null,
  hermesHome: null,
  nousManaged: null,
  auxiliaryLlm: null,
  fs: null,
};

// ─── Setters / getters ──────────────────────────────────────────────────

export function setSkillsToolHooks(hooks: SkillsToolHooks | null): void {
  _registry.skillsTool = hooks;
}
export function getSkillsToolHooks(): SkillsToolHooks | null {
  return _registry.skillsTool;
}

export function setSkillUsageHooks(hooks: SkillUsageHooks | null): void {
  _registry.skillUsage = hooks;
}
export function getSkillUsageHooks(): SkillUsageHooks | null {
  return _registry.skillUsage;
}

export function setSessionContextHooks(hooks: SessionContextHooks | null): void {
  _registry.sessionContext = hooks;
}
export function getSessionContextHooks(): SessionContextHooks | null {
  return _registry.sessionContext;
}

export function setHermesHomeHooks(hooks: HermesHomeHooks | null): void {
  _registry.hermesHome = hooks;
}
export function getHermesHomeHooks(): HermesHomeHooks | null {
  return _registry.hermesHome;
}

export function setNousManagedHooks(hooks: NousManagedHooks | null): void {
  _registry.nousManaged = hooks;
}
export function getNousManagedHooks(): NousManagedHooks | null {
  return _registry.nousManaged;
}

export function setAuxiliaryLlmHooks(hooks: AuxiliaryLlmHooks | null): void {
  _registry.auxiliaryLlm = hooks;
}
export function getAuxiliaryLlmHooks(): AuxiliaryLlmHooks | null {
  return _registry.auxiliaryLlm;
}

export function setAgentFsHooks(hooks: AgentFsHooks | null): void {
  _registry.fs = hooks;
}
export function getAgentFsHooks(): AgentFsHooks | null {
  return _registry.fs;
}

/** Reset every extension to null (tests). */
export function resetExtensions(): void {
  _registry.skillsTool = null;
  _registry.skillUsage = null;
  _registry.sessionContext = null;
  _registry.hermesHome = null;
  _registry.nousManaged = null;
  _registry.auxiliaryLlm = null;
  _registry.fs = null;
}
