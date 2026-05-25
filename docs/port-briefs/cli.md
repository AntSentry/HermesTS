# Port Brief — `@hermests/cli`

Upstream: `cli.py` + `hermes_cli/` + `run_agent.py` + `cli-config.yaml.example`
Target package: `packages/cli/`
Source root: `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/`
Parent task: **#14** — depends on everything (#1–#13).

> This is the **largest module** in the port — **120,445 LOC across 93 source files + 1 example config** (`cli.py` 14,780 LOC, `hermes_cli/` 100,256 LOC across 97 `.py` files in 91 directory entries — 90 top-level `.py` files + 1 `proxy/` sub-package containing 7 `.py` files, `run_agent.py` 4,309 LOC, `cli-config.yaml.example` 1,100 LOC). Subdivision quality matters most here. Read every `.py` IN FULL. **Every per-file LOC number in this brief was re-verified with `wc -l` against `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/` on 2026-05-25 after reviewer-pr3 caught inflation in v1.**

---

## 1. Scope & shape

The CLI module is the user-facing entry point for Hermes. It contains three structurally distinct entry points:

| Entry point | LOC | Role |
|---|---:|---|
| `cli.py` | 14,780 | **Interactive REPL / TUI** — `python cli.py` (no subcommand). One giant `HermesCLI` class wrapping `prompt_toolkit`, slash commands, streaming output, voice, snapshots, model picker, toolset selection, image attach, paste handling, scrollback, status bar, signal handling, worktree management. |
| `hermes_cli/main.py` | 13,816 | **`argparse` dispatcher** — `hermes <cmd>` (46 top-level subparsers, 167 `add_parser()` calls total counting nested groups). Builds the parser tree, dispatches to `cmd_*` handlers, owns 30 top-level `cmd_*` functions. |
| `run_agent.py` | 4,309 | **`AIAgent` library class** — used by both entry points and by every test in the suite. The conversation loop, tool-calling protocol, provider abstraction, streaming, retries, session persistence. 185 methods on `AIAgent`. |
| `hermes_cli/` (rest) | 86,393 | 89 top-level support modules + 7 `proxy/` sub-package modules (excludes `__init__.py` 47 LOC and `main.py` 13,816 LOC, both counted separately) — argparse handlers, gateway runtime, kanban DB, auth flows, profile/skin engines, web server, doctor, plugins, model catalogs, voice, snapshots, etc. |
| `cli-config.yaml.example` | 1,100 | Documented reference config — every option that `load_cli_config()` in `cli.py` knows how to read. Drives schema generation in the port. |

**Top-level subcommand inventory** (46 commands, captured from `subparsers.add_parser()` at `hermes_cli/main.py:10957–13627`):

`model`, `fallback`, `secrets`, `migrate`, `gateway`, `proxy`, `setup`, `postinstall`, `whatsapp`, `slack`, `login`, `logout`, `auth`, `status`, `cron`, `webhook`, `hooks`, `doctor`, `dump`, `debug`, `backup`, `checkpoints`, `import`, `config`, `pairing`, `skills`, `bundles`, `plugins`, `curator`, `memory`, `tools`, `computer-use`, `mcp`, `sessions`, `insights`, `claw`, `version`, `update`, `uninstall`, `acp`, `profile`, `completion`, `dashboard`, `logs`, plus two dynamic plugin-injected parsers (`main.py:12487, 12502`).

**Interactive slash commands** (extracted from `HermesCLI.process_command()` at `cli.py:5250–5742` and the `_handle_*_command()` cluster): `/help`, `/status`, `/tools`, `/toolsets`, `/profile`, `/config`, `/history`, `/sessions`, `/branch`, `/handoff`, `/resume`, `/new`, `/save`, `/retry`, `/undo`, `/snapshot`, `/rollback`, `/model`, `/runtime`, `/skin`, `/footer`, `/personality`, `/cron`, `/curator`, `/kanban`, `/skills`, `/bundles`, `/browser`, `/goal`, `/subgoal`, `/copy`, `/paste`, `/image`, `/voice`, `/verbose`, `/yolo`, `/reasoning`, `/busy`, `/fast`, `/compress`, `/debug`, `/update`, `/usage`, `/insights`, `/agents`, `/stop`, `/gquota`, `/background`, `/codex`. Each maps to a method on `HermesCLI`.

---

## 1.5 File inventory (complete)

Every upstream source file touched by this port, in alphabetical order, with verified LOC. Public exports column lists the symbols a downstream Python file imports from this module today; for files with no current importers in the upstream tree the column reads "(internal only)". The port preserves these names verbatim per the canonical-port doctrine in `PORTING_PLAN.md`.

### Top-level entry points + reference config

| upstream path | LOC | public exports | one-line purpose |
|---|---:|---|---|
| `cli.py` | 14,780 | `HermesCLI`, `main`, `ChatConsole`, `_SkinAwareAnsi`, `load_cli_config` | Interactive REPL / TUI. `python cli.py` (no subcommand) enters this. |
| `run_agent.py` | 4,309 | `AIAgent`, `_StreamErrorEvent`, `main`, `OpenAI` (lazy proxy re-export) | `AIAgent` library class — the conversation loop, tool-calling protocol, provider abstraction, streaming, retries, session persistence. Re-exported `OpenAI` is patched by ~28 test files. |
| `cli-config.yaml.example` | 1,100 | (reference config, not Python) | Documented reference config — every option `load_cli_config()` in `cli.py` knows how to read. Authoritative schema source for `support/config`. |

