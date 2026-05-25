/**
 * Shared types for @hermests/trajectory.
 *
 * Mirrors the Python upstream `List[Dict[str, str]]` trajectory representation
 * while making the keys (`from`, `value`) explicit. The `from` field is named
 * `from_` here because `from` is a TypeScript reserved word in some contexts;
 * the upstream JSONL on-disk format uses `from` so we keep the public
 * read/write surface as `from` via index-signature access.
 */

/**
 * A single conversation turn — the upstream JSONL stores `{"from": ..., "value": ...}`.
 * Extra keys are tolerated (passed through) to match the Python dict semantics.
 */
export interface Turn {
  from: string;
  value: string;
  [key: string]: unknown;
}

/**
 * A JSONL entry containing a `conversations` array. Extra keys (e.g.
 * `compression_metrics`) are tolerated, matching the upstream dict semantics.
 */
export interface Entry {
  conversations?: Turn[];
  compression_metrics?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Minimal tokenizer interface. The Python port uses HuggingFace AutoTokenizer;
 * the TS port leaves the concrete tokenizer to the caller and only requires an
 * `encode(text) -> number[]` method (the length of the array is the token count).
 *
 * Faithful divergence: the trajectory compressor only ever calls `len(encode(text))`,
 * so an even narrower interface — `encode(text) -> { length: number }` — would
 * suffice, but matching the upstream shape keeps callsites obvious.
 */
export interface Tokenizer {
  encode(text: string): number[] | { length: number };
}

/**
 * Sentinel for temperature contracts. When `effectiveTemperatureForModel`
 * returns `OMIT_TEMPERATURE`, callers MUST strip the `temperature` key from
 * the request entirely (matches upstream `OMIT_TEMPERATURE` in agent.auxiliary_client).
 *
 * The trajectory port consumes this via the `temperatureResolver` injected into
 * the compressor — see `LlmClient` below.
 */
export const OMIT_TEMPERATURE: unique symbol = Symbol("OMIT_TEMPERATURE");
export type OmitTemperature = typeof OMIT_TEMPERATURE;

/**
 * Effective temperature value, mirroring `_effective_temperature_for_model`:
 *   - `number` → use this temperature
 *   - `null` → caller must omit the `temperature` key entirely
 *
 * The TS surface returns `number | null`; downstream callers translate `null`
 * into "do not send the field" exactly like the Python `Optional[float]`
 * sentinel handling.
 */
export type EffectiveTemperature = number | null;

/**
 * Resolver for effective per-model temperature.
 *
 * Faithful port of `_effective_temperature_for_model` (trajectory_compressor.py
 * lines 59-79). The function is injected to avoid a hard dep on
 * `@hermests/agent.auxiliary_client._fixed_temperature_for_model`.
 *
 * Default behaviour when `resolver` is `null` (i.e. agent package unavailable):
 * return the requested temperature unchanged — matches the Python try/except
 * ImportError branch.
 */
export type TemperatureResolver = (
  model: string,
  requestedTemperature: number,
  baseUrl: string | null | undefined,
) => EffectiveTemperature;

/**
 * Chat completion message shape used by both the call_llm wrapper and the raw
 * OpenAI SDK client. Faithful to the upstream
 * `[{"role": "user", "content": prompt}]` shape.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * Response shape we read back — only `choices[0].message.content` is consumed,
 * so the public interface is intentionally narrow.
 */
export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
}

/**
 * Synchronous LLM client surface — corresponds to either
 * `client.chat.completions.create(**kwargs)` (raw OpenAI SDK path) OR
 * `call_llm(provider=..., model=..., messages=..., temperature=..., max_tokens=...)`
 * (router path).
 *
 * The trajectory compressor abstracts both via a single method; the injected
 * implementation decides whether it routes through the provider router or calls
 * the OpenAI SDK directly. When `temperature` is `null`, the implementation
 * MUST omit it from the request payload.
 */
export interface SyncLlmClient {
  createChatCompletion(args: {
    model: string;
    messages: ChatMessage[];
    temperature: EffectiveTemperature;
    maxTokens: number;
  }): ChatCompletionResponse;
}

/**
 * Asynchronous LLM client surface — corresponds to either
 * `await self._get_async_client().chat.completions.create(**kwargs)` OR
 * `await async_call_llm(provider=..., model=..., messages=..., ...)`.
 *
 * Returns a Promise<ChatCompletionResponse>.
 */
export interface AsyncLlmClient {
  createChatCompletion(args: {
    model: string;
    messages: ChatMessage[];
    temperature: EffectiveTemperature;
    maxTokens: number;
  }): Promise<ChatCompletionResponse>;
}

/**
 * Combined LLM client capability — concrete implementations live in
 * `@hermests/agent` (auxiliary_client). The trajectory compressor accepts
 * either both (full feature parity) or only the sync one (sync-only callers).
 */
export interface LlmClientPair {
  sync: SyncLlmClient;
  async: AsyncLlmClient;
}

/**
 * Backoff strategy injected for retry delays — defaults to
 * `defaultJitteredBackoff` (a faithful port of `agent.retry_utils.jittered_backoff`).
 *
 * Returns the delay in seconds for `attempt` (1-based).
 */
export type BackoffFn = (
  attempt: number,
  options: { baseDelay: number; maxDelay: number },
) => number;

/**
 * Sleep function — abstracted so tests can fake `setTimeout`.
 * Argument is in milliseconds, mirroring `setTimeout` rather than Python's
 * `time.sleep(seconds)` so callers don't have to do unit math.
 */
export type SleepFn = (ms: number) => Promise<void>;

/**
 * Minimal logger interface. Methods correspond to `logging.Logger.warning` and
 * `logging.Logger.error` calls in the upstream source.
 */
export interface Logger {
  warning(message: string): void;
  error(message: string): void;
}
