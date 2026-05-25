/**
 * Anthropic Messages API transport.
 *
 * Faithful port of upstream `agent/transports/anthropic.py`.
 *
 * Wraps the existing functions in the Anthropic adapter (upstream
 * `agent/anthropic_adapter.py`, TS sub-task #5h) behind the
 * `ProviderTransport` ABC. This transport owns format conversion and
 * normalisation — NOT client lifecycle.
 *
 * ── Faithful divergences ──────────────────────────────────────────────
 * 1. Upstream calls `from agent.anthropic_adapter import …` inside each
 *    method (lazy import to avoid a cycle). In TS the equivalent is to
 *    take the adapter as a constructor argument (DI). The adapter
 *    interface is defined here so this sub-task (#5b) is free of any
 *    runtime dependency on sub-task #5h — only the type names overlap.
 *    Sub-task #5h provides an `AnthropicAdapter` implementation; sub-task
 *    #5o (integrators) wires the two together via
 *    `registerAnthropicTransport(adapter)`.
 * 2. Upstream auto-registers at module bottom (`register_transport(...)`).
 *    Because we need an adapter to construct the transport, we expose
 *    `registerAnthropicTransport(adapter)` instead — call sites that own
 *    the adapter call this once at startup.
 * 3. The adapter helper `_to_plain_data` (upstream-private) is referenced
 *    by `normalize_response` to convert thinking blocks to plain dicts
 *    for `reasoning_details`. The interface exposes it as `toPlainData`.
 */

import { ProviderTransport, type CacheStats } from "./base.js";
import { registerTransport } from "./registry.js";
import { NormalizedResponse, ToolCall } from "./types.js";

const MCP_PREFIX = "mcp_";

/**
 * Canonical Anthropic `stop_reason` → OpenAI `finish_reason` mapping.
 *
 * Lifted from the upstream module to a module-level constant; sub-task
 * #5h shares this mapping via the adapter so both code paths stay in sync.
 */
export const ANTHROPIC_STOP_REASON_MAP: Readonly<Record<string, string>> = Object.freeze({
  end_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  stop_sequence: "stop",
  refusal: "content_filter",
  model_context_window_exceeded: "length",
});

/**
 * Anthropic content block shape — narrow enough to drive the normaliser.
 * The full SDK types live in sub-task #5h; we only need the subset the
 * transport reads.
 */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

/** Anthropic Usage fields the cache-stats helper inspects. */
export interface AnthropicUsage {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Anthropic response shape — the subset the transport inspects. */
export interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: AnthropicUsage | null;
}

/**
 * Adapter contract — sub-task #5h provides an implementation. The
 * transport calls these via DI so this sub-task ships independently.
 */
export interface AnthropicAdapter {
  convertMessagesToAnthropic(
    messages: Array<Record<string, unknown>>,
    options?: { baseUrl?: string | null },
  ): unknown;
  convertToolsToAnthropic(tools: Array<Record<string, unknown>>): unknown;
  buildAnthropicKwargs(args: {
    model: string;
    messages: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>> | null;
    max_tokens?: number;
    reasoning_config?: Record<string, unknown> | null;
    tool_choice?: string | null;
    is_oauth?: boolean;
    preserve_dots?: boolean;
    context_length?: number | null;
    base_url?: string | null;
    fast_mode?: boolean;
    drop_context_1m_beta?: boolean;
  }): Record<string, unknown>;
  /**
   * Upstream `_to_plain_data` — deep-converts SDK objects (Pydantic /
   * SimpleNamespace shaped) to plain JSON-able records. Used here to
   * snapshot `thinking` blocks into `provider_data.reasoning_details`.
   */
  toPlainData(value: unknown): unknown;
}

/** Build-kwargs parameter record — mirrors upstream `**params` keys. */
export interface AnthropicBuildKwargsParams {
  max_tokens?: number;
  reasoning_config?: Record<string, unknown> | null;
  tool_choice?: string | null;
  is_oauth?: boolean;
  preserve_dots?: boolean;
  context_length?: number | null;
  base_url?: string | null;
  fast_mode?: boolean;
  drop_context_1m_beta?: boolean;
  [key: string]: unknown;
}

/** Normalise-response option record. */
export interface AnthropicNormalizeOptions {
  strip_tool_prefix?: boolean;
  [key: string]: unknown;
}

/** Transport for `apiMode = "anthropic_messages"`. */
export class AnthropicTransport extends ProviderTransport {
  readonly adapter: AnthropicAdapter;

  constructor(adapter: AnthropicAdapter) {
    super();
    this.adapter = adapter;
  }

