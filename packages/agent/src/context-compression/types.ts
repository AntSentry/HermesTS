/**
 * Local interface stubs for the inter-sub-task #5 dependencies that the
 * context-compression scope (#5k) consumes structurally but which live in
 * sibling sub-tasks (#5c model-metadata, #5d memory-provider ABC,
 * #5e redact, #5j auxiliary-client). When those sub-tasks land on `main`
 * the integrator PR (#5o) will swap the local stubs for cross-package
 * imports keyed on the same shapes.
 *
 * Faithful-divergence note: every export here is structural-only — the
 * runtime call sites in this package depend solely on these shapes, not
 * on `instanceof` checks or class identity, so the swap is a pure
 * type-level rename.
 */

/**
 * Local model-metadata stub (#5c). The upstream `MINIMUM_CONTEXT_LENGTH`
 * (64K) is the hard floor every Hermes-supported model must satisfy.
 * Mirrors `agent/model_metadata.py:MINIMUM_CONTEXT_LENGTH`.
 */
export const MINIMUM_CONTEXT_LENGTH = 64000;

/**
 * Approximate request-token estimator. Mirrors the *behavioural contract*
 * of `agent/model_metadata.py:estimate_request_tokens_rough` — the
 * implementation is a chars/4 heuristic plus tool-schema accounting; the
 * exact algorithm is owned by #5c. Until #5c lands, callers in this
 * package pass an injected estimator (constructor arg) so this scope
 * remains testable in isolation.
 */
export interface EstimateRequestTokensRough {
  (
    messages: ReadonlyArray<Record<string, unknown>>,
    options: {
      systemPrompt?: string;
      tools?: ReadonlyArray<Record<string, unknown>> | null;
    },
  ): number;
}

/** Same shape as upstream `estimate_messages_tokens_rough`. */
export interface EstimateMessagesTokensRough {
  (messages: ReadonlyArray<Record<string, unknown>>): number;
}

/** Same shape as upstream `estimate_tokens_rough`. */
export interface EstimateTokensRough {
  (text: string): number;
}

/** Same shape as upstream `get_model_context_length`. */
export interface GetModelContextLength {
  (
    model: string,
    options?: {
      baseUrl?: string;
      apiKey?: string;
      configContextLength?: number | null;
      provider?: string;
      customProviders?: Record<string, unknown> | null;
    },
  ): number;
}

/**
 * Bundle of model-metadata helpers consumed by the context compressor.
 * The compressor takes this in its constructor so the package stays
 * decoupled from #5c.
 */
export interface ModelMetadataApi {
  readonly estimateRequestTokensRough: EstimateRequestTokensRough;
  readonly estimateMessagesTokensRough: EstimateMessagesTokensRough;
  readonly estimateTokensRough: EstimateTokensRough;
  readonly getModelContextLength: GetModelContextLength;
}

/**
 * Local redact-API stub (#5e). The compressor's only consumer is
 * `redact_sensitive_text` — strip secrets from text before it reaches the
 * auxiliary summariser. Until #5e lands the package accepts an injected
 * implementation.
 */
export interface RedactSensitiveText {
  (text: string): string;
}

/**
 * Local auxiliary-client stub (#5j). The context compressor calls a
 * single function (`call_llm`-style: take a prompt, return text) routed
 * to the configured compression model. Until #5j lands callers pass an
 * injected `AuxiliaryClient`.
 */
export interface AuxiliaryCallRequest {
  readonly task: "compression" | "title" | "vision" | "session_search" | "web_extract";
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
  readonly mainRuntime?: MainRuntimeSnapshot | null;
  readonly model?: string | null;
}

