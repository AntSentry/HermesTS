/**
 * OpenAI Responses API (Codex) transport.
 *
 * Faithful port of upstream `agent/transports/codex.py`.
 *
 * Wraps the existing functions extracted into the Codex Responses
 * adapter (upstream `agent/codex_responses_adapter.py`, TS sub-task #5i).
 * This transport owns format conversion and normalisation — NOT client
 * lifecycle, streaming, or the `runCodexStream()` call path.
 *
 * ── Faithful divergences ──────────────────────────────────────────────
 * 1. DI for the adapter, same pattern as Anthropic / Bedrock.
 * 2. Upstream imports `DEFAULT_AGENT_IDENTITY` from `run_agent` (top-level
 *    cli module). #14 (cli) is downstream of #5; we accept the default
 *    instructions string via `params.default_instructions` instead, with
 *    a sensible fallback of `"You are a helpful assistant."` matching the
 *    spirit of the upstream constant. Sub-task #5o wires the real
 *    constant in.
 * 3. Upstream imports `grok_supports_reasoning_effort` from
 *    `agent.model_metadata` (sub-task #5c). We accept the predicate via
 *    `params.grok_supports_reasoning_effort` (a function) so this
 *    sub-task ships without a runtime dep on #5c.
 */

import { ProviderTransport } from "./base.js";
import { registerTransport } from "./registry.js";
import { NormalizedResponse, ToolCall } from "./types.js";

const CODEX_FINISH_REASON_MAP: Readonly<Record<string, string>> = Object.freeze({
  completed: "stop",
  incomplete: "length",
  failed: "stop",
  cancelled: "stop",
});

/** Default `instructions` when neither caller nor system message supplies one. */
export const DEFAULT_CODEX_INSTRUCTIONS = "You are a helpful assistant.";

/** Output of `CodexAdapter.normalizeCodexResponse()` — first element is null if no message. */
export interface CodexNormalizedMessage {
  content: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    id?: string | null;
    function?: { name: string; arguments: string };
    name?: string;
    arguments?: string;
    call_id?: string | null;
    response_item_id?: string | null;
  }> | null;
  codex_reasoning_items?: unknown;
  codex_message_items?: unknown;
  reasoning_details?: unknown;
}

/** Adapter contract — sub-task #5i provides an implementation. */
export interface CodexAdapter {
  chatMessagesToResponsesInput(
    messages: Array<Record<string, unknown>>,
    options: { is_xai_responses: boolean },
  ): unknown;
  responsesTools(tools: Array<Record<string, unknown>> | null): unknown[];
  normalizeCodexResponse(
    response: unknown,
  ): [CodexNormalizedMessage | null, string | null];
  preflightCodexApiKwargs(
    apiKwargs: Record<string, unknown>,
    options: { allow_stream: boolean },
  ): Record<string, unknown>;
}

/** Build-kwargs parameter record — every key matches upstream `**params`. */
export interface CodexBuildKwargsParams {
  instructions?: string;
  /** Default agent identity string — substitutes upstream `DEFAULT_AGENT_IDENTITY`. */
  default_instructions?: string;
  reasoning_config?: Record<string, unknown> | null;
  session_id?: string | null;
  max_tokens?: number | null;
  request_overrides?: Record<string, unknown> | null;
  provider?: string | null;
  base_url?: string | null;
  base_url_hostname?: string | null;
  is_github_responses?: boolean;
  is_codex_backend?: boolean;
  is_xai_responses?: boolean;
  github_reasoning_extra?: Record<string, unknown> | null;
  /**
   * Predicate substituting upstream `grok_supports_reasoning_effort()`.
   * Returns true when xAI accepts `reasoning.effort` on the model id.
   */
  grok_supports_reasoning_effort?: (model: string) => boolean;
  [key: string]: unknown;
}

/** Transport for `apiMode = "codex_responses"`. */
export class ResponsesApiTransport extends ProviderTransport {
  readonly adapter: CodexAdapter;

  constructor(adapter: CodexAdapter) {
    super();
    this.adapter = adapter;
  }

  override get apiMode(): string {
    return "codex_responses";
  }

  override convertMessages(
    messages: Array<Record<string, unknown>>,
    options: { is_xai_responses?: boolean } = {},
  ): unknown {
    return this.adapter.chatMessagesToResponsesInput(messages, {
      is_xai_responses: Boolean(options.is_xai_responses),
    });
  }

