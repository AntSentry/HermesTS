/**
 * Module-level lazy proxy for the OpenAI SDK client constructor. Faithful port
 * of lines 53-100 of upstream `agent/auxiliary_client.py`.
 *
 * Upstream uses a `_OpenAIProxy` callable so the 15+ in-module `OpenAI(...)`
 * construction sites work without importing the SDK at module top (the
 * `openai` package has a ~240 ms cold-import cost). External code can still
 * do `patch("agent.auxiliary_client.OpenAI", FakeOpenAI)` — the patch
 * replaces the module attribute as usual.
 *
 * In TS the lazy-cold-import concern is the same (avoid bundling the `openai`
 * npm package transitively unless used). The proxy here is a value with a
 * callable invocation (`OpenAI({...})`) plus an `isOpenAIClient(x)` identity
 * check that mirrors `isinstance(x, OpenAI)`.
 *
 * The actual constructor is registered via `setOpenAIClientFactory` in
 * `../_internal/sibling-stubs.ts` — the integrator (#5o) wires the real
 * `openai` package constructor there.
 */

import type { OpenAIClient, OpenAIClientOptions } from "../_internal/openai-client-shape.js";
import {
  isOpenAIClient as _isOpenAIClient,
  createOpenAIClient,
} from "../_internal/sibling-stubs.js";

/**
 * Module-level proxy that looks like the `openai.OpenAI` class.
 *
 * Forwards `OpenAI(...)` calls and `isOpenAIClient(x)` checks to the real
 * SDK class, importing the SDK lazily on first use.
 *
 * Use the callable form to construct a client:
 *
 * ```ts
 * const client = OpenAI({ api_key: "...", base_url: "..." });
 * ```
 *
 * Use `isOpenAIClient(x)` instead of `x instanceof OpenAI` — TypeScript's
 * structural typing means a literal `instanceof` against this proxy value
 * would not match the actual SDK class.
 */
export function OpenAI(options?: OpenAIClientOptions): OpenAIClient {
  return createOpenAIClient(options);
}

/**
 * Identity check — replaces `isinstance(obj, OpenAI)` upstream. Returns
 * `true` for any client minted through `OpenAI(...)` plus any object
 * registered via `registerOpenAIClient` in the stub module.
 */
export function isOpenAIClient(obj: unknown): boolean {
  return _isOpenAIClient(obj);
}