  override get apiMode(): string {
    return "anthropic_messages";
  }

  /**
   * Convert OpenAI messages to the Anthropic `[system, messages]` tuple.
   *
   * `options.baseUrl` affects thinking-signature handling (#5h adapter).
   */
  override convertMessages(
    messages: Array<Record<string, unknown>>,
    options: { base_url?: string | null } = {},
  ): unknown {
    return this.adapter.convertMessagesToAnthropic(messages, {
      baseUrl: options.base_url ?? null,
    });
  }

  override convertTools(tools: Array<Record<string, unknown>>): unknown {
    return this.adapter.convertToolsToAnthropic(tools);
  }

  override buildKwargs(
    model: string,
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>> | null,
    params: AnthropicBuildKwargsParams = {},
  ): Record<string, unknown> {
    return this.adapter.buildAnthropicKwargs({
      model,
      messages,
      tools,
      max_tokens: params.max_tokens ?? 16384,
      reasoning_config: params.reasoning_config ?? null,
      tool_choice: params.tool_choice ?? null,
      is_oauth: params.is_oauth ?? false,
      preserve_dots: params.preserve_dots ?? false,
      context_length: params.context_length ?? null,
      base_url: params.base_url ?? null,
      fast_mode: params.fast_mode ?? false,
      drop_context_1m_beta: params.drop_context_1m_beta ?? false,
    });
  }

  override normalizeResponse(
    response: unknown,
    options: AnthropicNormalizeOptions = {},
  ): NormalizedResponse {
    const stripToolPrefix = options.strip_tool_prefix ?? false;
    const ar = response as AnthropicResponse;

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const reasoningDetails: unknown[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of ar.content ?? []) {
      if (block.type === "text") {
        textParts.push(block.text ?? "");
      } else if (block.type === "thinking") {
        reasoningParts.push(block.thinking ?? "");
        const dump = this.adapter.toPlainData(block);
        if (isRecord(dump)) {
          reasoningDetails.push(dump);
        }
      } else if (block.type === "tool_use") {
        let name = block.name ?? "";
        if (stripToolPrefix && name.startsWith(MCP_PREFIX)) {
          name = name.slice(MCP_PREFIX.length);
        }
        toolCalls.push(
          new ToolCall({
            id: block.id ?? null,
            name,
            arguments: JSON.stringify(block.input ?? {}),
          }),
        );
      }
    }

    const finishReason = ANTHROPIC_STOP_REASON_MAP[ar.stop_reason ?? ""] ?? "stop";

    const providerData: Record<string, unknown> = {};
    if (reasoningDetails.length > 0) {
      providerData.reasoning_details = reasoningDetails;
    }

    return new NormalizedResponse({
      content: textParts.length > 0 ? textParts.join("\n") : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      finish_reason: finishReason,
      reasoning: reasoningParts.length > 0 ? reasoningParts.join("\n\n") : null,
      usage: null,
      providerData: Object.keys(providerData).length > 0 ? providerData : null,
    });
  }

  /**
   * Check structural validity of an Anthropic response.
   *
   * An empty content list IS valid when `stop_reason === "end_turn"` —
   * the model's canonical "nothing more to add" signal after a tool turn
   * that already delivered the user-facing text. Treating it as invalid
   * would falsely retry a completed response.
   */
  override validateResponse(response: unknown): boolean {
    if (response === null || response === undefined) {
      return false;
    }
    const ar = response as AnthropicResponse;
    if (!Array.isArray(ar.content)) {
      return false;
    }
    if (ar.content.length === 0) {
      return ar.stop_reason === "end_turn";
    }
    return true;
  }

  override extractCacheStats(response: unknown): CacheStats | null {
    if (!isRecord(response)) {
      return null;
    }
    const usage = (response as { usage?: AnthropicUsage | null }).usage;
    if (usage === null || usage === undefined) {
      return null;
    }
    const cached = usage.cache_read_input_tokens ?? 0;
    const created = usage.cache_creation_input_tokens ?? 0;
    if (cached || created) {
      return { cached_tokens: cached, creation_tokens: created };
    }
    return null;
  }

  override mapFinishReason(rawReason: string): string {
    return ANTHROPIC_STOP_REASON_MAP[rawReason] ?? "stop";
  }
}

/**
 * Register an `AnthropicTransport` with the transport registry.
 *
 * Call once at startup with an `AnthropicAdapter` from sub-task #5h.
 * Idempotent — replaces any prior registration.
 */
export function registerAnthropicTransport(adapter: AnthropicAdapter): void {
  registerTransport("anthropic_messages", () => new AnthropicTransport(adapter));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