  override convertTools(tools: Array<Record<string, unknown>>): unknown {
    return this.adapter.responsesTools(tools);
  }

  override buildKwargs(
    model: string,
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>> | null,
    params: CodexBuildKwargsParams = {},
  ): Record<string, unknown> {
    let instructions = params.instructions ?? "";
    let payloadMessages = messages;
    if (!instructions) {
      const first = messages[0];
      if (first && first.role === "system") {
        instructions = String(first.content ?? "").trim();
        payloadMessages = messages.slice(1);
      }
    }
    if (!instructions) {
      instructions = params.default_instructions ?? DEFAULT_CODEX_INSTRUCTIONS;
    }

    const isGithubResponses = params.is_github_responses ?? false;
    const isCodexBackend = params.is_codex_backend ?? false;
    const isXaiResponses = params.is_xai_responses ?? false;

    // Resolve reasoning effort
    let reasoningEffort = "medium";
    let reasoningEnabled = true;
    const reasoningConfig = params.reasoning_config;
    if (reasoningConfig !== null && reasoningConfig !== undefined && isRecord(reasoningConfig)) {
      if (reasoningConfig.enabled === false) {
        reasoningEnabled = false;
      } else if (reasoningConfig.effort) {
        reasoningEffort = String(reasoningConfig.effort);
      }
    }

    // "minimal" → "low" clamp (upstream `_effort_clamp`).
    if (reasoningEffort === "minimal") {
      reasoningEffort = "low";
    }

    const responseTools = this.adapter.responsesTools(tools);
    const kwargs: Record<string, unknown> = {
      model,
      instructions,
      input: this.adapter.chatMessagesToResponsesInput(payloadMessages, {
        is_xai_responses: isXaiResponses,
      }),
      tools: responseTools,
      store: false,
    };

    if (Array.isArray(responseTools) && responseTools.length > 0) {
      kwargs.tool_choice = "auto";
      kwargs.parallel_tool_calls = true;
    }

    const sessionId = params.session_id;

    // xAI Responses takes prompt_cache_key in extra_body (set further
    // down); GitHub Models opts out of cache-key routing entirely.
    if (!isGithubResponses && !isXaiResponses && sessionId) {
      kwargs.prompt_cache_key = sessionId;
    }

    if (reasoningEnabled && isXaiResponses) {
      // Ask xAI to echo back encrypted reasoning items so we can replay
      // them on subsequent turns for cross-turn coherence.
      kwargs.include = ["reasoning.encrypted_content"];
      // xAI rejects `reasoning.effort` on grok-4 / grok-4-fast / grok-3
      // / grok-code-fast / grok-4.20-0309-* with HTTP 400 even though
      // those models reason natively. Only send the effort dial when
      // the target model is on the allowlist; otherwise send no
      // `reasoning` key at all and let the model reason on its own.
      if (params.grok_supports_reasoning_effort?.(model)) {
        kwargs.reasoning = { effort: reasoningEffort };
      }
    } else if (reasoningEnabled) {
      if (isGithubResponses) {
        const githubReasoning = params.github_reasoning_extra;
        if (githubReasoning !== null && githubReasoning !== undefined) {
          kwargs.reasoning = githubReasoning;
        }
      } else {
        kwargs.reasoning = { effort: reasoningEffort, summary: "auto" };
        kwargs.include = ["reasoning.encrypted_content"];
      }
    } else if (!isGithubResponses && !isXaiResponses) {
      kwargs.include = [];
    }

    const requestOverrides = params.request_overrides;
    if (requestOverrides) {
      for (const [k, v] of Object.entries(requestOverrides)) {
        kwargs[k] = v;
      }
    }

    if (isCodexBackend) {
      const promptCacheKey = kwargs.prompt_cache_key;
      const cacheScopeId = String(promptCacheKey ?? sessionId ?? "").trim();
      if (cacheScopeId) {
        const existingExtraHeaders = kwargs.extra_headers;
        const mergedExtraHeaders: Record<string, string> = {};
        if (isRecord(existingExtraHeaders)) {
          for (const [key, value] of Object.entries(existingExtraHeaders)) {
            if (key && value !== null && value !== undefined) {
              mergedExtraHeaders[String(key)] = String(value);
            }
          }
        }
        mergedExtraHeaders.session_id = cacheScopeId;
        mergedExtraHeaders["x-client-request-id"] = cacheScopeId;
        kwargs.extra_headers = mergedExtraHeaders;
      }
    }

    const maxTokens = params.max_tokens;
    if (maxTokens !== null && maxTokens !== undefined && !isCodexBackend) {
      kwargs.max_output_tokens = maxTokens;
    }

    if (isXaiResponses && sessionId) {
      const existingExtraHeaders = kwargs.extra_headers;
      const mergedExtraHeaders: Record<string, string> = {};
      if (isRecord(existingExtraHeaders)) {
        for (const [key, value] of Object.entries(existingExtraHeaders)) {
          if (key && value !== null && value !== undefined) {
            mergedExtraHeaders[String(key)] = String(value);
          }
        }
      }
      mergedExtraHeaders["x-grok-conv-id"] = sessionId;
      kwargs.extra_headers = mergedExtraHeaders;

      // xAI Responses cache-routing — body-level field per
      // https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
      // Sent via extra_body (not the typed kwarg) so it survives openai
      // SDK builds whose Responses.stream() signature has dropped the
      // field.
      const existingExtraBody = kwargs.extra_body;
      const mergedExtraBody: Record<string, unknown> = {};
      if (isRecord(existingExtraBody)) {
        for (const [k, v] of Object.entries(existingExtraBody)) {
          mergedExtraBody[k] = v;
        }
      }
      if (!("prompt_cache_key" in mergedExtraBody)) {
        mergedExtraBody.prompt_cache_key = sessionId;
      }
      kwargs.extra_body = mergedExtraBody;
    }

    return kwargs;
  }

