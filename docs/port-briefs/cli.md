# Port Brief — `@hermests/cli`

Upstream: `cli.py` + `hermes_cli/` + `run_agent.py` + `cli-config.yaml.example`
Target package: `packages/cli/`
Source root: `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/`
Parent task: **#14** — depends on everything (#1–#13).

> This is the **largest module** in the port — ~119,250 LOC across 99 files (cli.py 14,780 LOC, hermes_cli/ 100,256 LOC across 97 files, run_agent.py 4,309 LOC, cli-config.yaml.example 1,100 LOC). Subdivision quality matters most here. Read every `.py` IN FULL. The numbers below were verified by `wc -l` on the local opensrc cache.

---

## 1. Scope & shape

The CLI module is the user-facing entry point for Hermes. It contains three structurally distinct entry points:

| Entry point | LOC | Role |
|---|---:|---|
| `cli.py` | 14,780 | **Interactive REPL / TUI** — `python cli.py` (no subcommand). One giant `HermesCLI` class wrapping `prompt_toolkit`, slash commands, streaming output, voice, snapshots, model picker, toolset selection, image attach, paste handling, scrollback, status bar, signal handling, worktree management. |
| `hermes_cli/main.py` | 13,816 | **`argparse` dispatcher** — `hermes <cmd>` (46 top-level subparsers, 167 `add_parser()` calls total counting nested groups). Builds the parser tree, dispatches to `cmd_*` handlers, owns 30 top-level `cmd_*` functions. |
| `run_agent.py` | 4,309 | **`AIAgent` library class** — used by both entry points and by every test in the suite. The conversation loop, tool-calling protocol, provider abstraction, streaming, retries, session persistence. 185 methods on `AIAgent`. |
| `hermes_cli/` (rest) | ~82,000 | 91 support modules — argparse handlers, gateway runtime, kanban DB, auth flows, profile/skin engines, web server, doctor, plugins, model catalogs, voice, snapshots, etc. |
| `cli-config.yaml.example` | 1,100 | Documented reference config — every option that `load_cli_config()` in `cli.py` knows how to read. Drives schema generation in the port. |

**Top-level subcommand inventory** (46 commands, captured from `subparsers.add_parser()` at `hermes_cli/main.py:10957–13627`):

`model`, `fallback`, `secrets`, `migrate`, `gateway`, `proxy`, `setup`, `postinstall`, `whatsapp`, `slack`, `login`, `logout`, `auth`, `status`, `cron`, `webhook`, `hooks`, `doctor`, `dump`, `debug`, `backup`, `checkpoints`, `import`, `config`, `pairing`, `skills`, `bundles`, `plugins`, `curator`, `memory`, `tools`, `computer-use`, `mcp`, `sessions`, `insights`, `claw`, `version`, `update`, `uninstall`, `acp`, `profile`, `completion`, `dashboard`, `logs`, plus two dynamic plugin-injected parsers (`main.py:12487, 12502`).

**Interactive slash commands** (extracted from `HermesCLI.process_command()` at `cli.py:5250–5742` and the `_handle_*_command()` cluster): `/help`, `/status`, `/tools`, `/toolsets`, `/profile`, `/config`, `/history`, `/sessions`, `/branch`, `/handoff`, `/resume`, `/new`, `/save`, `/retry`, `/undo`, `/snapshot`, `/rollback`, `/model`, `/runtime`, `/skin`, `/footer`, `/personality`, `/cron`, `/curator`, `/kanban`, `/skills`, `/bundles`, `/browser`, `/goal`, `/subgoal`, `/copy`, `/paste`, `/image`, `/voice`, `/verbose`, `/yolo`, `/reasoning`, `/busy`, `/fast`, `/compress`, `/debug`, `/update`, `/usage`, `/insights`, `/agents`, `/stop`, `/gquota`, `/background`, `/codex`. Each maps to a method on `HermesCLI`.

---

## 2. Dependencies (port order)

This module sits at the **top of the dependency stack** — it imports from every other workspace package:

