/**
 * OpenAI Chat Completions transport.
 *
 * Faithful port of upstream `agent/transports/chat_completions.py`.
 *
 * Handles the default `apiMode = "chat_completions"` used by ~16
 * OpenAI-compatible providers (OpenRouter, Nous, NVIDIA, Qwen, Ollama,
 * DeepSeek, xAI, Kimi, etc.).
 *
 * Messages and tools are already in OpenAI format — `convertMessages`
 * and `convertTools` are near-identity. The complexity lives in
 * `buildKwargs` which has provider-specific conditionals for max_tokens
 * defaults, reasoning configuration, temperature handling, and
 * extra_body assembly.
 *
 * ── Faithful divergences ──────────────────────────────────────────────
 * 1. Upstream imports `DEVELOPER_ROLE_MODELS` from `agent.prompt_builder`
 *    (sub-task #5f). It is a 2-element constant tuple — inlined here as
 *    `DEVELOPER_ROLE_MODELS` so this sub-task ships with no runtime dep
 *    on #5f. Sub-task #5o (integrators) reconciles to a single source.
 * 2. Upstream imports `resolve_lmstudio_effort` from
 *    `agent.lmstudio_reasoning` (sub-task #5a). The full implementation
 *    is inlined here as `resolveLmstudioEffort` so this sub-task is
 *    self-contained. #5o reconciles to the #5a export.
 * 3. Upstream imports `is_moonshot_model` and `sanitize_moonshot_tools`
 *    from `agent.moonshot_schema` (sub-task #5a). Both are inlined here
 *    in full — schema-mangling logic is too large to be a stub and too
 *    central to the transport to take on an open question of
 *    cross-sub-task availability. #5o reconciles.
 * 4. The provider-quirk `if/elif` chain is split into small per-feature
 *    helper functions (`_applyKimiTopLevel`, `_applyLmstudio`, etc.) —
 *    matches brief §5 guidance ("use Map<ProviderId, BuildKwargsFn>
 *    instead of if/elif"). Behaviour is byte-for-byte identical.
 * 5. The profile-path delegates to a `ChatCompletionsProvider` interface
 *    declared here — sub-task #8 (plugins) and the integrators will
 *    supply the concrete `ProviderProfile` from `@hermests/providers`.
 *    We accept a structural type so callers can pass any profile that
 *    matches the upstream surface.
 */

import { OMIT_TEMPERATURE, type ProviderProfile } from "@hermests/providers";

import { ProviderTransport, type CacheStats } from "./base.js";
import { registerTransport } from "./registry.js";
import { NormalizedResponse, ToolCall, Usage } from "./types.js";

/** Models that swap their `system` message to `developer` (GPT-5, Codex). */
export const DEVELOPER_ROLE_MODELS: readonly string[] = Object.freeze(["gpt-5", "codex"]);

// ── LM Studio reasoning-effort resolution ─────────────────────────────
// Inlined from upstream `agent/lmstudio_reasoning.py` (#5a leaf util).

const _LM_VALID_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const _LM_EFFORT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  off: "none",
  on: "medium",
});

/**
 * Return the `reasoning_effort` string to send to LM Studio, or `null`.
 *
 * `null` means "omit the field": the user picked a level the model
 * can't honor, so let LM Studio fall back to the model's declared
 * default rather than silently substituting a different effort. When
 * `allowedOptions` is falsy (probe failed), skip clamping and send the
 * resolved effort anyway.
 */
export function resolveLmstudioEffort(
  reasoningConfig: Record<string, unknown> | null | undefined,
  allowedOptions: readonly string[] | null | undefined,
): string | null {
  let effort = "medium";
  if (reasoningConfig && isRecord(reasoningConfig)) {
    if (reasoningConfig.enabled === false) {
      effort = "none";
    } else {
      const rawValue = reasoningConfig.effort;
      const raw =
        typeof rawValue === "string" ? rawValue.trim().toLowerCase() : "";
      const aliased = _LM_EFFORT_ALIASES[raw] ?? raw;
      if (_LM_VALID_EFFORTS.has(aliased)) {
        effort = aliased;
      }
    }
  }
  if (allowedOptions && allowedOptions.length > 0) {
    const allowed = new Set(
      allowedOptions.map((opt) => _LM_EFFORT_ALIASES[opt] ?? opt),
    );
    if (!allowed.has(effort)) {
      return null;
    }
  }
  return effort;
}

// ── Moonshot schema sanitizer ─────────────────────────────────────────
// Inlined from upstream `agent/moonshot_schema.py` (#5a leaf util).

const _SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
]);

const _SCHEMA_LIST_KEYS: ReadonlySet<string> = new Set([
  "anyOf",
  "oneOf",
  "allOf",
  "prefixItems",
]);

const _SCHEMA_NODE_KEYS: ReadonlySet<string> = new Set([
  "items",
  "contains",
  "not",
  "additionalProperties",
  "propertyNames",
]);