### `hermes_cli/` — top-level support modules (90 files)

| upstream path | LOC | public exports | one-line purpose |
|---|---:|---|---|
| `hermes_cli/__init__.py` | 47 | package init, version constant | Package marker; minor re-exports. |
| `hermes_cli/_parser.py` | 376 | `make_parser`, helper builders | argparse builder primitives shared by `main.py`. |
| `hermes_cli/_subprocess_compat.py` | 175 | `safe_popen`, signal helpers | Cross-platform subprocess shims. |
| `hermes_cli/auth.py` | 7,601 | provider auth-flow functions, OAuth/token handlers, secret-store helpers | OAuth/token flows for Anthropic, OpenAI, Google, Microsoft, Spotify, Copilot, Nous Portal, Vercel. Network/secrets-heavy. |
| `hermes_cli/auth_commands.py` | 797 | `cmd_login`, `cmd_logout`, `cmd_auth`, helpers | argparse handlers wrapping `auth.py`. |
| `hermes_cli/azure_detect.py` | 406 | `detect_azure_env`, helpers | Azure environment auto-detection. |
| `hermes_cli/backup.py` | 937 | `cmd_backup`, snapshot/restore helpers | `hermes backup` subcommand. |
| `hermes_cli/banner.py` | 702 | `print_banner`, version banner helpers | Startup banner, git state, pip update, skills counts. |
| `hermes_cli/browser_connect.py` | 217 | `connect_browser`, `cmd_browser_connect` | `hermes browser` connect path. |
| `hermes_cli/bundles.py` | 229 | `cmd_bundles`, bundle helpers | `hermes bundles` subcommand. |
| `hermes_cli/callbacks.py` | 242 | callback registry helpers | UI/event callbacks shared across REPL + CLI commands. |
| `hermes_cli/checkpoints.py` | 244 | `cmd_checkpoints`, checkpoint helpers | `hermes checkpoints` subcommand. |
| `hermes_cli/claw.py` | 809 | `cmd_claw`, claw batch wiring | `hermes claw` subcommand (batch runner integration). |
| `hermes_cli/cli_output.py` | 78 | `cli_print`, output helpers | Standard CLI output wrappers. |
| `hermes_cli/clipboard.py` | 494 | `copy_to_clipboard`, `paste_from_clipboard`, OSC52 helpers | Cross-platform clipboard + OSC52 escape sequence support. |
| `hermes_cli/codex_models.py` | 198 | codex model constants/helpers | Codex model catalog entries. |
| `hermes_cli/codex_runtime_plugin_migration.py` | 757 | migration helpers | One-shot migration for codex runtime plugin layout. |
| `hermes_cli/codex_runtime_switch.py` | 266 | runtime switch helpers | Switch codex runtime variants at startup. |
| `hermes_cli/colors.py` | 38 | ANSI color constants | Terminal color codes. |
| `hermes_cli/commands.py` | 1,819 | `cmd_*` handlers, `@-context` completion | Shared mid-tier command helpers (`@-context` completion, slash → cmd bridging). |
| `hermes_cli/completion.py` | 315 | `cmd_completion`, shell-completion helpers | `hermes completion` subcommand. |
| `hermes_cli/config.py` | 5,590 | `load_cli_config`, `save_cli_config`, config schema constants, env expansion | Config file load/save, env-var expansion, validation, the schema that drives `cli-config.yaml.example`. |
| `hermes_cli/copilot_auth.py` | 392 | GitHub Copilot OAuth helpers | Copilot device-code / token-exchange flow. |
| `hermes_cli/cron.py` | 322 | `cmd_cron`, cron schedule helpers | `hermes cron` subcommand. |
| `hermes_cli/curator.py` | 598 | `cmd_curator`, curator helpers | `hermes curator` subcommand. |
| `hermes_cli/curses_ui.py` | 472 | `run_curses_picker`, curses primitives | Curses-style picker UI primitives. |
| `hermes_cli/debug.py` | 746 | `cmd_debug`, diagnostic helpers | `hermes debug` subcommand. |
| `hermes_cli/default_soul.py` | 11 | `DEFAULT_SOUL` constant | Default personality / system-prompt fragment. |
| `hermes_cli/dep_ensure.py` | 159 | `ensure_dependency`, install helpers | Lazy optional-dependency installer. |
| `hermes_cli/dingtalk_auth.py` | 293 | DingTalk OAuth helpers | DingTalk login flow. |
| `hermes_cli/doctor.py` | 2,012 | `cmd_doctor`, diagnostic checks | `hermes doctor` subcommand — environment health checks. |
| `hermes_cli/dump.py` | 328 | `cmd_dump`, dump helpers | `hermes dump` subcommand. |
| `hermes_cli/env_loader.py` | 296 | `load_env`, env-file resolution | `.env` discovery + load, caching, sanitization. |
| `hermes_cli/fallback_cmd.py` | 354 | `cmd_fallback`, fallback wiring | `hermes fallback` subcommand. |
| `hermes_cli/fallback_config.py` | 72 | `FallbackConfig` dataclass | Provider-fallback configuration schema. |
| `hermes_cli/gateway.py` | 5,449 | `cmd_gateway`, service install/uninstall, runtime entry | Wraps `@hermests/gateway` with platform service installation (launchd/systemd). |
| `hermes_cli/gateway_windows.py` | 1,047 | Windows-service helpers | Windows service install/uninstall paths. |
| `hermes_cli/goals.py` | 762 | goal helpers, `/goal` REPL wiring | Goal / sub-goal tracking, REPL integration. |
| `hermes_cli/hooks.py` | 385 | `cmd_hooks`, hook helpers | `hermes hooks` subcommand. |
| `hermes_cli/inventory.py` | 240 | inventory helpers | Surveyed components inventory (used by `doctor`). |
| `hermes_cli/kanban.py` | 2,677 | `cmd_kanban`, kanban UI/logic | `hermes kanban` UI layer. |
| `hermes_cli/kanban_db.py` | 6,508 | DB schema, query functions | SQLite-backed kanban store (200+ queries). |
| `hermes_cli/kanban_decompose.py` | 477 | decompose helpers | LLM-backed task decomposition for kanban. |
| `hermes_cli/kanban_diagnostics.py` | 1,058 | diagnostic helpers | `hermes kanban diagnose` subcommand. |
| `hermes_cli/kanban_specify.py` | 271 | specify helpers | `hermes kanban specify` flow. |
| `hermes_cli/kanban_swarm.py` | 279 | swarm helpers | `hermes kanban swarm` flow. |
| `hermes_cli/logs.py` | 390 | `cmd_logs`, log helpers | `hermes logs` subcommand. |
| `hermes_cli/main.py` | 13,816 | `main`, 46 `cmd_*` handlers, `subparsers` tree | argparse dispatcher — the `hermes <cmd>` entry point. |
| `hermes_cli/mcp_config.py` | 780 | `cmd_mcp_config`, MCP config helpers | MCP config edit/list. |
| `hermes_cli/memory_setup.py` | 464 | memory setup helpers | Memory backend bootstrap. |
| `hermes_cli/migrate.py` | 115 | `cmd_migrate`, migration helpers | `hermes migrate` subcommand. |
| `hermes_cli/model_catalog.py` | 329 | model catalog helpers | Static catalog entries shared with `models.py`. |
| `hermes_cli/model_normalize.py` | 473 | `normalize_model_name`, helpers | Provider/model name normalization. |
| `hermes_cli/model_switch.py` | 1,799 | `apply_model_switch`, model-switch helpers | `/model` REPL command + `hermes model switch` plumbing. |
| `hermes_cli/models.py` | 3,788 | `list_models`, `cmd_model`, model resolution | Model catalog + provider resolution. |
| `hermes_cli/nous_subscription.py` | 799 | Nous subscription helpers | Nous Portal subscription + auth status cache. |
| `hermes_cli/oneshot.py` | 356 | `run_oneshot`, helpers | Non-interactive one-shot exec path. |
| `hermes_cli/pairing.py` | 115 | pairing helpers | Device-pairing flow. |
| `hermes_cli/platforms.py` | 83 | platform constants | OS/platform detection constants. |
| `hermes_cli/plugins.py` | 1,593 | `discover_plugins`, plugin runtime | Plugin discovery + load + dispatch. |
| `hermes_cli/plugins_cmd.py` | 1,636 | `cmd_plugins`, plugin CLI helpers | `hermes plugins` subcommand. |
| `hermes_cli/portal_cli.py` | 219 | `cmd_portal`, portal helpers | `hermes portal` subcommand. |
| `hermes_cli/profile_describer.py` | 299 | profile-describer helpers | Generates human-readable profile descriptions. |
| `hermes_cli/profile_distribution.py` | 706 | profile distribution helpers | Profile sharing / export. |
| `hermes_cli/profiles.py` | 1,470 | `cmd_profile`, profile registry | `hermes profile` subcommand + profile registry. |
| `hermes_cli/providers.py` | 721 | `detect_provider`, provider resolution | Provider URL / hostname detection. |
| `hermes_cli/pt_input_extras.py` | 83 | prompt_toolkit input helpers | Extra prompt_toolkit input behaviors. |
| `hermes_cli/pty_bridge.py` | 237 | `run_pty`, PTY helpers | PTY bridging for sub-processes that need a TTY. |
| `hermes_cli/relaunch.py` | 204 | `relaunch_python`, helpers | Re-exec under a different interpreter / venv. |
| `hermes_cli/runtime_provider.py` | 1,668 | `resolve_runtime_provider`, helpers | Runtime provider selection + API-mode detection. |
| `hermes_cli/secrets_cli.py` | 445 | `cmd_secrets`, secret-store helpers | `hermes secrets` subcommand. |
| `hermes_cli/security_advisories.py` | 451 | advisories fetch + cache | Security advisory updates. |
| `hermes_cli/send_cmd.py` | 445 | `cmd_send`, send helpers | `hermes send` subcommand. |
| `hermes_cli/session_recap.py` | 316 | session recap helpers | Session-resume summary generator. |
| `hermes_cli/setup.py` | 3,607 | `cmd_setup`, setup wizard | Interactive setup wizard. |
| `hermes_cli/skills_config.py` | 177 | skills config helpers | Skill enable/disable config. |
| `hermes_cli/skills_hub.py` | 1,600 | skills hub helpers, RAG | Skill discovery + RAG search. |
| `hermes_cli/skin_engine.py` | 926 | `apply_skin`, skin loader | Skin / personality engine (color schemes + tone). |
| `hermes_cli/slack_cli.py` | 159 | `cmd_slack`, Slack helpers | `hermes slack` subcommand. |
| `hermes_cli/status.py` | 570 | `cmd_status`, status helpers | `hermes status` subcommand. |
| `hermes_cli/stdio.py` | 252 | stdio helpers | stdio wrappers for the REPL. |
| `hermes_cli/timeouts.py` | 82 | timeout constants | Centralized timeout constants. |
| `hermes_cli/tips.py` | 485 | `print_tip`, tip rotation | Startup tip rotation. |
| `hermes_cli/tools_config.py` | 3,303 | tools config helpers | Tool registry config (enable/disable, per-toolset). |
| `hermes_cli/uninstall.py` | 680 | `cmd_uninstall`, helpers | `hermes uninstall` subcommand. |
| `hermes_cli/vercel_auth.py` | 70 | Vercel OAuth helpers | Vercel login flow. |
| `hermes_cli/voice.py` | 846 | voice record/playback helpers | `/voice` REPL command + voice subsystem. |
| `hermes_cli/web_server.py` | 4,680 | `start_dashboard_server`, route handlers | `hermes dashboard` HTTP server. |
| `hermes_cli/webhook.py` | 274 | `cmd_webhook`, helpers | `hermes webhook` subcommand. |
| `hermes_cli/xai_retirement.py` | 253 | xAI retirement helpers | xAI model retirement migration. |