export interface AuxiliaryCallResult {
  readonly text: string;
  readonly model: string;
  readonly providerLabel: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

export interface AuxiliaryClient {
  callLlm(request: AuxiliaryCallRequest): Promise<AuxiliaryCallResult>;
  /**
   * Resolve the configured client object for a task. Mirrors
   * `get_text_auxiliary_client(task, main_runtime=...)` in upstream. The
   * returned `client` carries `baseUrl` / `apiKey` for downstream
   * model-metadata lookups; `model` is the resolved aux model id.
   */
  getTextAuxiliaryClient(
    task: AuxiliaryCallRequest["task"],
    options: { mainRuntime?: MainRuntimeSnapshot | null },
  ): {
    client: { baseUrl: string; apiKey: string } | null;
    model: string;
  };
  /**
   * Look up the configured aux provider id for a task ("compression",
   * etc.). Returns "" / "auto" when unset, matching upstream
   * `_resolve_task_provider_model("compression")[0]`.
   */
  resolveTaskProvider(task: AuxiliaryCallRequest["task"]): string;
}

/**
 * Snapshot describing the agent's primary runtime — passed into
 * `getTextAuxiliaryClient` so auxiliary clients that fall back to "use
 * the main client" (`auxiliary.compression.provider: auto`) can reuse
 * the live main provider/base-url/api-key triple.
 */
export interface MainRuntimeSnapshot {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

/**
 * Memory-provider ABC mirror (#5d). The full ABC lives in 5d's package
 * but #5k's `MemoryManager` only needs the structural contract below.
 * Once #5d lands, MemoryProvider here will be replaced with a re-export.
 */
export interface MemoryToolSchema {
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface MemoryProviderInitOptions {
  readonly sessionId: string;
  readonly hermesHome?: string;
  readonly [key: string]: unknown;
}

export interface MemoryProviderTurnContext {
  readonly remainingTokens?: number;
  readonly model?: string;
  readonly platform?: string;
  readonly toolCount?: number;
  readonly [key: string]: unknown;
}

/**
 * Mirrors `agent/memory_provider.py:MemoryProvider`. All methods other
 * than `name`, `get_tool_schemas`, `system_prompt_block`, `prefetch`,
 * `sync_turn`, and `handle_tool_call` are optional in upstream (they
 * default to no-ops). We declare them all as required here to make the
 * contract explicit; mocks/tests use a helper `createMemoryProvider`
 * with sensible defaults.
 */
export interface MemoryProvider {
  readonly name: string;
  getToolSchemas(): ReadonlyArray<MemoryToolSchema>;
  systemPromptBlock(): string;
  prefetch(query: string, options: { sessionId?: string }): string;
  queuePrefetch(query: string, options: { sessionId?: string }): void;
  syncTurn(
    userContent: string,
    assistantContent: string,
    options: { sessionId?: string },
  ): void;
  handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    extras: Record<string, unknown>,
  ): string;
  onTurnStart(
    turnNumber: number,
    message: string,
    context: MemoryProviderTurnContext,
  ): void;
  onSessionEnd(messages: ReadonlyArray<Record<string, unknown>>): void;
  onSessionSwitch(
    newSessionId: string,
    options: {
      parentSessionId?: string;
      reset?: boolean;
      reason?: string;
      [key: string]: unknown;
    },
  ): void;
  onPreCompress(messages: ReadonlyArray<Record<string, unknown>>): string;
  /**
   * Optional metadata-passing modes mirror upstream's runtime
   * `inspect.signature(provider.on_memory_write)` branch. Callers in
   * TS pick the matching overload via the `metadataMode` field below.
   */
  readonly memoryWriteMetadataMode?: "keyword" | "positional" | "legacy";
  onMemoryWrite(
    action: string,
    target: string,
    content: string,
    metadata?: Record<string, unknown> | null,
  ): void;
  onDelegation(
    task: string,
    result: string,
    options: { childSessionId?: string; [key: string]: unknown },
  ): void;
  shutdown(): void;
  initialize(options: MemoryProviderInitOptions): void;
}

/**
 * Match the upstream `tool_error(message)` helper from `tools.registry`.
 * The package consumes this via a small injected function so the agent
 * package never imports `@hermests/tools` (which is downstream).
 */
export interface ToolError {
  (message: string): string;
}

/**
 * Default `tool_error` implementation. Mirrors upstream's plain-JSON
 * `{"error": message}` shape — kept inline as a sensible default for the
 * MemoryManager so callers that don't inject a tools-package helper still
 * get the correct wire format.
 */
export const defaultToolError: ToolError = (message: string): string =>
  JSON.stringify({ error: message });

/**
 * Account-usage models — port of
 * `agent/account_usage.py:AccountUsageWindow` /
 * `AccountUsageSnapshot`.
 */
export interface AccountUsageWindow {
  readonly label: string;
  readonly usedPercent?: number | null;
  readonly resetAt?: Date | null;
  readonly detail?: string | null;
}

export interface AccountUsageSnapshot {
  readonly provider: string;
  readonly source: string;
  readonly fetchedAt: Date;
  readonly title: string;
  readonly plan?: string | null;
  readonly windows: ReadonlyArray<AccountUsageWindow>;
  readonly details: ReadonlyArray<string>;
  readonly unavailableReason?: string | null;
}

export const accountUsageAvailable = (snapshot: AccountUsageSnapshot): boolean =>
  (snapshot.windows.length > 0 || snapshot.details.length > 0) &&
  !snapshot.unavailableReason;