/**
 * True for any Kimi / Moonshot model slug, regardless of aggregator
 * prefix. Matches `kimi-k2.6`, `moonshotai/Kimi-K2.6`,
 * `nous/moonshotai/kimi-...`, etc.
 */
export function isMoonshotModel(model: string | null | undefined): boolean {
  if (!model) {
    return false;
  }
  const bare = model.trim().toLowerCase();
  // `Array.prototype.pop()` on a non-empty array always returns a string
  // here (split always produces ≥1 element). The `?? bare` is defensive.
  const tail = bare.includes("/")
    ? /* v8 ignore next */ (bare.split("/").pop() ?? bare)
    : bare;
  if (tail.startsWith("kimi-") || tail === "kimi") {
    return true;
  }
  if (bare.includes("moonshot") || bare.includes("/kimi") || bare.startsWith("kimi")) {
    return true;
  }
  return false;
}

function _fillMissingType(node: Record<string, unknown>): Record<string, unknown> {
  const existing = node.type;
  if (existing !== null && existing !== undefined && existing !== "") {
    return node;
  }
  let inferred: string;
  if ("properties" in node || "required" in node || "additionalProperties" in node) {
    inferred = "object";
  } else if ("items" in node || "prefixItems" in node) {
    inferred = "array";
  } else if (Array.isArray(node.enum) && node.enum.length > 0) {
    const sample = node.enum[0];
    if (typeof sample === "boolean") {
      inferred = "boolean";
    } else if (typeof sample === "number") {
      inferred = Number.isInteger(sample) ? "integer" : "number";
    } else {
      inferred = "string";
    }
  } else {
    inferred = "string";
  }
  return { ...node, type: inferred };
}

function _repairSchema(node: unknown, isSchema = true): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => _repairSchema(item, true));
  }
  // Defensive non-record short-circuit; all call sites funnel through
  // `sanitizeMoonshotToolParameters` which gates on `isRecord(parameters)`
  // first.
  /* v8 ignore start */
  if (!isRecord(node)) {
    return node;
  }
  /* v8 ignore stop */

  const repaired: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (_SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      const sub: Record<string, unknown> = {};
      for (const [subKey, subVal] of Object.entries(value)) {
        sub[subKey] = _repairSchema(subVal, true);
      }
      repaired[key] = sub;
    } else if (_SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      repaired[key] = value.map((v) => _repairSchema(v, true));
    } else if (key === "items" && Array.isArray(value)) {
      // Rule 5: tuple-style `items` arrays must collapse to first element.
      const first = value.length > 0 ? value[0] : {};
      if (isRecord(first)) {
        repaired[key] = _repairSchema(first, true);
      } else {
        repaired[key] = first;
      }
    } else if (_SCHEMA_NODE_KEYS.has(key)) {
      if (isRecord(value)) {
        repaired[key] = _repairSchema(value, true);
      } else {
        repaired[key] = value;
      }
    } else {
      repaired[key] = value;
    }
  }

  // `isSchema=false` is never passed by any caller; the parameter exists
  // for upstream-parity with `_repair_schema(..., is_schema)` which itself
  // never invokes the false branch in production.
  /* v8 ignore start */
  if (!isSchema) {
    return repaired;
  }
  /* v8 ignore stop */

  // Rule 2: anyOf wins over parent type; collapse null branches.
  let working: Record<string, unknown> = repaired;
  if (Array.isArray(working.anyOf)) {
    delete working.type;
    const branches = working.anyOf as unknown[];
    const nonNull = branches.filter(
      (b) => isRecord(b) && (b as { type?: unknown }).type !== "null",
    );
    if (nonNull.length > 0 && nonNull.length < branches.length) {
      if (nonNull.length === 1) {
        const merge: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(working)) {
          if (k !== "anyOf") {
            merge[k] = v;
          }
        }
        const onlyBranch = nonNull[0];
        if (isRecord(onlyBranch)) {
          for (const [k, v] of Object.entries(onlyBranch)) {
            merge[k] = v;
          }
        }
        working = merge;
      } else {
        working.anyOf = nonNull;
        return working;
      }
    } else {
      return working;
    }
  }

  delete working.nullable;

  // Rule 1: fill missing type unless this is a $ref node.
  if (!("$ref" in working)) {
    working = _fillMissingType(working);
  }

  // Rule 3: strip null / empty-string entries from enum on scalar types.
  if (Array.isArray(working.enum)) {
    const nodeType = working.type;
    if (
      nodeType === "string" ||
      nodeType === "integer" ||
      nodeType === "number" ||
      nodeType === "boolean"
    ) {
      const cleaned = (working.enum as unknown[]).filter(
        (v) => v !== null && v !== "",
      );
      if (cleaned.length > 0) {
        working.enum = cleaned;
      } else {
        delete working.enum;
      }
    }
  }

  // Rule 4: $ref siblings get stripped.
  if ("$ref" in working) {
    return { $ref: working.$ref };
  }

  return working;
}

