/**
 * Transport layer barrel — types, registry, and per-provider transports.
 *
 * Faithful port of upstream `agent/transports/__init__.py`.
 *
 * Usage:
 *   ```ts
 *   import { getTransport } from "@hermests/agent/transports";
 *   const transport = getTransport("anthropic_messages");
 *   const result = transport?.normalizeResponse(rawResponse);
 *   ```
 *
 * Per-provider transports that depend on sibling adapter sub-tasks (#5h,
 * #5i, #5n) export an explicit `registerXxxTransport(adapter)` helper.
 * Sub-task #5o (integrators) calls these at startup.
 *
 * `ChatCompletionsTransport` auto-registers on import — no DI required.
 */

export * from "./types.js";
export * from "./base.js";
export * from "./registry.js";
export * from "./anthropic.js";
export * from "./bedrock.js";
export * from "./codex.js";
export * from "./chat_completions.js";
