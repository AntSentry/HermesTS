# HermesTS Porting Plan

## Source

- Upstream: `github.com/nousresearch/hermes-agent` @ `main`
- Local cache: `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main`
- Refresh: `opensrc fetch github:nousresearch/hermes-agent`

## Scale

- 1,821 Python files, **882,590 LOC** (441k of which are tests in `tests/`)
- 13 top-level Python modules + 16 standalone `*.py` files
- Largest: `cli.py` (14,780 LOC), `run_agent.py` (4,309 LOC), `hermes_state.py` (3,279 LOC)

## Constraints

- **Faithful port** — no shortcuts, no skimming, no stubs. If a function exists upstream, it must exist with equivalent behavior in TS.
- **100% coverage** (lines/branches/functions/statements) enforced by `vitest.config.ts` thresholds.
- **No Python-only deps** — every Python library used by hermes-agent must be either rewritten in TS or replaced with a JS equivalent documented in `docs/dep-mapping.md`.
- **Preserve module boundaries** — each upstream top-level module becomes one workspace package under `packages/`.

## Dependency order (port modules in this order so downstream packages can typecheck)

1. **core** — `hermes_constants.py`, `hermes_logging.py`, `hermes_time.py`, `utils.py`, `hermes_bootstrap.py`. No internal deps. Foundation for everything.
2. **state** — `hermes_state.py`. Depends on core.
3. **providers** — `providers/`. Depends on core.
4. **trajectory** — `trajectory_compressor.py`. Depends on core, state.
5. **agent** — `agent/`. Depends on core, state, providers, trajectory.
6. **tools** — `tools/`, `toolsets.py`, `toolset_distributions.py`, `model_tools.py`. Depends on core, agent.
7. **skills** — `skills/`, `optional-skills/`. Depends on core, agent, tools.
8. **plugins** — `plugins/`. Depends on core, agent, tools.
9. **acp** — `acp_adapter/`, `acp_registry/`. Depends on core, agent.
10. **gateway** — `gateway/`. Depends on agent, providers, tools.
11. **tui-gateway** — `tui_gateway/`. Depends on gateway.
12. **mcp** — `mcp_serve.py`. Depends on agent, tools.
13. **batch** — `batch_runner.py`, `mini_swe_runner.py`. Depends on agent.
14. **cli** — `cli.py`, `hermes_cli/`, `run_agent.py`, `cli-config.yaml.example`. Depends on everything.

## Per-module workflow (every porting agent follows this)

1. Read upstream source from `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/<module>/` IN FULL — no skimming.
2. Create `packages/<name>/{src,tests,package.json,tsconfig.json,README.md}`.
3. Port each `.py` file to a `.ts` file preserving function names, class names, public surface.
4. Port each upstream test in `tests/` that targets this module to a Vitest equivalent.
5. Write additional tests as needed to hit 100% line/branch/function/statement coverage.
6. Run `bun run typecheck && bun run test` from repo root — must be green.
7. Commit on a branch named `port/<module>` and open a PR against `main`.
8. Update README.md status table and this plan.

## Coverage discipline

- The `vitest.config.ts` threshold (100%) is **non-negotiable** and will hard-fail CI.
- Any line excluded with `/* v8 ignore */` requires a one-line comment justifying why and a reviewer sign-off in the PR.
- Don't lower the threshold to "ship green." Add tests instead, or document why the code is unreachable.

## Things explicitly NOT in scope for the port itself

- `website/`, `infographic/`, `assets/`, `locales/`, `docs/`, `plans/` — content/docs, not code.
- `nix/`, `flake.nix`, `flake.lock`, Nix tooling — replaced by Bun/npm.
- `Dockerfile`, `docker-compose.yml` — will be re-authored in TS-native form once core lands.
- `.github/` workflows — will be re-authored for the TS toolchain.
- `RELEASE_v*.md` — historical Python release notes preserved upstream, not duplicated here.

## Reference checking

Every PR description must include:
- Source file paths (upstream)
- Target file paths (this repo)
- A `git diff --stat` of the upstream file vs the upstream commit at port time
- Coverage report excerpt showing 100%

## Workstream status

See README status table. Update both when a module merges.
