/**
 * Minimal structural interface for an OpenAI-compatible chat-completions client.
 *
 * Upstream Python lazy-imports the `openai` SDK via a module-level `_OpenAIProxy`
 * (see `agent/auxiliary_client.py` lines 53-100). The aux client treats every
 * resolved backend as duck-typed: it constructs `OpenAI(...)` and calls
 * `client.chat.completions.create(**kwargs)` plus a few introspection fields
 * (`api_key`, `base_url`, `close()`).
 *
 * In TS we surface that contract as a structural interface here, so the aux
 * client can be ported without coupling to the `openai` npm package. The
 * `OpenAIClientCtor` shape (callable + `instanceof`) mirrors `_OpenAIProxy`.
 *
 * Real wiring happens at integrator time (#5o):
 *   - Replace `defaultOpenAIClientCtor` with a real constructor backed by the
 *     `openai` npm package, or any other compatible client.
 *   - Real Codex / Anthropic wrappers in this package re-implement the
 *     `OpenAIClient` shape directly.
 *
 * FIXME(#5o): wire to the real `openai` npm package once integrators land.
 */

/** Multimodal content part as carried on chat.completions messages. */
export type OpenAIContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: string } | string;
    }
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }
  | { type: string; [key: string]: unknown };

/** Content payload on a chat.completions message. */
export type OpenAIMessageContent = string | OpenAIContentPart[];

/** One chat-completions message. */
export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer" | string;
  content?: OpenAIMessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

/** Tool schema in OpenAI chat.completions shape. */
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Kwargs passed to `chat.completions.create()`. */
export interface OpenAIChatCreateParams {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: OpenAIToolDef[];
  tool_choice?: unknown;
  timeout?: number;
  extra_body?: Record<string, unknown>;
  stream?: boolean;
  [key: string]: unknown;
}

/** chat.completions response — only the fields aux callers read. */
export interface OpenAIChatResponse {
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: unknown[] | null;
      reasoning?: unknown;
    };
    finish_reason: string;
  }>;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

/** The chat.completions.create surface aux callers depend on. */
export interface OpenAIChatCompletions {
  create(params: OpenAIChatCreateParams): OpenAIChatResponse | Promise<OpenAIChatResponse>;
}

/** The chat namespace on an OpenAI-compatible client. */
export interface OpenAIChatNamespace {
  completions: OpenAIChatCompletions;
}

/**
 * The full OpenAI-compatible client surface aux callers depend on.
 *
 * Faithfully mirrors the duck-typed shape upstream Python touches on
 * `openai.OpenAI` instances.
 */
export interface OpenAIClient {
  chat: OpenAIChatNamespace;
  api_key: string;
  base_url: string | URL;
  close?: () => void;
  responses?: unknown;
}

/** Constructor options for an `openai.OpenAI`-shaped client. */
export interface OpenAIClientOptions {
  api_key?: string;
  base_url?: string;
  default_headers?: Record<string, string>;
  default_query?: Record<string, string>;
  timeout?: number;
  http_client?: unknown;
  [key: string]: unknown;
}

/**
 * Module-level constructor proxy. Mirrors `_OpenAIProxy` upstream — callable
 * plus an `instanceof` hook backed by the actual class once wired.
 */
export interface OpenAIClientCtor {
  (options?: OpenAIClientOptions): OpenAIClient;
  [Symbol.hasInstance](obj: unknown): boolean;
}