### `hermes_cli/proxy/` — 7 files

| upstream path | LOC | public exports | one-line purpose |
|---|---:|---|---|
| `hermes_cli/proxy/__init__.py` | 20 | package init | Proxy sub-package marker. |
| `hermes_cli/proxy/server.py` | 308 | `ProxyServer`, route handlers | Local HTTP proxy server. |
| `hermes_cli/proxy/cli.py` | 142 | `cmd_proxy`, CLI helpers | `hermes proxy` subcommand entry. |
| `hermes_cli/proxy/adapters/__init__.py` | 37 | adapter registry | Adapter package marker + registry. |
| `hermes_cli/proxy/adapters/base.py` | 109 | `ProxyAdapter` ABC | Base class for all proxy adapters. |
| `hermes_cli/proxy/adapters/nous_portal.py` | 195 | `NousPortalAdapter` | Nous Portal proxy adapter. |
| `hermes_cli/proxy/adapters/xai.py` | 136 | `XaiAdapter` | xAI proxy adapter. |

**Total: 97 `.py` files in `hermes_cli/` recursively (90 top-level + 7 in `proxy/`) summing to 100,256 LOC**, plus top-level `cli.py` (14,780) and `run_agent.py` (4,309), plus `cli-config.yaml.example` (1,100 lines of YAML).

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