| Upstream module | TS package | Why CLI needs it |
|---|---|---|
| `hermes_constants`, `hermes_logging`, `hermes_time`, `hermes_bootstrap`, `utils` | `@hermests/core` | Logging, UTF-8 stdio bootstrap, time/duration formatting, env helpers. |
| `hermes_state` | `@hermests/state` | Session DB, checkpoint store, snapshot/rollback storage. |
| `providers/` | `@hermests/providers` | OpenAI/Anthropic/Azure/OpenRouter/Copilot/Vercel/xAI/Ollama/LMStudio client factories. |
| `trajectory_compressor` | `@hermests/trajectory` | `/compress` command and the auto-compress path inside `AIAgent`. |
| `agent/` | `@hermests/agent` | `process_bootstrap.OpenAI` lazy proxy, `_install_safe_stdio`, conversation primitives. Run-agent re-exports these. |
| `tools/`, `toolsets`, `model_tools` | `@hermests/tools` | Tool registry, toolset definitions, the `--toolsets`/`--skills` flags. |
| `skills/`, `optional-skills/` | `@hermests/skills` | `/skills` slash command and the `hermes skills` subcommand surface. |
| `plugins/` | `@hermests/plugins` | Plugin discovery, the `hermes plugins` surface, and dynamic argparse injection at `main.py:12487`. |
| `acp_adapter/`, `acp_registry/` | `@hermests/acp` | The `hermes acp` subcommand — runs as an ACP server for editor integrations. |
| `gateway/` | `@hermests/gateway` | Reused by `hermes gateway` (foreground), but `hermes_cli/gateway.py` (220KB) wraps it with platform service installation (launchd/systemd/Windows services). |
| `tui_gateway/` | `@hermests/tui-gateway` | Used by `/handoff` and gateway-mode rendering inside the REPL. |
| `mcp_serve` | `@hermests/mcp` | `hermes mcp` subcommand wraps the MCP server. |
| `batch_runner`, `mini_swe_runner` | `@hermests/batch` | Not directly imported by `cli.py`, but `hermes claw` and `hermes dashboard` link out to batch runs. |

**Implication:** `@hermests/cli` cannot start until **#1–#13 are merged and typecheck-green**. Every sub-task here transitively depends on all 13 prior modules. This is the single hardest blocking constraint for the entire port.

---

## 3. External / Python-only dependencies that need a TS plan

| Python lib | Used in | TS replacement plan |
|---|---|---|
| `prompt_toolkit` | `cli.py` (entire TUI), `hermes_cli/pt_input_extras.py` | **`@inquirer/prompts` + `ink` + `blessed`** — `ink` (React-for-CLI) gives the fixed input area + scrollback panel, `blessed` provides the curses primitives `curses_ui.py` needs, `@inquirer/prompts` covers the simpler picker flows. Document in `docs/dep-mapping.md`. The full-screen TUI layout in `_build_tui_layout_children()` (`cli.py:9242`) is the hardest piece — likely needs an `ink` re-author rather than a literal port. |
| `argparse` | `hermes_cli/main.py`, `hermes_cli/_parser.py` | **`commander`** or **`cac`** — must preserve exact CLI surface (flag names, help text, defaults). `commander` has the better subcommand model. |
| `pyyaml` | `cli.py` (`load_cli_config()`), `cli-config.yaml.example` consumer | **`yaml`** (eemeli/yaml) — preserves comments and key order, which matters for `hermes config edit`. |
| `fire` | `run_agent.py` `__main__` block only | Skip — `run_agent.py` as a standalone CLI is a rarely-used dev affordance; the TS port exposes `AIAgent` as a library and gates `__main__` behind a simple flag parser. |
| `curses` | `hermes_cli/curses_ui.py` (16,906 LOC) | **`blessed`** (`chjj/blessed`) — full curses-style screen control on Node. Picker UIs (`_run_curses_picker` at `cli.py:4080`) live here. |
| `pyperclip` / OSC52 / Windows clipboard | `hermes_cli/clipboard.py` | **`clipboardy`** for cross-platform; native OSC52 escape sequences (`_write_osc52_clipboard` at `cli.py:2733`) port verbatim. |
| `asyncio` event loop | `run_agent.py`, throughout | Node's native event loop. Watch for `asyncio.gather` → `Promise.all` and `asyncio.Lock` → `async-mutex`. |
| `concurrent.futures.ThreadPoolExecutor` | `cli.py`, `run_agent.py` | `worker_threads` for CPU-bound; promise pooling (`p-limit`) for IO-bound. |
| `signal` (`SIGINT`, `SIGWINCH`, `SIGTERM`) | `cli.py:11822` `_signal_handler_q`, `cli.py:443` `_recover_after_resize` | Node `process.on('SIGINT', ...)` etc. `SIGWINCH` available cross-platform via `process.stdout.on('resize', ...)`. |
| `sounddevice` / `numpy` (voice record) | `cli.py:7541` `_voice_start_recording`, `hermes_cli/voice.py` | **`@discordjs/voice`** record path OR shell out to `sox`/`ffmpeg`. Document decision in voice sub-task. |
| `openai` SDK | `run_agent.py` (lazy proxy at `agent/process_bootstrap.py:OpenAI`) | **`openai`** npm package. Lazy import already factored — port preserves the proxy pattern. |
| `httpx`, `requests`, `urllib` | scattered | **`undici`** (or native `fetch` on Node 22+). |
| `sqlite3` | `hermes_cli/kanban_db.py` (255KB), session DB | **`better-sqlite3`** (sync, fastest) — kanban DB is performance-critical. |
| `chromadb` / sentence-transformers (skills RAG) | `hermes_cli/skills_hub.py` | Defer until skills sub-task lands; likely **`@lancedb/lancedb`** + a JS embedding model or call out to a Python sidecar via the existing process plumbing. |
| `subprocess` (PTY bridge, gateway service install) | `hermes_cli/pty_bridge.py`, `hermes_cli/_subprocess_compat.py`, `hermes_cli/gateway.py` | **`node-pty`** for PTY, `child_process.spawn` for normal sub-processes. |
| `playwright` (browser_connect) | `hermes_cli/browser_connect.py` | **`playwright`** npm package. |
| `psutil` (process listing in `doctor`) | `hermes_cli/doctor.py` (88KB) | **`pidusage`** + `ps-list` + native `os` for process tree. |

