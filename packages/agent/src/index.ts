/**
 * @hermests/agent — per-turn runtime helpers.
 *
 * Faithful port of upstream `agent/`. Multi-PR rollout:
 *   - This PR (sub-task #5a) ports the 20 leaf utility files. The
 *     remaining 82 source files land in subsequent sub-tasks (#5b–#5o);
 *     each appends its exports here.
 *
 * Mirrors upstream `agent/__init__.py` — the package-level docstring
 * is preserved as `AGENT_PACKAGE_DESCRIPTION` so downstream code can
 * read the same text without re-parsing the Python source.
 */

export const AGENT_PACKAGE_DESCRIPTION =
  "Agent internals — extracted modules from run_agent.py. " +
  "Pure utility functions and self-contained classes that were " +
  "previously embedded in the 3,600-line run_agent.py. Extracting " +
  "them makes run_agent.py focused on the AIAgent orchestrator class.";

export * from "./async-utils.js";
export * from "./file-safety.js";
export * from "./gemini-schema.js";
export * from "./i18n.js";
export * from "./iteration-budget.js";
export * from "./lmstudio-reasoning.js";
export * from "./manual-compression-feedback.js";
export * from "./markdown-tables.js";
export * from "./moonshot-schema.js";
export * from "./portal-tags.js";
export * from "./process-bootstrap.js";
export * from "./prompt-caching.js";
export * from "./retry-utils.js";
export * from "./subdirectory-hints.js";
export * from "./system-prompt.js";
export * from "./tool-result-classification.js";
export * from "./trajectory.js";
export { SECRET_SOURCES_DESCRIPTION } from "./secret-sources/index.js";
