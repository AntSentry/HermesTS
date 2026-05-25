/**
 * Public surface of `@hermests/agent`.
 *
 * Faithful TypeScript port of upstream `agent/` from
 * `nousresearch/hermes-agent`. Split across many sub-tasks (#5a–#5o). See
 * the package README for the current status table.
 *
 * Each ported sub-module is re-exported here under its upstream submodule
 * path (`./auxiliary-client`, `./anthropic-adapter`, …) so that downstream
 * packages can mirror upstream Python `from agent.auxiliary_client import X`
 * with TS `import { X } from "@hermests/agent/auxiliary-client"`.
 */

export * as auxiliaryClient from "./auxiliary-client/index.js";
