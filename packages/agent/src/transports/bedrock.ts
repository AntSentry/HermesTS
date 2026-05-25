/**
 * AWS Bedrock Converse API transport.
 *
 * Faithful port of upstream `agent/transports/bedrock.py`.
 *
 * Delegates to the existing Bedrock adapter functions (upstream
 * `agent/bedrock_adapter.py`, TS sub-task #5h). Bedrock uses its own AWS
 * SDK (not the OpenAI SDK), so the transport owns format conversion and
 * normalisation, while client construction and SDK calls stay on
 * AIAgent / `@hermests/agent`'s integrator layer.
 *
 * ── Faithful divergences ──────────────────────────────────────────────
 * 1. Same DI pattern as the Anthropic transport — `BedrockAdapter` is an
 *    interface this file declares; sub-task #5h supplies an
 *    implementation. `registerBedrockTransport(adapter)` wires both.
 * 2. The sentinel keys `__bedrock_converse__` and `__bedrock_region__`
 *    are preserved verbatim — downstream `chat_completion_helpers` (TS
 *    sub-task #5o) reads them by name to dispatch the call. Renaming
 *    them is a cross-sub-task change.
 * 3. Upstream's `normalize_converse_response` returns a `SimpleNamespace`
 *    with `.choices`. Our `BedrockAdapter.normalizeConverseResponse()`
 *    contract returns a `BedrockNormalizedConverse` record — the shape
 *    is identical, the access pattern is property reads either way.
 */

import { ProviderTransport } from "./base.js";
import { registerTransport } from "./registry.js";
import { NormalizedResponse, ToolCall, Usage } from "./types.js";

/** Bedrock stop-reason → OpenAI finish_reason. */
export const BEDROCK_FINISH_REASON_MAP: Readonly<Record<string, string>> = Object.freeze({
  end_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  stop_sequence: "stop",
  guardrail_intervened: "content_filter",
  content_filtered: "content_filter",
});

/**
 * Shape produced by `BedrockAdapter.normalizeConverseResponse()` — mirrors
 * the OpenAI ChatCompletion structure adapter dispatch code already
 * expects. Sub-task #5h fills these in; the transport only reads them.
 */
export interface BedrockNormalizedChoiceMessage {
  content: string | null;
  tool_calls?: Array<{
    id: string | null;
    function: { name: string; arguments: string };
  }> | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
}

export interface BedrockNormalizedChoice {
  message: BedrockNormalizedChoiceMessage;
  finish_reason: string | null;
}

export interface BedrockNormalizedUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface BedrockNormalizedConverse {
  choices: BedrockNormalizedChoice[];
  usage?: BedrockNormalizedUsage | null;
}

/**
 * Adapter contract — sub-task #5h provides an implementation.
 */
export interface BedrockAdapter {
  convertMessagesToConverse(messages: Array<Record<string, unknown>>): unknown;
  convertToolsToConverse(tools: Array<Record<string, unknown>>): unknown;
  buildConverseKwargs(args: {
    model: string;
    messages: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>> | null;
    max_tokens?: number;
    temperature?: number | null;
    guardrail_config?: Record<string, unknown> | null;
  }): Record<string, unknown>;
  normalizeConverseResponse(response: unknown): BedrockNormalizedConverse;
}

/** Build-kwargs parameter record. */
export interface BedrockBuildKwargsParams {
  max_tokens?: number;
  temperature?: number | null;
  guardrail_config?: Record<string, unknown> | null;
  region?: string;
  [key: string]: unknown;
}

/** Transport for `apiMode = "bedrock_converse"`. */
export class BedrockTransport extends ProviderTransport {
  readonly adapter: BedrockAdapter;

  constructor(adapter: BedrockAdapter) {
    super();
    this.adapter = adapter;
  }

  override get apiMode(): string {
    return "bedrock_converse";
  }

  override convertMessages(messages: Array<Record<string, unknown>>): unknown {
    return this.adapter.convertMessagesToConverse(messages);
  }

  override convertTools(tools: Array<Record<string, unknown>>): unknown {
    return this.adapter.convertToolsToConverse(tools);
  }

  override buildKwargs(
    model: string,
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>> | null,
    params: BedrockBuildKwargsParams = {},
  ): Record<string, unknown> {
    const region = params.region ?? "us-east-1";
    const kwargs = this.adapter.buildConverseKwargs({
      model,
      messages,
      tools,
      max_tokens: params.max_tokens ?? 4096,
      temperature: params.temperature ?? null,
      guardrail_config: params.guardrail_config ?? null,
    });
    // Sentinel keys for dispatch — agent pops these before the SDK call.
    kwargs.__bedrock_converse__ = true;
    kwargs.__bedrock_region__ = region;
    return kwargs;
  }

  override normalizeResponse(response: unknown): NormalizedResponse {
    // Two shapes:
    // 1. Already-normalised (has `.choices` populated) — pass through.
    // 2. Raw AWS Bedrock response dict — adapter normalises first.
    let ns: BedrockNormalizedConverse;
    if (hasNonEmptyChoices(response)) {
      ns = response;
    } else {
      ns = this.adapter.normalizeConverseResponse(response);
    }

    const choice = ns.choices[0];
    // `noUncheckedIndexedAccess` — choice can be undefined if the adapter
    // returned an empty choices array. We rely on the adapter contract
    // returning at least one choice; if it doesn't, fail loudly here.
    if (choice === undefined) {
      throw new Error(
        "BedrockTransport.normalizeResponse: adapter returned empty choices array",
      );
    }
    const msg = choice.message;
    const finishReason = choice.finish_reason ?? "stop";

    let toolCalls: ToolCall[] | null = null;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      toolCalls = msg.tool_calls.map(
        (tc) =>
          new ToolCall({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }),
      );
    }

    let usage: Usage | null = null;
    if (ns.usage) {
      const u = ns.usage;
      usage = new Usage({
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        total_tokens: u.total_tokens ?? 0,
      });
    }

    const reasoning = msg.reasoning ?? msg.reasoning_content ?? null;

    return new NormalizedResponse({
      content: msg.content,
      tool_calls: toolCalls,
      finish_reason: finishReason,
      reasoning,
      usage,
    });
  }

  /**
   * Validate Bedrock response structure.
   *
   * After `normalizeConverseResponse`, the response has OpenAI-compatible
   * `.choices` — same check as `chat_completions`. Raw boto3 dicts must
   * carry an `output` key.
   */
  override validateResponse(response: unknown): boolean {
    if (response === null || response === undefined) {
      return false;
    }
    if (isRecord(response) && !hasChoicesShape(response)) {
      return "output" in response;
    }
    if (hasChoicesShape(response)) {
      const choices = (response as { choices?: unknown[] }).choices;
      return Array.isArray(choices) && choices.length > 0;
    }
    return false;
  }

  override mapFinishReason(rawReason: string): string {
    return BEDROCK_FINISH_REASON_MAP[rawReason] ?? "stop";
  }
}

/** Register a `BedrockTransport` with the transport registry. */
export function registerBedrockTransport(adapter: BedrockAdapter): void {
  registerTransport("bedrock_converse", () => new BedrockTransport(adapter));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasChoicesShape(value: unknown): boolean {
  return isRecord(value) && "choices" in value;
}

function hasNonEmptyChoices(value: unknown): value is BedrockNormalizedConverse {
  if (!isRecord(value)) {
    return false;
  }
  const choices = (value as { choices?: unknown }).choices;
  return Array.isArray(choices) && choices.length > 0;
}