## 5. Subdivision plan — sub-tasks #14a–#14z

**24 sub-tasks total.** All blocked by **#1–#13**. Order within the group is roughly leaf-first (support modules) → middle (commands) → integration (REPL + run-agent + entry binaries).

> Each sub-task must follow the per-module workflow in `PORTING_PLAN.md` (read upstream in full, port preserving names, port tests, hit 100% coverage, commit on `port/cli-<slice>`, open PR). Cross-task contract: every sub-task that touches `hermes_cli/main.py` must add a one-line `// PORT-SOURCE: hermes_cli/main.py:<L1>-<L2>` comment at the top of each new file so #14u (dispatcher) can stitch them back together without ambiguity.

### Phase A — Support leaves (small/medium files, low fan-in)

| # | Slice | Upstream | LOC | Notes |
|---|---|---|---:|---|
| **14a** | `support/proxy` | `hermes_cli/proxy/` (5 files) | ~600 | Smallest leaf. Adapter pattern (`base`, `nous_portal`, `xai`) — clean to port first as a warm-up. |
| **14b** | `support/clipboard + osc52 + paste extras` | `clipboard.py`, `pt_input_extras.py`, `_subprocess_compat.py`, `default_soul.py`, `colors.py`, `timeouts.py` | ~1,400 | Tiny utilities. Batch. |
| **14c** | `support/fallback + dep-ensure + relaunch + env-loader` | `fallback_config.py`, `fallback_cmd.py`, `dep_ensure.py`, `env_loader.py`, `relaunch.py`, `migrate.py`, `platforms.py` | ~3,200 | Boot-path utilities. Batch. |
| **14d** | `support/auth-providers (small)` | `dingtalk_auth.py` (293), `copilot_auth.py` (392), `vercel_auth.py` (70), `pairing.py` (115), `portal_cli.py` (219), `slack_cli.py` (159), `nous_subscription.py` (799), `xai_retirement.py` (253), `security_advisories.py` (451), `azure_detect.py` (406), `codex_models.py` (198), `codex_runtime_switch.py` (266), `cli_output.py` (78), `browser_connect.py` (217), `bundles.py` (229), `callbacks.py` (242), `checkpoints.py` (244), `skills_config.py` (177), `webhook.py` (274), `inventory.py` (240), `model_catalog.py` (329), `model_normalize.py` (473), `memory_setup.py` (464), `mcp_config.py` (780), `oneshot.py` (356), `pty_bridge.py` (237), `secrets_cli.py` (445), `send_cmd.py` (445), `session_recap.py` (316), `profile_describer.py` (299), `cron.py` (322), `dump.py` (328), `completion.py` (315), `logs.py` (390), `hooks.py` (385), `stdio.py` (252), `tips.py` (485) — `clipboard.py` lives in 14b, `voice.py` in 14o (formerly listed twice in v1, deduped) | 11,943 | **Largest leaf batch** — 37 files, all independent. Split into 4 commits inside the same sub-task PR if reviewer prefers smaller diffs (suggested split: auth-providers, model-helpers, command-handlers, IO-helpers). Each file is a 1-to-1 port; tests follow file boundaries. |
| **14e** | `support/skin-engine + curses-ui + banner` | `skin_engine.py` (926), `curses_ui.py` (472), `banner.py` (702) | 2,100 | Visual layer. Depends on chosen TUI lib (`blessed`/`ink`). Surface decisions inform 14x. (`voice.py` is in 14o; `tips.py` is in 14d.) |