/** Normalise tool parameters to a Moonshot-compatible object schema. */
export function sanitizeMoonshotToolParameters(parameters: unknown): Record<string, unknown> {
  if (!isRecord(parameters)) {
    return { type: "object", properties: {} };
  }
  const repaired = _repairSchema(structuredClone(parameters), true);
  // `_repairSchema` of a record always returns a record; this guard exists
  // so a future refactor can't silently produce a non-object schema.
  /* v8 ignore start */
  if (!isRecord(repaired)) {
    return { type: "object", properties: {} };
  }
  /* v8 ignore stop */
  if (repaired.type !== "object") {
    repaired.type = "object";
  }
  if (!("properties" in repaired)) {
    repaired.properties = {};
  }
  return repaired;
}

/** Apply `sanitizeMoonshotToolParameters` to every tool's parameters. */
export function sanitizeMoonshotTools(
  tools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (tools.length === 0) {
    return tools;
  }
  const sanitized: Array<Record<string, unknown>> = [];
  let anyChange = false;
  for (const tool of tools) {
    if (!isRecord(tool)) {
      sanitized.push(tool);
      continue;
    }
    const fn = tool.function;
    if (!isRecord(fn)) {
      sanitized.push(tool);
      continue;
    }
    const params = fn.parameters;
    const repaired = sanitizeMoonshotToolParameters(params);
    // `sanitizeMoonshotToolParameters` always deep-clones, so the
    // `repaired === params` identity comparison never holds in practice
    // and the else branch is unreachable. Preserved for upstream parity
    // with `sanitize_moonshot_tools`.
    /* v8 ignore start */
    if (repaired === params) {
      sanitized.push(tool);
      continue;
    }
    /* v8 ignore stop */
    anyChange = true;
    sanitized.push({ ...tool, function: { ...fn, parameters: repaired } });
  }
  // `anyChange` always flips because deep-clone is always a fresh object.
  // Kept for upstream parity.
  /* v8 ignore start */
  if (!anyChange) {
    return tools;
  }
  /* v8 ignore stop */
  return sanitized;
}

// ── Gemini thinking-config helpers ────────────────────────────────────

/**
 * Translate Hermes / OpenRouter-style reasoning config to Gemini
 * `thinkingConfig`. Mirrors upstream `_build_gemini_thinking_config`.
 */
export function buildGeminiThinkingConfig(
  model: string,
  reasoningConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!reasoningConfig || !isRecord(reasoningConfig)) {
    return null;
  }

  let normalizedModel = (model ?? "").trim().toLowerCase();
  if (normalizedModel.startsWith("google/")) {
    normalizedModel = normalizedModel.slice("google/".length);
  }

  // `thinking_config` is Gemini-only on this provider. Gemma rejects it
  // with HTTP 400 even on `{includeThoughts: False}`. Omit entirely on
  // non-Gemini models (upstream #17426).
  if (!normalizedModel.startsWith("gemini")) {
    return null;
  }

  if (reasoningConfig.enabled === false) {
    return { includeThoughts: false };
  }

  const rawEffort = reasoningConfig.effort;
  let effort =
    typeof rawEffort === "string"
      ? rawEffort.trim().toLowerCase()
      : (rawEffort ?? "medium");
  if (typeof effort !== "string") {
    effort = "medium";
  }
  if (effort === "none") {
    return { includeThoughts: false };
  }

  const thinkingConfig: Record<string, unknown> = { includeThoughts: true };

  // Gemini 2.5 accepts thinkingBudget; don't guess from coarse efforts.
  if (normalizedModel.startsWith("gemini-2.5-")) {
    return thinkingConfig;
  }

  const validEfforts = new Set(["minimal", "low", "medium", "high", "xhigh"]);
  if (!validEfforts.has(effort as string)) {
    effort = "medium";
  }

  // Gemini 3 Flash: low / medium / high; Gemini 3 Pro: low / high.
  // The "gemini-3.1" prefix is logically subsumed by "gemini-3"; kept for
  // upstream parity with the explicit Python tuple
  // `startswith(("gemini-3", "gemini-3.1"))`.
  if (_isGemini3Family(normalizedModel)) {
    if (normalizedModel.includes("flash")) {
      if (effort === "minimal" || effort === "low") {
        thinkingConfig.thinkingLevel = "low";
      } else if (effort === "high" || effort === "xhigh") {
        thinkingConfig.thinkingLevel = "high";
      } else {
        thinkingConfig.thinkingLevel = "medium";
      }
    } else if (normalizedModel.includes("pro")) {
      thinkingConfig.thinkingLevel =
        effort === "high" || effort === "xhigh" ? "high" : "low";
    }
  }

  return thinkingConfig;
}

