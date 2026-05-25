/**
 * Public surface of `@hermests/agent/auxiliary-client`.
 *
 * Faithful TypeScript port of upstream `agent/auxiliary_client.py` (5,289
 * LOC). The port is split across multiple files inside this directory;
 * upstream callers that imported a single name from `agent.auxiliary_client`
 * import it from `@hermests/agent/auxiliary-client` instead.
 *
 * Sub-task #5j tracks the slice-by-slice landing of this port. The exports
 * below grow as each slice merges. See the package README for status.
 */

// Slice 1 — types, constants, headers, content converter, OpenAI proxy.
export * from "./constants.js";
export * from "./content-converter.js";
export * from "./headers.js";
export * from "./nous-attribution.js";
export * from "./openai-proxy.js";
export * from "./pool-helpers.js";
export * from "./provider-config.js";
export * from "./url-utils.js";
