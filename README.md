# HermesTS

A faithful TypeScript port of [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent).

## Status

**Work in progress.** This is a large port (883k LOC of Python across 1,821 files). Work is being executed by a coordinated agent swarm and committed module-by-module.

Track progress in [`PORTING_PLAN.md`](./PORTING_PLAN.md) and the [GitHub Issues](https://github.com/AntSentry/HermesTS/issues).

## Architecture

The port preserves the original module boundaries as a Bun/Node workspace monorepo under `packages/`:

| Package | Source module | Status |
|---|---|---|
| `@hermests/core` | top-level `*.py` (constants, logging, time, utils, bootstrap) | in-review ([#17](https://github.com/AntSentry/HermesTS/pull/17)) |
| `@hermests/agent` | `agent/` (102 files, 63k LOC) | pending |
| `@hermests/cli` | `cli.py` + `hermes_cli/` (97 files, 100k LOC) | pending |
| `@hermests/gateway` | `gateway/` (61 files, 79k LOC) | pending |
| `@hermests/tools` | `tools/` (95 files, 67k LOC) | pending |
| `@hermests/plugins` | `plugins/` (122 files, 46k LOC) | pending |
| `@hermests/skills` | `skills/` + `optional-skills/` (91 files, 30k LOC) | pending |
| `@hermests/providers` | `providers/` | pending |
| `@hermests/acp` | `acp_adapter/` + `acp_registry/` | pending |
| `@hermests/tui-gateway` | `tui_gateway/` | pending |
| `@hermests/state` | `hermes_state.py` (140 KB) | PR open (port/state) |
| `@hermests/trajectory` | `trajectory_compressor.py` | pending |
| `@hermests/mcp` | `mcp_serve.py` | pending |
| `@hermests/batch` | `batch_runner.py` | pending |

## Development

```bash
bun install
bun run typecheck
bun run test         # vitest --coverage, 100% threshold
bun run lint
```

## License

MIT (matching upstream).