/** Convert Gemini thinking config keys to OpenAI-compat field names. */
export function snakeCaseGeminiThinkingConfig(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!config || !isRecord(config) || Object.keys(config).length === 0) {
    return null;
  }
  const translated: Record<string, unknown> = {};
  if (typeof config.includeThoughts === "boolean") {
    translated.include_thoughts = config.includeThoughts;
  }
  const level = config.thinkingLevel;
  if (typeof level === "string" && level.trim()) {
    translated.thinking_level = level.trim().toLowerCase();
  }
  const budget = config.thinkingBudget;
  if (typeof budget === "number" && Number.isFinite(budget)) {
    translated.thinking_budget = Math.trunc(budget);
  }
  return Object.keys(translated).length > 0 ? translated : null;
}

/** True for the OpenAI-compat base URL ending in `/openai`. */
export function isGeminiOpenaiCompatBaseUrl(baseUrl: unknown): boolean {
  const normalized = String(baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  if (!normalized.includes("generativelanguage.googleapis.com")) {
    return false;
  }
  return normalized.endsWith("/openai");
}

// ── Chat-Completions build-kwargs params ──────────────────────────────

/** Max-tokens-param function — returns `{max_tokens}` or `{max_completion_tokens}`. */
export type MaxTokensParamFn = (n: number) => Record<string, unknown>;

/** Build-kwargs parameter record (legacy + profile paths). */
export interface ChatCompletionsBuildKwargsParams {
  timeout?: number | null;
  max_tokens?: number | null;
  ephemeral_max_output_tokens?: number | null;
  max_tokens_param_fn?: MaxTokensParamFn;
  reasoning_config?: Record<string, unknown> | null;
  request_overrides?: Record<string, unknown> | null;
  session_id?: string | null;
  model_lower?: string;
  provider_profile?: ChatCompletionsProvider | null;

  // Legacy flag-path inputs
  is_openrouter?: boolean;
  is_nous?: boolean;
  is_qwen_portal?: boolean;
  is_github_models?: boolean;
  is_nvidia_nim?: boolean;
  is_kimi?: boolean;
  is_tokenhub?: boolean;
  is_lmstudio?: boolean;
  is_custom_provider?: boolean;
  ollama_num_ctx?: number | null;

  provider_preferences?: Record<string, unknown> | null;
  provider_name?: string;
  base_url?: string | null;

  qwen_prepare_fn?: (messages: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  qwen_prepare_inplace_fn?: (messages: Array<Record<string, unknown>>) => void;
  qwen_session_metadata?: Record<string, unknown> | null;

  fixed_temperature?: unknown;
  omit_temperature?: boolean;
  temperature?: number | null;

  supports_reasoning?: boolean;
  github_reasoning_extra?: Record<string, unknown> | null;
  lmstudio_reasoning_options?: readonly string[] | null;

  anthropic_max_output?: number | null;
  openrouter_min_coding_score?: number | string | null;
  extra_body_additions?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * Provider profile contract the transport reads. Structurally compatible
 * with `ProviderProfile` from `@hermests/providers` plus the
 * `buildExtraBody` / `buildApiKwargsExtras` hooks the upstream uses.
 *
 * We declare an explicit interface here so consumers can pass any
 * profile-shaped object — sub-task #5o reconciles with the canonical
 * `ProviderProfile` class.
 */
export interface ChatCompletionsProvider {
  readonly name: string;
  readonly fixedTemperature: number | symbol | null;
  readonly defaultMaxTokens: number | null;
  prepareMessages(
    messages: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>>;
  buildExtraBody(context: {
    session_id?: string | null;
    provider_preferences?: Record<string, unknown> | null;
    model?: string;
    base_url?: string | null;
    reasoning_config?: Record<string, unknown> | null;
    openrouter_min_coding_score?: number | string | null;
    [key: string]: unknown;
  }): Record<string, unknown>;
  buildApiKwargsExtras(context: {
    reasoning_config?: Record<string, unknown> | null;
    supports_reasoning?: boolean;
    qwen_session_metadata?: Record<string, unknown> | null;
    model?: string;
    ollama_num_ctx?: number | null;
    session_id?: string | null;
    [key: string]: unknown;
  }): [Record<string, unknown>, Record<string, unknown>];
}

// ── Transport class ───────────────────────────────────────────────────

export class ChatCompletionsTransport extends ProviderTransport {
  override get apiMode(): string {
    return "chat_completions";
  }

  /**
   * Messages are already in OpenAI format — strip internal fields that
   * strict chat-completions providers reject with HTTP 400 / 422.
   *
   * Strips:
   * - Codex Responses API fields: `codex_reasoning_items` /
   *   `codex_message_items` on the message, `call_id` /
   *   `response_item_id` on `tool_calls` entries.
   * - `tool_name` on tool-result messages — written by
   *   `makeToolResultMessage()` for the SQLite FTS index, but not part
   *   of the Chat Completions schema. Strict providers (Fireworks,
   *   Moonshot/Kimi) reject any payload containing it.
   *
   * The original list is never mutated — copy-on-demand only when at
   * least one offending field is present.
   */
  override convertMessages(
    messages: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    let needsSanitize = false;
    outer: for (const msg of messages) {
      if (!isRecord(msg)) {
        continue;
      }
      if (
        "codex_reasoning_items" in msg ||
        "codex_message_items" in msg ||
        "tool_name" in msg
      ) {
        needsSanitize = true;
        break;
      }
      const toolCalls = msg.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (isRecord(tc) && ("call_id" in tc || "response_item_id" in tc)) {
            needsSanitize = true;
            break outer;
          }
        }
      }
    }

    if (!needsSanitize) {
      return messages;
    }

    const sanitized = structuredClone(messages);
    for (const msg of sanitized) {
      if (!isRecord(msg)) {
        continue;
      }
      delete msg.codex_reasoning_items;
      delete msg.codex_message_items;
      delete msg.tool_name;
      const toolCalls = msg.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (isRecord(tc)) {
            delete tc.call_id;
            delete tc.response_item_id;
          }
        }
      }
    }
    return sanitized;
  }

  override convertTools(
    tools: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return tools;
  }

  override buildKwargs(
    model: string,
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>> | null,
    params: ChatCompletionsBuildKwargsParams = {},
  ): Record<string, unknown> {
    // Codex sanitization first.
    const sanitized = this.convertMessages(messages);

    const profile = params.provider_profile;
    if (profile) {
      return this._buildKwargsFromProfile(profile, model, sanitized, tools, params);
    }
    return this._buildKwargsLegacy(model, sanitized, tools, params);
  }

  /** Legacy fallback for unregistered / unknown providers. */
  private _buildKwargsLegacy(
    model: string,
    sanitizedIn: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>> | null,
    params: ChatCompletionsBuildKwargsParams,
  ): Record<string, unknown> {
    let sanitized = sanitizedIn;
    const modelLower = params.model_lower ?? (model ?? "").toLowerCase();

    const first = sanitized[0];
    if (
      first &&
      isRecord(first) &&
      first.role === "system" &&
      DEVELOPER_ROLE_MODELS.some((p) => modelLower.includes(p))
    ) {
      sanitized = sanitized.slice();
      sanitized[0] = { ...first, role: "developer" };
    }

    const apiKwargs: Record<string, unknown> = {
      model,
      messages: sanitized,
    };

    if (params.timeout !== undefined && params.timeout !== null) {
      apiKwargs.timeout = params.timeout;
    }

    // Tools — apply Moonshot/Kimi sanitization regardless of path.
    let outboundTools = tools;
    if (outboundTools && outboundTools.length > 0) {
      if (isMoonshotModel(model)) {
        outboundTools = sanitizeMoonshotTools(outboundTools);
      }
      apiKwargs.tools = outboundTools;
    }

    // max_tokens resolution — priority: ephemeral > user > anthropic-out.
    const maxTokensFn = params.max_tokens_param_fn;
    const ephemeral = params.ephemeral_max_output_tokens;
    const userMax = params.max_tokens;
    const anthropicMaxOut = params.anthropic_max_output;

    if (
      ephemeral !== null &&
      ephemeral !== undefined &&
      maxTokensFn !== undefined
    ) {
      Object.assign(apiKwargs, maxTokensFn(ephemeral));
    } else if (userMax !== null && userMax !== undefined && maxTokensFn !== undefined) {
      Object.assign(apiKwargs, maxTokensFn(userMax));
    } else if (anthropicMaxOut !== null && anthropicMaxOut !== undefined) {
      apiKwargs.max_tokens = anthropicMaxOut;
    }

    const isKimi = params.is_kimi ?? false;
    const isTokenhub = params.is_tokenhub ?? false;
    const reasoningConfig = params.reasoning_config;

    if (isKimi) {
      _applyKimiTopLevelEffort(apiKwargs, reasoningConfig);
    }
    if (isTokenhub) {
      _applyTokenhubTopLevelEffort(apiKwargs, reasoningConfig);
    }
    // The `?? false` nullish defaults are defensive — both flags are
    // always boolean when present, never undefined in production calls.
    /* v8 ignore next */
    if ((params.is_lmstudio ?? false) && (params.supports_reasoning ?? false)) {
      const effort = resolveLmstudioEffort(
        reasoningConfig,
        params.lmstudio_reasoning_options ?? null,
      );
      if (effort !== null) {
        apiKwargs.reasoning_effort = effort;
      }
    }

    // extra_body assembly
    const extraBody: Record<string, unknown> = {};

    const isOpenrouter = params.is_openrouter ?? false;
    const isGithubModels = params.is_github_models ?? false;
    const providerName = String(params.provider_name ?? "").trim().toLowerCase();
    const baseUrl = params.base_url;

    const providerPrefs = params.provider_preferences;
    if (providerPrefs && isOpenrouter) {
      extraBody.provider = providerPrefs;
    }

    // OpenRouter Pareto Code router — model-gated.
    if (isOpenrouter && model === "openrouter/pareto-code") {
      const score = params.openrouter_min_coding_score;
      if (score !== null && score !== undefined && score !== "") {
        let scoreF: number | null = null;
        if (typeof score === "number" && Number.isFinite(score)) {
          scoreF = score;
        } else if (typeof score === "string") {
          const parsed = Number(score);
          if (Number.isFinite(parsed)) {
            scoreF = parsed;
          }
        }
        if (scoreF !== null && scoreF >= 0.0 && scoreF <= 1.0) {
          extraBody.plugins = [{ id: "pareto-router", min_coding_score: scoreF }];
        }
      }
    }

    if (isKimi) {
      let kimiEnabled = true;
      if (reasoningConfig && isRecord(reasoningConfig)) {
        if (reasoningConfig.enabled === false) {
          kimiEnabled = false;
        }
      }
      extraBody.thinking = { type: kimiEnabled ? "enabled" : "disabled" };
    }

    // Reasoning. LM Studio is handled above via top-level reasoning_effort.
    if ((params.supports_reasoning ?? false) && !(params.is_lmstudio ?? false)) {
      if (isGithubModels) {
        const ghReasoning = params.github_reasoning_extra;
        if (ghReasoning !== null && ghReasoning !== undefined) {
          extraBody.reasoning = ghReasoning;
        }
      } else {
        extraBody.reasoning = { enabled: true, effort: "medium" };
      }
    }

    if (providerName === "gemini") {
      const rawThinking = buildGeminiThinkingConfig(model, reasoningConfig);
      if (isGeminiOpenaiCompatBaseUrl(baseUrl)) {
        const snake = snakeCaseGeminiThinkingConfig(rawThinking);
        if (snake) {
          // In single-call practice `extraBody` contains nothing under
          // either key by the time we reach the Gemini section
          // (additions / overrides are merged after). We preserve the
          // defensive merge to match upstream's `.get("extra_body", {})`
          // pattern — the truthy ternary branches stay unreachable.
          const openaiCompatExtra: Record<string, unknown> = _safeNestedExtra(
            extraBody.extra_body,
          );
          const googleExtra: Record<string, unknown> = _safeNestedExtra(
            openaiCompatExtra.google,
          );
          googleExtra.thinking_config = snake;
          openaiCompatExtra.google = googleExtra;
          extraBody.extra_body = openaiCompatExtra;
        }
      } else if (rawThinking) {
        extraBody.thinking_config = rawThinking;
      }
    } else if (providerName === "google-gemini-cli") {
      const thinking = buildGeminiThinkingConfig(model, reasoningConfig);
      if (thinking) {
        extraBody.thinking_config = thinking;
      }
    }

    const additions = params.extra_body_additions;
    if (additions) {
      Object.assign(extraBody, additions);
    }

    if (Object.keys(extraBody).length > 0) {
      apiKwargs.extra_body = extraBody;
    }

    const overrides = params.request_overrides;
    if (overrides) {
      Object.assign(apiKwargs, overrides);
    }

    return apiKwargs;
  }

  /** Build API kwargs from a `ProviderProfile`. Single path, no legacy flags. */
  private _buildKwargsFromProfile(
    profile: ChatCompletionsProvider,
    model: string,
    sanitizedIn: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>> | null,
    params: ChatCompletionsBuildKwargsParams,
  ): Record<string, unknown> {
    let sanitized = profile.prepareMessages(sanitizedIn);

    const modelLower = (model ?? "").toLowerCase();
    const first = sanitized[0];
    if (
      first &&
      isRecord(first) &&
      first.role === "system" &&
      DEVELOPER_ROLE_MODELS.some((p) => modelLower.includes(p))
    ) {
      sanitized = sanitized.slice();
      sanitized[0] = { ...first, role: "developer" };
    }

    const apiKwargs: Record<string, unknown> = {
      model,
      messages: sanitized,
    };

    // Temperature
    if (profile.fixedTemperature === OMIT_TEMPERATURE) {
      // omit entirely
    } else if (profile.fixedTemperature !== null && profile.fixedTemperature !== undefined) {
      apiKwargs.temperature = profile.fixedTemperature;
    } else {
      const t = params.temperature;
      if (t !== null && t !== undefined) {
        apiKwargs.temperature = t;
      }
    }

    if (params.timeout !== undefined && params.timeout !== null) {
      apiKwargs.timeout = params.timeout;
    }

    let outboundTools = tools;
    if (outboundTools && outboundTools.length > 0) {
      if (isMoonshotModel(model)) {
        outboundTools = sanitizeMoonshotTools(outboundTools);
      }
      apiKwargs.tools = outboundTools;
    }

    const maxTokensFn = params.max_tokens_param_fn;
    const ephemeral = params.ephemeral_max_output_tokens;
    const userMax = params.max_tokens;
    const anthropicMax = params.anthropic_max_output;

    if (
      ephemeral !== null &&
      ephemeral !== undefined &&
      maxTokensFn !== undefined
    ) {
      Object.assign(apiKwargs, maxTokensFn(ephemeral));
    } else if (userMax !== null && userMax !== undefined && maxTokensFn !== undefined) {
      Object.assign(apiKwargs, maxTokensFn(userMax));
    } else if (
      profile.defaultMaxTokens !== null &&
      profile.defaultMaxTokens !== undefined &&
      profile.defaultMaxTokens > 0 &&
      maxTokensFn !== undefined
    ) {
      Object.assign(apiKwargs, maxTokensFn(profile.defaultMaxTokens));
    } else if (anthropicMax !== null && anthropicMax !== undefined) {
      apiKwargs.max_tokens = anthropicMax;
    }

    const reasoningConfig = params.reasoning_config ?? null;
    const [extraBodyFromProfile, topLevelFromProfile] = profile.buildApiKwargsExtras({
      reasoning_config: reasoningConfig,
      supports_reasoning: params.supports_reasoning ?? false,
      qwen_session_metadata: params.qwen_session_metadata ?? null,
      model,
      ollama_num_ctx: params.ollama_num_ctx ?? null,
      session_id: params.session_id ?? null,
    });
    Object.assign(apiKwargs, topLevelFromProfile);

    const extraBody: Record<string, unknown> = {};
    const profileBody = profile.buildExtraBody({
      session_id: params.session_id ?? null,
      provider_preferences: params.provider_preferences ?? null,
      model,
      base_url: params.base_url ?? null,
      reasoning_config: reasoningConfig,
      openrouter_min_coding_score: params.openrouter_min_coding_score ?? null,
    });
    if (profileBody && Object.keys(profileBody).length > 0) {
      Object.assign(extraBody, profileBody);
    }
    if (extraBodyFromProfile && Object.keys(extraBodyFromProfile).length > 0) {
      Object.assign(extraBody, extraBodyFromProfile);
    }

    const additions = params.extra_body_additions;
    if (additions) {
      Object.assign(extraBody, additions);
    }

    const overrides = params.request_overrides;
    if (overrides) {
      for (const [k, v] of Object.entries(overrides)) {
        if (k === "extra_body" && isRecord(v)) {
          Object.assign(extraBody, v);
        } else {
          apiKwargs[k] = v;
        }
      }
    }

    if (Object.keys(extraBody).length > 0) {
      apiKwargs.extra_body = extraBody;
    }

    return apiKwargs;
  }

  override normalizeResponse(response: unknown): NormalizedResponse {
    const r = response as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string | null;
            function?: { name: string; arguments: string };
            extra_content?: unknown;
            model_extra?: Record<string, unknown> | null;
          }> | null;
          reasoning?: string | null;
          reasoning_content?: unknown;
          reasoning_details?: unknown;
          model_extra?: Record<string, unknown> | null;
        };
        finish_reason?: string | null;
      }>;
      usage?: {
        prompt_tokens?: number | null;
        completion_tokens?: number | null;
        total_tokens?: number | null;
      } | null;
    };
    const choice = r.choices?.[0];
    if (choice === undefined) {
      throw new Error("ChatCompletionsTransport.normalizeResponse: missing choice[0]");
    }
    const msg = choice.message;
    if (msg === undefined) {
      throw new Error("ChatCompletionsTransport.normalizeResponse: missing message");
    }
    const finishReason = choice.finish_reason ?? "stop";

    let toolCalls: ToolCall[] | null = null;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      toolCalls = [];
      for (const tc of msg.tool_calls) {
        const tcProviderData: Record<string, unknown> = {};
        let extra: unknown = tc.extra_content ?? null;
        if (extra === null && tc.model_extra) {
          extra = (tc.model_extra as { extra_content?: unknown }).extra_content ?? null;
        }
        if (extra !== null && extra !== undefined) {
          if (isRecord(extra) && typeof (extra as { model_dump?: unknown }).model_dump === "function") {
            try {
              extra = (extra as { model_dump: () => unknown }).model_dump();
            } catch {
              // fall through with original value
            }
          }
          tcProviderData.extra_content = extra;
        }
        if (!tc.function) {
          throw new Error(
            "ChatCompletionsTransport.normalizeResponse: tool_call missing function",
          );
        }
        toolCalls.push(
          new ToolCall({
            id: tc.id ?? null,
            name: tc.function.name,
            arguments: tc.function.arguments,
            providerData: Object.keys(tcProviderData).length > 0 ? tcProviderData : null,
          }),
        );
      }
    }

    let usage: Usage | null = null;
    if (r.usage) {
      const u = r.usage;
      usage = new Usage({
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        total_tokens: u.total_tokens ?? 0,
      });
    }

    const reasoning = msg.reasoning ?? null;
    let reasoningContent: unknown = msg.reasoning_content ?? null;
    if (reasoningContent === null && msg.model_extra) {
      const me = msg.model_extra;
      if (isRecord(me) && "reasoning_content" in me) {
        reasoningContent = me.reasoning_content;
      }
    }

    const providerData: Record<string, unknown> = {};
    if (reasoningContent !== null && reasoningContent !== undefined) {
      providerData.reasoning_content = reasoningContent;
    }
    const rd = msg.reasoning_details;
    if (rd !== null && rd !== undefined && rd !== "" && !(Array.isArray(rd) && rd.length === 0)) {
      providerData.reasoning_details = rd;
    }

    return new NormalizedResponse({
      content: msg.content ?? null,
      tool_calls: toolCalls,
      finish_reason: finishReason,
      reasoning,
      usage,
      providerData: Object.keys(providerData).length > 0 ? providerData : null,
    });
  }

  override validateResponse(response: unknown): boolean {
    if (response === null || response === undefined) {
      return false;
    }
    if (!isRecord(response)) {
      return false;
    }
    const choices = (response as { choices?: unknown }).choices;
    if (choices === null || choices === undefined) {
      return false;
    }
    if (!Array.isArray(choices) || choices.length === 0) {
      return false;
    }
    return true;
  }

  override extractCacheStats(response: unknown): CacheStats | null {
    if (!isRecord(response)) {
      return null;
    }
    const usage = (response as { usage?: unknown }).usage;
    if (usage === null || usage === undefined || !isRecord(usage)) {
      return null;
    }
    const details = (usage as { prompt_tokens_details?: unknown }).prompt_tokens_details;
    if (details === null || details === undefined || !isRecord(details)) {
      return null;
    }
    const cached = (details as { cached_tokens?: number }).cached_tokens ?? 0;
    const written = (details as { cache_write_tokens?: number }).cache_write_tokens ?? 0;
    if (cached || written) {
      return { cached_tokens: cached, creation_tokens: written };
    }
    return null;
  }
}

