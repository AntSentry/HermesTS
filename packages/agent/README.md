# @hermests/agent

Per-turn agent runtime for HermesTS — adapters, registries, auxiliary client, and conversation loop.

Faithful TypeScript port of upstream `agent/` from `nousresearch/hermes-agent`. Split across many sub-tasks because the upstream Python module is ~63 kLOC.

## Status

| sub-task | upstream files | status |
|---|---|---|
| 5j auxiliary client | `agent/auxiliary_client.py` (5,289 LOC) | in progress |

## Layout

- `src/auxiliary-client/` — auxiliary-LLM router for side tasks (context compression, session search, web extract, vision, browser vision). 7-step provider resolution chain. See [upstream docstring](https://github.com/nousresearch/hermes-agent/blob/main/agent/auxiliary_client.py).
- `src/_internal/` — minimal stub interfaces for sibling sub-tasks that have not yet landed. **Marked with `// FIXME(#5x): replace stub when sibling task lands`.** Integrator sub-task (#5o) is responsible for rewiring.

## Faithful divergences

Each sub-task PR documents its own faithful divergences in the PR body.
