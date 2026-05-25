// Re-exports for the agent #5k context-compression sub-package.
//
// Contract-only initial PR: this barrel currently re-exports only the
// shared interface contract (`./types.ts`). The five upstream ports
// (memory_manager, account_usage, insights, context_compressor,
// conversation_compression) land via follow-up sub-tasks split off
// from #59. Each follow-up adds its own line here and removes nothing.
export * from "./types.js";