Detailed mapping goes in `docs/dep-mapping.md` (task #20).

---

## 4. Recommended workspace package layout

```
packages/cli/
├── package.json                              # bin: { hermes: "./dist/bin/hermes.js" }
├── tsconfig.json
├── README.md
├── src/
│   ├── bin/
│   │   ├── hermes.ts                         # main `hermes` executable (argparse dispatcher)
│   │   └── hermes-repl.ts                    # `python cli.py` equivalent — interactive entry
│   ├── repl/                                 # ports cli.py
│   │   ├── HermesCli.ts                      # the class
│   │   ├── methods/                          # one file per logical method cluster
│   │   │   ├── status-bar.ts
│   │   │   ├── streaming.ts
│   │   │   ├── slash-commands.ts
│   │   │   ├── slash-handlers/
│   │   │   │   ├── handle-model.ts
│   │   │   │   ├── handle-skin.ts
│   │   │   │   └── ... (one per slash command)
│   │   │   ├── voice.ts
│   │   │   ├── snapshot-rollback.ts
│   │   │   ├── modal-input.ts
│   │   │   ├── approvals.ts
│   │   │   └── ...
│   │   ├── layout/                           # prompt_toolkit/ink layout
│   │   ├── skin.ts
│   │   └── output-history.ts
│   ├── run-agent/                            # ports run_agent.py
│   │   ├── AiAgent.ts
│   │   ├── methods/                          # similar clustering
│   │   └── stream-diag.ts
│   ├── commands/                             # ports hermes_cli/main.py cmd_* handlers
│   │   ├── chat.ts
│   │   ├── gateway.ts
│   │   ├── auth.ts
│   │   ├── ... (one per top-level subcommand)
│   │   └── _parser.ts                        # ports hermes_cli/_parser.py
│   ├── support/                              # ports hermes_cli/*.py support modules
│   │   ├── auth.ts                           # ports hermes_cli/auth.py (294KB)
│   │   ├── config.ts                         # ports hermes_cli/config.py (237KB)
│   │   ├── gateway-runtime.ts                # ports hermes_cli/gateway.py (220KB)
│   │   ├── kanban.ts                         # ports hermes_cli/kanban.py + kanban_db.py
│   │   ├── doctor.ts                         # ports hermes_cli/doctor.py (87KB)
│   │   ├── web-server.ts                     # ports hermes_cli/web_server.py (179KB)
│   │   ├── models.ts                         # ports hermes_cli/models.py (141KB)
│   │   ├── tools-config.ts                   # ports hermes_cli/tools_config.py (136KB)
│   │   ├── skin-engine.ts
│   │   ├── voice.ts
│   │   ├── proxy/                            # ports hermes_cli/proxy/
│   │   └── ...
│   └── config-schema/
│       ├── cli-config.yaml.example           # vendored copy
│       └── schema.ts                         # generated/hand-authored Zod schema
└── tests/
    └── (mirrors src/)
```

Bin entries shipped: `hermes` (subcommand dispatcher), `hermes-repl` (interactive REPL — the `python cli.py` analogue). These map 1:1 to upstream's `./hermes` shell shim and `cli.py`.

---

## 5. Subdivision plan — sub-tasks #14a–#14y

**24 sub-tasks total.** All blocked by **#1–#13**. Order within the group is roughly leaf-first (support modules) → middle (commands) → integration (REPL + run-agent + entry binaries).

> Each sub-task must follow the per-module workflow in `PORTING_PLAN.md` (read upstream in full, port preserving names, port tests, hit 100% coverage, commit on `port/cli-<slice>`, open PR). Cross-task contract: every sub-task that touches `hermes_cli/main.py` must add a one-line `// PORT-SOURCE: hermes_cli/main.py:<L1>-<L2>` comment at the top of each new file so #14u (dispatcher) can stitch them back together without ambiguity.

### Phase A — Support leaves (small/medium files, low fan-in)

| # | Slice | Upstream | LOC | Notes |
|---|---|---|---:|---|
| **14a** | `support/proxy` | `hermes_cli/proxy/` (5 files) | ~600 | Smallest leaf. Adapter pattern (`base`, `nous_portal`, `xai`) — clean to port first as a warm-up. |
| **14b** | `support/clipboard + osc52 + paste extras` | `clipboard.py`, `pt_input_extras.py`, `_subprocess_compat.py`, `default_soul.py`, `colors.py`, `timeouts.py` | ~1,400 | Tiny utilities. Batch. |
| **14c** | `support/fallback + dep-ensure + relaunch + env-loader` | `fallback_config.py`, `fallback_cmd.py`, `dep_ensure.py`, `env_loader.py`, `relaunch.py`, `migrate.py`, `platforms.py` | ~3,200 | Boot-path utilities. Batch. |
| **14d** | `support/auth-providers (small)` | `dingtalk_auth.py`, `copilot_auth.py`, `vercel_auth.py`, `pairing.py`, `portal_cli.py`, `slack_cli.py`, `nous_subscription.py`, `xai_retirement.py`, `security_advisories.py`, `azure_detect.py`, `codex_models.py`, `codex_runtime_switch.py`, `cli_output.py`, `browser_connect.py`, `bundles.py`, `callbacks.py`, `checkpoints.py`, `skills_config.py`, `webhook.py`, `inventory.py`, `model_catalog.py`, `model_normalize.py`, `memory_setup.py`, `mcp_config.py`, `oneshot.py`, `pty_bridge.py`, `secrets_cli.py`, `send_cmd.py`, `session_recap.py`, `profile_describer.py`, `cron.py`, `dump.py`, `completion.py`, `logs.py`, `hooks.py`, `stdio.py`, `tips.py`, `clipboard.py` (already in 14b — dedupe), `voice.py` (split — see 14n) | ~50,000 | **Largest batch — but pure leaves.** Split into 5 commits inside the same sub-task PR if reviewer prefers smaller diffs. Each file is a 1-to-1 port; tests follow file boundaries. |
| **14e** | `support/skin-engine + curses-ui + banner + skin` | `skin_engine.py` (44KB), `curses_ui.py` (16KB), `banner.py` (27KB), `tips.py` (already in 14d — move here if reviewer prefers), `voice.py` UI bits | ~3,500 | Visual layer. Depends on chosen TUI lib (`blessed`/`ink`). Surface decisions inform 14u. |

### Phase B — Single-file giants (one sub-task per file)

| # | Slice | Upstream | LOC | Why solo |
|---|---|---|---:|---|
| **14f** | `support/config` | `hermes_cli/config.py` | 8,200 (237KB) | Owns the schema for `cli-config.yaml.example` (1,100 lines). The Zod schema for the port lives here. Touches everything downstream. |
| **14g** | `support/auth` | `hermes_cli/auth.py` | 9,800 (294KB) | OAuth flows for Anthropic, OpenAI, Google, Microsoft, Spotify, GitHub Copilot, Nous Portal, Vercel. Network/secrets-heavy. Critical-path security review. |
| **14h** | `support/kanban-db` | `hermes_cli/kanban_db.py` | 8,500 (255KB) | SQLite schema + 200+ queries. `better-sqlite3` port. Performance-sensitive. |
| **14i** | `support/kanban` | `hermes_cli/kanban.py` + `kanban_decompose.py` + `kanban_specify.py` + `kanban_swarm.py` + `kanban_diagnostics.py` | ~7,500 | Kanban UI/logic. Depends on 14h. |
| **14j** | `support/gateway-runtime` | `hermes_cli/gateway.py` (220KB) + `gateway_windows.py` (41KB) | ~9,000 | **Wraps** `@hermests/gateway` (#10) with platform service installation (launchd/systemd/Windows services). Cross-platform port — three independent code paths. |
| **14k** | `support/web-server` | `hermes_cli/web_server.py` | 6,400 (179KB) | The `hermes dashboard` HTTP server. Likely **Hono** or **Fastify** — choose in sub-task. |
| **14l** | `support/setup` | `hermes_cli/setup.py` | 5,100 (143KB) | Interactive setup wizard. Long branching script; port to async/await with explicit step machine. |
| **14m** | `support/models + model-switch + runtime-provider` | `models.py` (141KB), `model_switch.py` (73KB), `runtime_provider.py` (74KB), `model_normalize.py`, `model_catalog.py` | ~12,000 | Model catalog + provider runtime selection. Tightly coupled — port together. |
| **14n** | `support/tools-config + plugins + plugins-cmd + skills-hub` | `tools_config.py` (136KB), `plugins.py` (62KB), `plugins_cmd.py` (57KB), `skills_hub.py` (60KB), `codex_runtime_plugin_migration.py` (31KB) | ~12,500 | Tool + plugin + skill wiring. Bridges to `@hermests/tools`, `@hermests/plugins`, `@hermests/skills`. |
| **14o** | `support/doctor + status + voice + clipboard + commands` | `doctor.py` (87KB), `commands.py` (75KB), `status.py` (25KB), `voice.py` (32KB), `clipboard.py` (already), `goals.py` (30KB), `backup.py` (32KB), `curator.py` (20KB), `profile_distribution.py`, `profiles.py` (53KB), `uninstall.py` (28KB), `debug.py` (25KB), `auth_commands.py` (30KB) | ~25,000 | Mid-size grab-bag. Each file is independent. Author may further split. |

### Phase C — Argparse dispatcher (depends on most of A + B)

| # | Slice | Upstream | LOC | Depends on |
|---|---|---|---:|---|
| **14p** | `commands/parser + chat + gateway + proxy + setup + postinstall` | `hermes_cli/main.py:1–4000` (build, `cmd_chat`, `cmd_gateway`, `cmd_proxy`, `cmd_whatsapp`, `cmd_setup`, `cmd_postinstall`, `cmd_model`) + `_parser.py` | ~4,000 | 14a, 14c, 14f, 14j, 14l |
| **14q** | `commands/auth + login + logout + slack + portal + cron + webhook + hooks + status` | `cmd_login`, `cmd_logout`, `cmd_auth`, `cmd_status`, `cmd_cron`, `cmd_webhook`, `cmd_portal`, `cmd_slack`, `cmd_hooks` (`main.py:6058–6151`) | ~2,000 | 14d, 14g |
| **14r** | `commands/doctor + dump + debug + config + backup + import + version + uninstall` | `cmd_doctor`, `cmd_dump`, `cmd_debug`, `cmd_config`, `cmd_backup`, `cmd_import`, `cmd_version`, `cmd_uninstall` (`main.py:6152–6244`) | ~1,500 | 14f, 14o |
| **14s** | `commands/skills + bundles + plugins + curator + memory + tools + computer-use + mcp + sessions + insights + claw + pairing + checkpoints + kanban` | The remaining argparse subcommands (`main.py:12063–13230`) + `cmd_update` (`main.py:8557`) — this is the bulk of mid-file `main.py` | ~10,000 | 14h, 14i, 14m, 14n |
| **14t** | `commands/profile + dashboard + completion + logs + acp + update` | `cmd_profile` (`main.py:9855`), `cmd_dashboard` (`10525`), `cmd_completion` (`10590`), `cmd_logs` (`10603`), `acp` parser (`13298`), `cmd_update` (8557) — all the late-block commands | ~3,500 | 14k, 14o, plus `@hermests/acp` (#9) |

### Phase D — Run-agent library (no REPL dep, but used by every command)

| # | Slice | Upstream | LOC | Notes |
|---|---|---|---:|---|
| **14u** | `run-agent/core` | `run_agent.py:1–800` (module top, `_StreamErrorEvent`, helper funcs, `AIAgent.__init__` + first 30 methods) | ~800 | The setup half. |
| **14v** | `run-agent/conversation-loop` | `run_agent.py:800–2400` (~100 methods covering stream handling, repair, persistence, tool-call protocol, interrupt/steer, rate limits) | ~1,600 | The heart of the agent. Reuses `@hermests/agent` (#5). |
| **14w** | `run-agent/tools-and-providers` | `run_agent.py:2400–4309` (provider-specific branches, tool execution paths, deduplication, sanitization, `main()` function) | ~1,900 | Provider quirks, tool-call repair logic. |

### Phase E — Interactive REPL (depends on everything in A–D)

| # | Slice | Upstream | LOC | Notes |
|---|---|---|---:|---|
| **14x** | `repl/HermesCli skeleton + status-bar + streaming + layout` | `cli.py:1–2800` (module top, helpers, `_SkinAwareAnsi`, `ChatConsole`, `HermesCLI.__init__` + first ~50 methods through stream/output) | ~2,800 | Foundation of the class + non-interactive plumbing. Pick the TUI lib here. |
| **14y** | `repl/slash-commands + handlers (model/skin/voice/cron/skills/kanban/...) + sessions + branch + handoff + resume + new + save/retry/undo + approvals + secret-capture + voice` | `cli.py:2800–9000` (the bulk of `HermesCLI` methods — every slash-command handler, `process_command()`, approvals, voice loop, snapshot/rollback, model picker, modal input) | ~6,200 | The largest slice by far. Author should further split into ≤6 PRs along method clusters (recommended: streaming/output, sessions/history, slash-handlers, voice/audio, approvals/secrets, modal-input/UI). Each cluster gets its own commit on one PR branch. |
| **14z** | `repl/run loop + main + signal handlers + bin/hermes-repl entry + bin/hermes entry + config loader + integration tests` | `cli.py:9000–14780` (`run()`, `_signal_handler_q`, `main()`), `hermes_cli/main.py:13628–end` (main dispatch), `hermes_cli/__init__.py`, `cli-config.yaml.example` schema verification | ~6,800 | The final integration: wires REPL + argparse dispatcher into two binaries (`hermes`, `hermes-repl`), config loader, signal handling, end-to-end smoke tests with every prior sub-task merged. **Last sub-task to land.** |

**Total: 26 sub-tasks** (5 + 10 + 5 + 3 + 3). The lead's target was 15-25; this is one over by design — the leaf-batch in 14d is large enough (~50,000 LOC across ~38 small files) that splitting it would otherwise produce a single sub-task with 5× the LOC of any other. If the lead wants exactly 25, fold 14b into 14c (both are tiny utility batches). If 15-20 is preferred, also collapse 14q+14r into 14p, and merge 14u+14v+14w into a single run-agent task. The seams above are the natural ones; any consolidation forfeits some parallelism but no correctness.

---

## 6. Cross-cutting risks

1. **TUI library choice cascades.** Picking `ink` vs `blessed` vs `prompt_toolkit-via-WASM` in sub-task 14e/14x will rewrite the layout code in `cli.py:9242` (`_build_tui_layout_children`). Decide before Phase E starts; document in `docs/dep-mapping.md`. The 180-method `HermesCLI` class assumes prompt_toolkit's exact `Application`/`Layout`/`KeyBindings` model — a literal 1:1 port is **not possible**; structural translation is required.
2. **Argparse → commander parity.** Upstream uses argparse's `set_defaults(func=...)` dispatch pattern. `commander` uses `.action(cb)` per command. The port can either preserve the pattern with a thin wrapper or refactor to commander-native. **Decide in 14p**, apply consistently across 14q–14t.
3. **prompt_toolkit `Application.run()` is blocking and event-loop-aware.** Node's equivalent is `ink`'s render lifecycle + `stdin.setRawMode`. Streaming output during a model response (`_stream_delta` at `cli.py:1323`) interleaves with TUI redraws — the most error-prone area. Allocate extra test budget for 14x.
4. **`run_agent.py` is the most-imported file in the entire upstream codebase.** ~28 test files patch `run_agent.OpenAI`; the comment at `run_agent.py:56` explicitly preserves this seam. The TS port must export an `OpenAI` proxy from the same module path (`@hermests/cli/run-agent`) and document the test-double pattern for downstream packages. **Surface this in the 14u API contract.**
5. **Signal handling differs across platforms.** `SIGWINCH` on Windows requires the `process.stdout.on('resize')` event; `SIGINT` during `prompt_toolkit` raw mode behaves differently. The `_recover_after_resize` recovery dance (`cli.py:443`) does **not** translate naively. 14x must rewrite this for the chosen TUI lib.
6. **Subprocess parity with Python's `subprocess`.** `hermes_cli/_subprocess_compat.py` already wraps Python quirks; the TS port can be thinner (`child_process.spawn` is more consistent) — but `pty_bridge.py` requires `node-pty` and must handle Windows ConPTY differences explicitly. Document in 14b/14d.
7. **The `hermes acp` subcommand spawns a long-running ACP server** (`acp` parser at `main.py:13298`). The port must not assume the CLI process exits after `main()`; some commands are servers. 14t handles ACP; 14j handles gateway service mode; 14k handles dashboard server. All three need consistent process-lifecycle conventions.
8. **`hermes_cli/auth.py` (294KB)** mixes flow logic with vendored OAuth client code. Audit before porting — some vendored code may be replaceable with `openid-client` or `oauth4webapi` (Node-standard libraries). 14g must produce a "what to replace vs literal port" decision matrix as part of its PR.
9. **`cli-config.yaml.example` is the authoritative schema.** Any field that exists in the YAML must be readable by the port. Schema drift between Python and TS is the easiest place to silently break user configs. Recommend: generate the Zod schema from the YAML example via a small build step, committed to source. 14f owns this.
10. **`HermesCLI._handle_curator_command` (`cli.py:5145`) and `_handle_kanban_command` (`cli.py:5167`)** are thin shims that delegate to the support modules. Don't forget to register them in `process_command` (`cli.py:5250`) — the slash-command registry is a 500-line `if/elif` chain that must be exhaustively translated. 14y must include a parity test that asserts every upstream slash command is registered in the port.

---

## 7. Verification expectations (every sub-task)

- `bun run typecheck` and `bun run test` green from repo root.
- 100% line/branch/function/statement coverage on the touched files (`vitest.config.ts` enforces this).
- Upstream test parity: every Python test that targets the touched code has a Vitest equivalent. Use `rg --files "/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/tests/" | xargs rg -l "cli\\.py\\|hermes_cli\\|run_agent" | head` to locate them per sub-task.
- For sub-tasks that touch `main.py` (`14p`–`14t`): a snapshot test that boots the parser and asserts the help output of each subcommand byte-matches the upstream `python -m hermes_cli.main <cmd> --help` output (with version/path tokens normalized).
- For 14z (final integration): an end-to-end test that runs `hermes status`, `hermes doctor --quick`, `hermes version`, and `hermes-repl --list-tools` in a sandboxed temp HOME and asserts non-zero exit codes are absent.

---

## 8. Recommended read-order for any porting agent

1. `cli-config.yaml.example` — fastest way to learn the user-facing surface.
2. `hermes_cli/main.py` (the build_parser block at `~10645`) — argparse tree.
3. `hermes_cli/__init__.py` (49 LOC) and `hermes_cli/cli.py` (137 LOC — small, unrelated to the top-level `cli.py`).
4. `cli.py` lines 1–800 (module helpers) and the `HermesCLI.__init__` (`cli.py:2801–3060`).
5. `run_agent.py` lines 1–500 (module top + `AIAgent.__init__`).
6. The specific upstream file(s) the assigned sub-task touches — IN FULL.

> **No skimming.** Estimated read time: 4–6 hours for the largest sub-tasks (14g, 14j, 14y); 1–2 hours for the smallest. Budget accordingly.