  override normalizeResponse(response: unknown): NormalizedResponse {
    const [msg, finishReason] = this.adapter.normalizeCodexResponse(response);

    let toolCalls: ToolCall[] | null = null;
    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      toolCalls = [];
      for (const tc of msg.tool_calls) {
        const providerData: Record<string, unknown> = {};
        if (tc.call_id) {
          providerData.call_id = tc.call_id;
        }
        if (tc.response_item_id) {
          providerData.response_item_id = tc.response_item_id;
        }
        const fn = tc.function;
        const name = fn ? fn.name : (tc.name ?? "");
        const args = fn ? fn.arguments : (tc.arguments ?? "{}");
        const id = tc.id ?? (fn ? fn.name : null) ?? null;
        toolCalls.push(
          new ToolCall({
            id,
            name,
            arguments: args,
            providerData: Object.keys(providerData).length > 0 ? providerData : null,
          }),
        );
      }
    }

    const providerData: Record<string, unknown> = {};
    if (msg?.codex_reasoning_items) {
      providerData.codex_reasoning_items = msg.codex_reasoning_items;
    }
    if (msg?.codex_message_items) {
      providerData.codex_message_items = msg.codex_message_items;
    }
    if (msg?.reasoning_details) {
      providerData.reasoning_details = msg.reasoning_details;
    }

    return new NormalizedResponse({
      content: msg ? msg.content : null,
      tool_calls: toolCalls,
      finish_reason: finishReason ?? "stop",
      reasoning: msg ? (msg.reasoning ?? null) : null,
      usage: null,
      providerData: Object.keys(providerData).length > 0 ? providerData : null,
    });
  }

  /**
   * Validate Codex Responses API response.
   *
   * Strict — `output` must be a non-empty list. `output_text` fallback is
   * the caller's responsibility (diagnostic logging for stream backfill
   * recovery).
   */
  override validateResponse(response: unknown): boolean {
    if (response === null || response === undefined) {
      return false;
    }
    if (!isRecord(response)) {
      return false;
    }
    const output = (response as { output?: unknown }).output;
    if (!Array.isArray(output) || output.length === 0) {
      return false;
    }
    return true;
  }

  /**
   * Validate and sanitize Codex API kwargs before the call. Mirrors
   * upstream `_preflight_codex_api_kwargs`.
   */
  preflightKwargs(
    apiKwargs: Record<string, unknown>,
    options: { allow_stream?: boolean } = {},
  ): Record<string, unknown> {
    return this.adapter.preflightCodexApiKwargs(apiKwargs, {
      allow_stream: options.allow_stream ?? false,
    });
  }

  override mapFinishReason(rawReason: string): string {
    return CODEX_FINISH_REASON_MAP[rawReason] ?? "stop";
  }
}

/** Register a `ResponsesApiTransport` with the transport registry. */
export function registerCodexTransport(adapter: CodexAdapter): void {
  registerTransport("codex_responses", () => new ResponsesApiTransport(adapter));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