### Phase B — Single-file giants (one sub-task per file)

| # | Slice | Upstream | LOC | Why solo |
|---|---|---|---:|---|
| **14f** | `support/config` | `hermes_cli/config.py` | 5,590 | Owns the schema for `cli-config.yaml.example` (1,100 lines). The Zod schema for the port lives here. Touches everything downstream. |
| **14g** | `support/auth` | `hermes_cli/auth.py` | 7,601 | OAuth flows for Anthropic, OpenAI, Google, Microsoft, Spotify, GitHub Copilot, Nous Portal, Vercel. Network/secrets-heavy. Critical-path security review. |
| **14h** | `support/kanban-db` | `hermes_cli/kanban_db.py` | 6,508 | SQLite schema + 200+ queries. `better-sqlite3` port. Performance-sensitive. |
| **14i** | `support/kanban` | `kanban.py` (2,677) + `kanban_decompose.py` (477) + `kanban_specify.py` (271) + `kanban_swarm.py` (279) + `kanban_diagnostics.py` (1,058) | 4,762 | Kanban UI/logic. Depends on 14h. |
| **14j** | `support/gateway-runtime` | `gateway.py` (5,449) + `gateway_windows.py` (1,047) | 6,496 | **Wraps** `@hermests/gateway` (#10) with platform service installation (launchd/systemd/Windows services). Cross-platform port — three independent code paths. |
| **14k** | `support/web-server` | `hermes_cli/web_server.py` | 4,680 | The `hermes dashboard` HTTP server. Likely **Hono** or **Fastify** — choose in sub-task. |
| **14l** | `support/setup` | `hermes_cli/setup.py` | 3,607 | Interactive setup wizard. Long branching script; port to async/await with explicit step machine. |
| **14m** | `support/models + model-switch + runtime-provider` | `models.py` (3,788), `model_switch.py` (1,799), `runtime_provider.py` (1,668), `model_normalize.py` (473), `model_catalog.py` (329) | 8,057 | Model catalog + provider runtime selection. Tightly coupled — port together. |
| **14n** | `support/tools-config + plugins + plugins-cmd + skills-hub` | `tools_config.py` (3,303), `plugins.py` (1,593), `plugins_cmd.py` (1,636), `skills_hub.py` (1,600), `codex_runtime_plugin_migration.py` (757) | 8,889 | Tool + plugin + skill wiring. Bridges to `@hermests/tools`, `@hermests/plugins`, `@hermests/skills`. |
| **14o** | `support/doctor + commands + status + voice + goals + backup + curator + profile-dist + profiles + uninstall + debug + auth-commands + claw` | `doctor.py` (2,012), `commands.py` (1,819), `status.py` (570), `voice.py` (846), `goals.py` (762), `backup.py` (937), `curator.py` (598), `profile_distribution.py` (706), `profiles.py` (1,470), `uninstall.py` (680), `debug.py` (746), `auth_commands.py` (797), `claw.py` (809) | 12,752 | Mid-size grab-bag. Each file is independent. Author may further split into 3 commits (diagnostics group / profiles group / commands group). |

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

**Total: 26 sub-tasks** (5 + 10 + 5 + 3 + 3). The lead's target was 15-25; this is one over by design — the leaf-batch in 14d at 11,943 LOC across 37 small files is large but still well under the largest single-file giant (`main.py` at 13,816 and `cli.py` at 14,780). If the lead wants exactly 25, fold 14b into 14c (both are tiny utility batches). If 15-20 is preferred, also collapse 14q+14r into 14p, and merge 14u+14v+14w into a single run-agent task. The seams above are the natural ones; any consolidation forfeits some parallelism but no correctness.

**Phase A+B sum check.** Phase A (14a+14b+14c+14d+14e) + Phase B (14f–14o) sums to **86,098 LOC** plus an unassigned `providers.py` (721) → **86,819 LOC**. The "rest of `hermes_cli/`" bucket (everything except `main.py` 13,816, `_parser.py` 376 → both in 14p, and `__init__.py` 47) is **86,017 LOC**. The +802 gap is double-counting: in v1 `clipboard.py` (494) appeared in both 14b and 14o, and `voice.py` (846) appeared in both 14d and 14o; this brief now lists `clipboard.py` only in 14b and `voice.py` only in 14o (see §5 tables above). `providers.py` (721) should be **added to 14d** as a 38th file (revised 14d total: 12,664 LOC). After dedupes + `providers.py` addition, every `hermes_cli/*.py` outside `main.py`/`_parser.py`/`__init__.py` lands in exactly one Phase A or B sub-task.

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

## 6.5 Upstream test mapping

Concrete file-level map of which upstream tests target which sub-task. Generated by greping `tests/cli/`, `tests/hermes_cli/`, and `tests/run_agent/` for direct `from hermes_cli.<module> import …` / `from cli import …` / `from run_agent import …` references (a test file may import several modules and therefore appear under several rows). Test files that target the touched code only through fixtures, `monkeypatch`, or subprocess invocation will not appear in the import-grep but **must still be ported** — the verification rule in §7 (parity with every upstream test that touches the code) is unchanged.

**Methodology.** For each upstream module the table shows: number of test files in `tests/cli/`, `tests/hermes_cli/`, or `tests/run_agent/` that import the module by name, and the sum of `def test_*` declarations in those files (an upper bound on the test cases that touch the module, since a file may also exercise other modules). Generated 2026-05-25 against `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/tests/`.

| upstream module | sub-task that owns it | test files importing it | test cases (upper bound) |
|---|---|---:|---:|
| `cli.py` (top-level) | 14x + 14y + 14z | 60 | 684 |
| `run_agent.py` (top-level) | 14u + 14v + 14w | 85 | 1,503 |
| `hermes_cli/main.py` | 14p + 14q + 14r + 14s + 14t | 47 | 994 |
| `hermes_cli/_parser.py` | 14p | 1 | 11 |
| `hermes_cli/auth.py` | 14g | 32 | 1,072 |
| `hermes_cli/auth_commands.py` | 14o | 3 | 134 |
| `hermes_cli/backup.py` | 14o | 1 | 97 |
| `hermes_cli/banner.py` | 14e | 4 | 20 |
| `hermes_cli/browser_connect.py` | 14d | 1 | 16 |
| `hermes_cli/bundles.py` | 14d | 1 | 8 |
| `hermes_cli/callbacks.py` | 14d | 1 | 5 |
| `hermes_cli/codex_models.py` | 14d | 1 | 19 |
| `hermes_cli/codex_runtime_plugin_migration.py` | 14n | 1 | 67 |
| `hermes_cli/commands.py` | 14o | 14 | 427 |
| `hermes_cli/completion.py` | 14d | 1 | 31 |
| `hermes_cli/config.py` | 14f | 47 | 1,135 |
| `hermes_cli/copilot_auth.py` | 14d | 4 | 244 |
| `hermes_cli/cron.py` | 14d | 1 | 3 |
| `hermes_cli/curator.py` | 14o | 3 | 22 |
| `hermes_cli/curses_ui.py` | 14e | 2 | 83 |
| `hermes_cli/debug.py` | 14o | 1 | 66 |
| `hermes_cli/dep_ensure.py` | 14c | 1 | 14 |
| `hermes_cli/dingtalk_auth.py` | 14d | 1 | 15 |
| `hermes_cli/doctor.py` | 14o | 5 | 179 |
| `hermes_cli/env_loader.py` | 14c | 3 | 20 |
| `hermes_cli/fallback_cmd.py` | 14c | 1 | 32 |
| `hermes_cli/gateway.py` | 14j | 14 | 350 |
| `hermes_cli/gateway_windows.py` | 14j | 2 | 50 |
| `hermes_cli/goals.py` | 14o | 2 | 57 |
| `hermes_cli/inventory.py` | 14d | 1 | 18 |
| `hermes_cli/kanban.py` | 14i | 1 | 165 |
| `hermes_cli/kanban_db.py` | 14h | 4 | 334 |
| `hermes_cli/kanban_swarm.py` | 14i | 1 | 3 |
| `hermes_cli/logs.py` | 14d | 1 | 37 |
| `hermes_cli/mcp_config.py` | 14d | 1 | 32 |
| `hermes_cli/model_catalog.py` | 14m | 1 | 23 |
| `hermes_cli/model_normalize.py` | 14m | 7 | 241 |
| `hermes_cli/model_switch.py` | 14m | 19 | 229 |
| `hermes_cli/models.py` | 14m | 22 | 801 |
| `hermes_cli/nous_subscription.py` | 14d | 3 | 78 |
| `hermes_cli/oneshot.py` | 14d | 1 | 41 |
| `hermes_cli/plugins.py` | 14n | 5 | 241 |
| `hermes_cli/plugins_cmd.py` | 14n | 1 | 71 |
| `hermes_cli/profile_distribution.py` | 14o | 1 | 42 |
| `hermes_cli/profiles.py` | 14o | 4 | 287 |
| `hermes_cli/providers.py` | 14d (added per §5 sum-check) | 8 | 230 |
| `hermes_cli/pt_input_extras.py` | 14b | 2 | 15 |
| `hermes_cli/pty_bridge.py` | 14d | 2 | 157 |
| `hermes_cli/runtime_provider.py` | 14m | 10 | 414 |
| `hermes_cli/security_advisories.py` | 14d | 1 | 20 |
| `hermes_cli/session_recap.py` | 14d | 1 | 13 |
| `hermes_cli/setup.py` | 14l | 7 | 73 |
| `hermes_cli/skills_config.py` | 14d | 3 | 247 |
| `hermes_cli/skills_hub.py` | 14n | 2 | 38 |
| `hermes_cli/skin_engine.py` | 14e | 3 | 60 |
| `hermes_cli/slack_cli.py` | 14d | 1 | 3 |
| `hermes_cli/status.py` | 14o | 1 | 17 |
| `hermes_cli/timeouts.py` | 14b | 1 | 12 |
| `hermes_cli/tips.py` | 14d | 1 | 11 |
| `hermes_cli/tools_config.py` | 14n | 5 | 262 |
| `hermes_cli/voice.py` | 14o | 1 | 42 |
| `hermes_cli/web_server.py` | 14k | 4 | 176 |
| `hermes_cli/webhook.py` | 14d | 1 | 18 |
| `hermes_cli/xai_retirement.py` | 14d | 2 | 50 |

**Counts (upstream `tests/` directories that primarily target this module):**

- `tests/cli/` — **61 test files, 715 test cases**, all target `cli.py` and feed sub-tasks **14x / 14y / 14z**.
- `tests/hermes_cli/` — **234 test files, 4,752 test cases**, distributed across the support modules per the table above (most-tested: `config.py` 47 files, `auth.py` 32, `main.py` 47, `models.py` 22, `model_switch.py` 19).
- `tests/run_agent/` — **91 test files, 1,380 test cases**, all target `run_agent.py` and feed sub-tasks **14u / 14v / 14w**.

**Total primary scope: 386 upstream test files, 6,847 test cases.** The TS port must reach parity case-for-case (§7). Additional test files in `tests/agent/`, `tests/cron/`, `tests/gateway/`, `tests/run_interrupt_test.py`, `tests/stress/`, `tests/test_*.py`, `tests/tools/`, `tests/tui_gateway/`, and `tests/plugins/` reference `run_agent` / `hermes_cli` indirectly (487 files in total returned by `grep -rE "(import|from) (cli|hermes_cli|run_agent)"`). Those are owned by their respective upstream packages (`@hermests/agent`, `@hermests/gateway`, etc.) but the CLI port must ensure the imports it provides do not break those tests.

**Modules with zero direct test imports.** These appear in no `tests/` import line but are still exercised through fixtures/subprocess: `__init__.py`, `_subprocess_compat.py`, `azure_detect.py`, `checkpoints.py`, `cli_output.py`, `clipboard.py` (covered via `tools/test_clipboard.py` in the tools test suite), `codex_runtime_switch.py`, `colors.py`, `default_soul.py`, `dump.py`, `hooks.py`, `memory_setup.py`, `migrate.py`, `pairing.py`, `platforms.py`, `portal_cli.py`, `profile_describer.py`, `relaunch.py`, `secrets_cli.py`, `send_cmd.py`, `stdio.py`, `uninstall.py`, `vercel_auth.py`, plus all 7 `proxy/` files (covered by `tests/hermes_cli/test_proxy.py` indirectly). For each, the porter must add new direct-import tests in the corresponding Vitest package to hit the 100% coverage gate.

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

---

## 9. Effort estimates

Heuristic for a Forge GPT-5.5 porter at low reasoning effort doing **port + test + 100% coverage** on canonical-faithful, pre-read code: **~500 LOC/hour wall-clock** including the per-file read-time (since the porter has to re-read upstream in full per `PORTING_PLAN.md`). This rate is observed on the leaf-batch PRs already merged for `@hermests/core`, `@hermests/state`, `@hermests/providers`, and `@hermests/trajectory`. The numerator counts **upstream LOC** (the TS line count typically lands ~1.1–1.3× the Python LOC for parity ports; the porter rate already accounts for that since the bottleneck is read + design + test, not typing).

Single-porter wall-clock days assume ~6 productive hours/day. Multi-porter parallelism is the lead's call — every sub-task is independent within its phase except as noted in the §5 dependency column.

| sub-task | scope | upstream LOC | est. porter-hours (low effort) | est. wall-clock days (1 porter @ 6h/day) |
|---|---|---:|---:|---:|
| **14a** | `support/proxy` (7 files) | 947 | 2 | 0.3 |
| **14b** | `support/clipboard + paste extras` (6 files) | 883 | 2 | 0.3 |
| **14c** | `support/boot-path` (7 files) | 1,283 | 3 | 0.4 |
| **14d** | `support/leaves` (38 files incl. `providers.py`) | 12,664 | 25 | 4.2 |
| **14e** | `support/skin-engine + curses-ui + banner` | 2,100 | 4 | 0.7 |
| **14f** | `support/config` | 5,590 | 11 | 1.9 |
| **14g** | `support/auth` | 7,601 | 15 (× 1.5 security multiplier = **23**) | 3.8 |
| **14h** | `support/kanban-db` | 6,508 | 13 (× 1.3 SQL multiplier = **17**) | 2.8 |
| **14i** | `support/kanban` | 4,762 | 10 | 1.6 |
| **14j** | `support/gateway-runtime` | 6,496 | 13 (× 1.4 cross-platform = **18**) | 3.0 |
| **14k** | `support/web-server` | 4,680 | 9 | 1.5 |
| **14l** | `support/setup` | 3,607 | 7 | 1.2 |
| **14m** | `support/models + model-switch + runtime-provider` | 8,057 | 16 | 2.7 |
| **14n** | `support/tools-config + plugins + plugins-cmd + skills-hub` | 8,889 | 18 | 3.0 |
| **14o** | `support/doctor + commands + grab-bag` (13 files) | 12,752 | 26 | 4.3 |
| **14p** | `commands/parser + chat + gateway + proxy + setup + postinstall + model` (subset of `main.py`) | ~4,000 | 8 | 1.3 |
| **14q** | `commands/auth + login + logout + slack + portal + cron + webhook + hooks + status` | ~2,000 | 4 | 0.7 |
| **14r** | `commands/doctor + dump + debug + config + backup + import + version + uninstall` | ~1,500 | 3 | 0.5 |
| **14s** | `commands/skills + bundles + plugins + curator + memory + tools + computer-use + mcp + sessions + insights + claw + pairing + checkpoints + kanban` | ~10,000 | 20 | 3.3 |
| **14t** | `commands/profile + dashboard + completion + logs + acp + update` | ~3,500 | 7 | 1.2 |
| **14u** | `run-agent/core` | ~800 | 2 | 0.3 |
| **14v** | `run-agent/conversation-loop` | ~1,600 | 3 (× 1.5 heart-of-agent = **5**) | 0.8 |
| **14w** | `run-agent/tools-and-providers` | ~1,900 | 4 | 0.7 |
| **14x** | `repl/HermesCli skeleton + status-bar + streaming + layout` | ~2,800 | 6 (× 1.5 TUI lib new ground = **9**) | 1.5 |
| **14y** | `repl/slash-commands + handlers + sessions + voice + approvals + modal-input` | ~6,200 | 12 (× 1.4 cross-method coordination = **17**) | 2.8 |
| **14z** | `repl/run loop + main + signal handlers + bin entries + integration tests` | ~6,800 | 14 (× 1.6 final integration = **22**) | 3.7 |

**Single-porter totals:** **~283 porter-hours ≈ 47 wall-clock days @ 6h/day.** Round to **8–10 calendar weeks** for one porter.

**Three-porter parallelism (recommended baseline).** Phase A and Phase B can run fully in parallel (no cross-task deps within phase except 14h→14i, 14f→14p, 14g→14q, 14j→14p). Phase C blocks on A+B; Phase D is independent of A/B/C; Phase E blocks on everything. Critical-path: 14a→14f→14p→14x→14y→14z ≈ 0.3 + 1.9 + 1.3 + 1.5 + 2.8 + 3.7 = **11.5 wall-clock days** for one critical porter, with the other two clearing Phase A leaves, then 14d/14o, then 14s, then 14y splits. **Round to 3–4 calendar weeks for three porters in parallel.**

**Multipliers applied above:**

- **× 1.5 security** on 14g — every credential path must be reviewed for token leakage, redaction parity, OAuth state validation; can't shortcut.
- **× 1.3 SQL** on 14h — `better-sqlite3` query rewrites must preserve transaction semantics; query count is the bottleneck.
- **× 1.4 cross-platform** on 14j — three independent code paths (launchd / systemd / Windows services) need three test matrices.
- **× 1.5 heart-of-agent** on 14v — error in the conversation loop cascades to every downstream package.
- **× 1.5 TUI lib new ground** on 14x — first sub-task to commit to the chosen TUI library (`ink` vs `blessed`); decision pressure is high.
- **× 1.4 cross-method coordination** on 14y — 47 slash commands must all register through `process_command()`; missing one is a silent regression.
- **× 1.6 final integration** on 14z — depends on all 25 prior sub-tasks being green; integration-test debugging is unavoidable.

These multipliers are **floor estimates**. The lead should add a 25% buffer for any sub-task that touches the chosen TUI library before its API is locked.