// ── Per-provider extracted helpers ────────────────────────────────────

function _applyKimiTopLevelEffort(
  apiKwargs: Record<string, unknown>,
  reasoningConfig: Record<string, unknown> | null | undefined,
): void {
  const off =
    !!reasoningConfig &&
    isRecord(reasoningConfig) &&
    reasoningConfig.enabled === false;
  if (off) {
    return;
  }
  let effort = "medium";
  if (reasoningConfig && isRecord(reasoningConfig)) {
    const raw =
      typeof reasoningConfig.effort === "string"
        ? reasoningConfig.effort.trim().toLowerCase()
        : "";
    if (raw === "low" || raw === "medium" || raw === "high") {
      effort = raw;
    }
  }
  apiKwargs.reasoning_effort = effort;
}

function _applyTokenhubTopLevelEffort(
  apiKwargs: Record<string, unknown>,
  reasoningConfig: Record<string, unknown> | null | undefined,
): void {
  const off =
    !!reasoningConfig &&
    isRecord(reasoningConfig) &&
    reasoningConfig.enabled === false;
  if (off) {
    return;
  }
  let effort = "high";
  if (reasoningConfig && isRecord(reasoningConfig)) {
    const raw =
      typeof reasoningConfig.effort === "string"
        ? reasoningConfig.effort.trim().toLowerCase()
        : "";
    if (raw === "low" || raw === "medium" || raw === "high") {
      effort = raw;
    }
  }
  apiKwargs.reasoning_effort = effort;
}

/** Register the singleton chat-completions transport (no DI required). */
export function registerChatCompletionsTransport(): void {
  registerTransport("chat_completions", () => new ChatCompletionsTransport());
}

// Auto-register on import — matches upstream module-bottom `register_transport(...)`.
// Unlike the adapter-bound transports (Anthropic/Bedrock/Codex), this one needs
// no external dependency, so auto-registration is safe.
registerChatCompletionsTransport();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Defensive shallow-clone helper used by the Gemini section. Returns a
 * fresh copy when the source is already a record; otherwise returns an
 * empty record. The truthy branch is unreachable in single-call practice
 * (see callsite comment) — kept for upstream parity.
 */
function _safeNestedExtra(value: unknown): Record<string, unknown> {
  /* v8 ignore start */
  if (isRecord(value)) {
    return { ...value };
  }
  /* v8 ignore stop */
  return {};
}

/**
 * True for any "gemini-3" / "gemini-3.1" family model. Upstream lists
 * both prefixes explicitly; in practice "gemini-3" already covers
 * "gemini-3.1" so the second prefix check is unreachable. Inlined back
 * at the call site as a single `startsWith("gemini-3")` because the
 * tuple form has no observable effect.
 */
function _isGemini3Family(normalizedModel: string): boolean {
  return normalizedModel.startsWith("gemini-3");
}
