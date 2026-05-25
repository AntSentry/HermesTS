# Port Brief — `@hermests/tui-gateway`

Upstream module: `tui_gateway/` (8 files, ~7,670 LOC). Blocks task #11. This is the second-largest module in the port after `cli` and is far more concentrated than the file count suggests: one file (`server.py`, 6,771 LOC, 68 JSON-RPC handlers) accounts for 88% of the LOC and contains the dispatch table, agent factory, session machinery, slash-worker bridge, and every long-running RPC.

## 1. Module summary

`tui_gateway` is the JSON-RPC bridge between the Ink-based TUI frontend (`ui-tui/`) and the rest of Hermes (`agent`, `tools`, `gateway`, `hermes_cli`). The frontend speaks newline-delimited JSON-RPC 2.0 over stdio (production path: `tui_gateway.entry`) or over a FastAPI WebSocket (dashboard sidebar path: `tui_gateway.ws`). Every TUI feature — sending a prompt, switching models, running a `/slash` command, attaching an image, voice mode, browser control, config editing, MCP reload — funnels through 68 `@method("…")`-registered handlers in `server.py`. The module also runs a persistent per-session `slash_worker` subprocess (a full `HermesCLI` instance) so slash commands execute in a long-lived Python interpreter rather than spawning a fresh process per command.

Three cross-cutting properties shape the port:

1. **Transport-agnostic dispatch.** `server.dispatch(req, transport)` accepts any object implementing the `Transport` protocol (`write(dict) -> bool`, `close()`). Stdio (`StdioTransport`), WebSocket (`WSTransport`), and tee (`TeeTransport` — primary + best-effort secondaries) are all implementations. The active transport is held in a `contextvars.ContextVar` so handlers dispatched onto a worker thread pool can still write back to the right peer. Async events on a session also resolve via `_sessions[sid]["transport"]` so emits from background threads land on the correct client.
2. **Long-handler thread pool.** A frozenset `_LONG_HANDLERS` (8 methods: `browser.manage`, `cli.exec`, `session.branch`, `session.compress`, `session.resume`, `shell.exec`, `skills.manage`, `slash.exec`) is routed onto a small `ThreadPoolExecutor` (`HERMES_TUI_RPC_POOL_WORKERS`, default 4) so that the inbound RPC loop in `entry.py` never blocks on a slow handler — without this, `approval.respond` and `session.interrupt` would sit unread in the stdin pipe while a slash command ran.
3. **Side-channel emit policy.** Three kinds of writes coexist on the wire: synchronous JSON-RPC responses (returned by handlers), async events keyed to a session (`_emit("session.info", sid, …)`), and best-effort dashboard mirroring via `TeeTransport` to a back-WS at `HERMES_TUI_SIDECAR_URL`. `write_json` resolves the most specific transport for each frame (session-bound > current contextvar > module-level stdio).

## 2. File inventory

| File | LOC | Role |
|---|---:|---|
| `tui_gateway/__init__.py` | 0 | Empty package marker. |
| `tui_gateway/render.py` | 49 | Optional bridge to `agent.rich_output` (`format_response`, `render_diff`, `StreamingRenderer`). Returns `None` when the renderer module is missing — TUI then falls back to its own `markdown.tsx`. |
| `tui_gateway/slash_worker.py` | 76 | `python -m tui_gateway.slash_worker` subprocess entry. Wraps `HermesCLI.process_command` with stdout/stderr redirection so its print output is captured to a `Rich.Console` buffer and returned as a structured response over its own stdin/stdout JSON-line protocol. |
| `tui_gateway/event_publisher.py` | 126 | `WsPublisherTransport` — daemon-thread, queue-backed (`_QUEUE_MAX=256`), drop-on-full WebSocket publisher used by `TeeTransport` to mirror dispatcher emits to the dashboard sidebar. Designed never to stall the agent loop. |
| `tui_gateway/ws.py` | 178 | `handle_ws(ws)` — FastAPI/Starlette WebSocket session handler. Reuses `server.dispatch` verbatim; `WSTransport.write()` marshals onto the owning event loop via `asyncio.run_coroutine_threadsafe` (with a 10s timeout) when called from a pool worker, and uses `loop.create_task` when called from the loop thread itself to avoid self-deadlock. Drops the session's transport binding on disconnect, falling back to stdio. |
| `tui_gateway/transport.py` | 219 | `Transport` Protocol, `StdioTransport` (lock-guarded, peer-gone errno set on write/flush, `HERMES_TUI_GATEWAY_NO_FLUSH` escape hatch), `TeeTransport` (primary + secondaries with swallowed secondary failures), `current_transport()` / `bind_transport()` / `reset_transport()` contextvar helpers. |
| `tui_gateway/entry.py` | 251 | `python -m tui_gateway.entry` stdio main. Strips local CWD shadowing from `sys.path`, redirects Python's stdout to stderr (reserves real stdout for JSON-RPC frames), installs SIGPIPE-ignore + SIGTERM/SIGHUP/SIGINT/SIGBREAK signal handlers that crash-log thread stacks + force `os._exit(0)` after a configurable grace period (`HERMES_TUI_GATEWAY_SHUTDOWN_GRACE_S`, default 1.0s), conditionally enables the WS sidecar publisher, emits `gateway.ready`, then runs the stdin → `dispatch` → stdout loop. |
| `tui_gateway/server.py` | 6,771 | Everything else: dispatch table (68 methods), agent factory + lazy build, session lifecycle, history compression with `history_version` guards, slash worker pool, transport routing, config I/O with mtime caching, model switching, voice/TTS, browser CDP probing, completion (path/slash), checkpoints/rollback, notification poller, image attachments. |

## 3. Internal dep graph (within `tui_gateway/`)

```
entry.py ─┬─► server.py (dispatch, write_json, resolve_skin, _CRASH_LOG, _stdio_transport, _sessions)
          └─► transport.py (TeeTransport)
          └─► event_publisher.py (WsPublisherTransport)  [conditional, sidecar mode]

ws.py ──────► server.py (dispatch, resolve_skin, _sessions, _stdio_transport)
          └─► transport.py (Transport ABC implied)
          └─► [imports inside handler] agent.async_utils.safe_schedule_threadsafe

server.py ──► transport.py (StdioTransport, Transport, bind_transport, current_transport, reset_transport)
          └─► render.py (make_stream_renderer, render_diff, render_message)
          └─► slash_worker.py [via subprocess.Popen of "-m tui_gateway.slash_worker"]

slash_worker.py ──► cli.HermesCLI (NOT a tui_gateway internal; runs in subprocess)
```

There are no cycles. `transport.py` and `render.py` are leaves. `server.py` is the hub; `entry.py` and `ws.py` are thin transport-adapter shells around it.

## 4. External dep graph

By upstream module (alphabetised; bracketed items are lazy/optional inside handler bodies):

- `agent.*` — `agent.async_utils.safe_schedule_threadsafe` (ws.py), `agent.context_references`, `agent.display`, `agent.image_routing`, `agent.manual_compression_feedback`, `agent.model_metadata`, `agent.redact`, `agent.rich_output` (render.py), `agent.skill_commands`, `agent.tool_dispatch_helpers`, `agent.usage_pricing`, `agent.auxiliary_client`.
- `cli` — `HermesCLI`, `load_cli_config` (server + slash_worker).
- `gateway.session_context` — `set_session_vars`, `clear_session_vars`.
- `hermes_cli.*` — `__version__`, `__release_date__`, `banner` (prefetch_update_check, get_available_skills, get_update_result), `config` (load_config, save_config, save_env_value_secure, read_raw_config, get_compatible_custom_providers, recommended_update_command), `env_loader.load_hermes_dotenv`, `model_switch.{parse_model_flags, switch_model}`, `models.detect_static_provider_for_model`, `plugins.{invoke_hook, discover_plugins}`, `profiles.get_active_profile_name`, `runtime_provider.resolve_runtime_provider`, `skin_engine.{init_skin_from_config, get_active_skin}`, `tools_config.{_get_platform_tools, _parse_enabled_flag}`.
- `hermes_constants` — `get_hermes_home`, `display_hermes_home`, `parse_reasoning_effort`.
- `hermes_state` — `SessionDB` (`get_session`, `get_session_by_title`, `get_session_title`, `set_session_title`, `get_next_title_in_lineage`, `get_messages`, `get_messages_as_conversation`, `list_sessions_rich`, `reopen_session`, `create_session`, `delete_session`, `end_session`).
- `model_tools` — `get_toolset_for_tool`.
- `run_agent` — `AIAgent` (instantiated by `_make_agent`; called from multiple handlers including `prompt.submit`, `session.compress`, `session.resume`, `session.branch`).
- `tools.*` — `tools.approval` (register_gateway_notify, unregister_gateway_notify, set_current_session_key, reset_current_session_key, enable/disable/is_session_yolo_enabled, load_permanent_allowlist), `tools.mcp_tool` (discover_mcp_tools, get_mcp_status), `tools.process_registry` (process_registry, format_process_notification), `tools.skills_tool.set_secret_capture_callback`, `tools.terminal_tool.{set_sudo_password_callback, register_task_env_overrides}`, `tools.vision_tools.vision_analyze_tool`.
- `toolsets` — `validate_toolset`.
- `utils.{is_truthy_value, atomic_json_write}`.
- 3rd-party: `PIL.Image` (image metadata, lazy), `rich.console.Console` (slash_worker), `starlette.websockets.WebSocketDisconnect` (ws.py, optional), `websockets.sync.client.connect` (event_publisher.py, optional), `yaml` (config I/O, lazy).

## 5. Tricky upstream constructs

These are the load-bearing details a faithful TS port must reproduce. Missing any of them silently corrupts behaviour rather than failing loudly.

- **`history_version` optimistic-concurrency on session history.** Every mutation snapshots `history_version` under `session["history_lock"]`, runs the (possibly long, LLM-bound) work *without* holding the lock, then re-acquires the lock and only commits if the version still matches. `_compress_session_history` and `prompt.submit`'s post-run write both do this. Without it, `/undo` + `/compress` + a streaming turn can clobber each other. Port must preserve the lock-release-during-LLM pattern, not "simplify" by holding the lock throughout.
- **`session_key` vs `agent.session_id` divergence after compression.** `AIAgent._compress_context` ends the current `SessionDB` session and rotates `agent.session_id`. The gateway-side `session["session_key"]` is used for approval routing, slash worker init, DB title/history lookups, and yolo state. `_sync_session_key_after_compress(sid, session, clear_pending_title=…, restart_slash_worker=…)` re-anchors `session_key`, migrates the yolo flag, re-registers the approval callback, and (optionally) restarts the slash worker. Called from both `/compress` and the post-turn auto-compression branch in `prompt.submit`. Skipping this means writes silently target the dead parent session row.
- **Transport contextvar binding.** `dispatch` calls `bind_transport(t)` *before* `handle_request`, captures `contextvars.copy_context()` for pool-bound handlers, and runs the worker via `ctx.run(run)` so the bound transport is visible to writes from inside the handler. The `write_json` precedence chain is **session.transport → contextvar → module-level stdio**. Async events from background threads (e.g. `_notification_poller_loop`) rely on the session-bound transport because they have no contextvar binding. A port that re-implements this in a "current request" global will break dashboard-WS sessions.
- **`WSTransport.write` deadlock guard.** When called from a pool worker (thread A, not the loop), it must marshal onto the loop via `asyncio.run_coroutine_threadsafe` + `fut.result(timeout=10s)`. When called from the loop thread itself (e.g. by `handle_ws` writing an inline response), the same call would deadlock the loop on itself — the port detects `asyncio.get_running_loop() is self._loop` and switches to fire-and-forget `loop.create_task`. Both code paths must exist.
- **`StdioTransport` peer-gone errno set.** Returning `False` is the dispatcher's "broken stdout pipe → `sys.exit(0)`" signal. Only `BrokenPipeError`, `ValueError("…closed file…")` (excluding `UnicodeEncodeError`, which is a `ValueError` subclass), and `OSError` whose `errno` is in `_PEER_GONE_ERRNOS` ({EPIPE, ECONNRESET, EBADF, ESHUTDOWN, WSAECONNRESET, WSAESHUTDOWN}) return `False`. Anything else (ENOSPC, EACCES, encoding bugs) re-raises so the panic hook records the trace. Conflating these makes real host bugs look like clean disconnects.
- **`_LONG_HANDLERS` frozenset.** The exact 8 method names that route to the thread pool are: `browser.manage`, `cli.exec`, `session.branch`, `session.compress`, `session.resume`, `shell.exec`, `skills.manage`, `slash.exec`. Adding or removing one changes the system: a fast handler on the pool wastes a worker; a slow handler not on the pool blocks `approval.respond`.
- **Signal handlers in `entry.py`.** SIGPIPE → SIG_IGN (so a TUI half-closed pipe raises `BrokenPipeError` on the next write rather than killing the process silently from a background TTS thread); SIGTERM/SIGHUP/SIGINT → `_log_signal` which crash-logs *every* thread's stack, schedules a daemon timer for `os._exit(0)` after `HERMES_TUI_GATEWAY_SHUTDOWN_GRACE_S` seconds, then `sys.exit(0)`. The hard-exit timer is essential — a pool worker holding `_stdout_lock` mid-flush can otherwise block the interpreter shutdown indefinitely. Windows: SIGPIPE/SIGHUP don't exist; install SIGBREAK as the SIGHUP analog. Every `hasattr(signal, …)` guard must be preserved.
- **`_panic_hook` + `_thread_panic_hook`.** `sys.excepthook` and `threading.excepthook` both write to `~/.hermes/logs/tui_gateway_crash.log` *and* emit a one-line summary to stderr (which the TUI surfaces as `gateway.stderr` activity). Without these, voice-mode crashes look like phantom exits — stdout is the JSON-RPC pipe, so stack traces never reach the user.
- **`sys.stdout = sys.stderr` reservation.** At import time, `server.py` saves `_real_stdout = sys.stdout` and reassigns `sys.stdout = sys.stderr`. Any stray `print()` from libraries thus becomes harmless `gateway.stderr` instead of corrupting the JSON-RPC stream on real stdout. `StdioTransport` resolves the stream lazily via a `lambda: _real_stdout` so test monkey-patches of `_real_stdout` still take effect.
- **Notification poller chains a turn.** `_notification_poller_loop` polls `process_registry.completion_queue` every 500ms; when an event arrives *and* the session is idle, it grabs `session["running"]`, emits `message.start`, and calls `_run_prompt_submit` itself — i.e. background processes can autonomously kick off an agent turn. The completion queue is global (one per process), so with multiple TUI sessions whichever poller wakes first claims the event. The drain loop on shutdown processes all pending events before exiting.
- **Slash worker is a full `HermesCLI` subprocess.** `_SlashWorker` spawns `python -m tui_gateway.slash_worker --session-key … --model …`, communicates over `{id, command}` / `{id, ok, output|error}` line-protocol with a per-request lock, has separate stdout/stderr drain threads, and is timed out via `_SLASH_WORKER_TIMEOUT_S` (`max(5, HERMES_TUI_SLASH_TIMEOUT_S)`). The worker swaps the `Rich.Console` file to an in-memory `StringIO` and monkey-patches `cli._cprint` so `self.console.print()` is captured. The TS port either needs a long-lived Node child running the ported `HermesCLI` (which doesn't exist yet at this stage), or has to delegate slash-command execution to whichever shape of "CLI core" the ported `cli` package exposes.
- **`_install_sidecar_publisher` is conditional on env.** Only activated when `HERMES_TUI_SIDECAR_URL` is set (by `web_server.py`'s `/api/pty`). When active, it wraps `server._stdio_transport` in a `TeeTransport(stdio, WsPublisherTransport(url))` — every dispatcher emit is mirrored to the dashboard sidebar best-effort. Test coverage requires both modes (sidecar on, sidecar off) since the wrapping changes which transport is the module default for the rest of the process lifetime.
- **MCP cold-start guard in `entry.main`.** Importing `tools.mcp_tool` transitively pulls the full MCP SDK (~200ms on macOS). `entry.main` first checks `read_raw_config()["mcp_servers"]` and only calls `discover_mcp_tools()` if at least one server is configured. Conservative fallback (`_has_mcp_servers = True`) when the config can't be read. The port must replicate this; eagerly importing the MCP package on every TUI start regresses cold-start by hundreds of milliseconds.
- **`_DETAIL_SECTION_NAMES` / `_DETAIL_MODES` schemas mirror Ink TypeScript.** `_DETAIL_SECTION_NAMES = ("thinking", "tools", "subagents", "activity")`, `_DETAIL_MODES = {"hidden", "collapsed", "expanded"}`, `_INDICATOR_STYLES = ("ascii", "emoji", "kaomoji", "unicode")`, `_STATUSBAR_MODES = {"off", "top", "bottom"}`, `_MOUSE_TRACKING_ALIASES`. The companion validation in `ui-tui/src/app/interfaces.ts` must agree — drift between Python and TS values is a silent rendering bug.
- **Personality switching preserves the prompt cache.** `_apply_personality_to_session` writes to `agent.ephemeral_system_prompt` (appended at API-call time) rather than rebuilding `_cached_system_prompt`, which preserves prompt-cache hits across the personality change. It also injects a system-role marker into history so the model sees a pivot point. The port that "just rebuilds the system prompt" silently invalidates caching and changes provider billing.

## 6. Upstream test mapping

| Upstream test file | LOC | Tests | What it covers | TS port destination |
|---|---:|---:|---|---|
| `tests/test_tui_gateway_server.py` | 4,908 | 181 | The bulk — covers most of the 68 method handlers, session lifecycle, history compression w/ version guards, slash worker lifecycle, transport routing, config I/O, model switching, completion, notification poller, image attachments, voice toggle. | Split across the three sub-task TS test files below — by handler family. |
| `tests/tui_gateway/test_protocol.py` | 806 | 44 | JSON-RPC protocol shape — request/response/error envelopes, batch, parse-error path, transport contract. | `packages/tui-gateway/tests/protocol.test.ts` (sub-task #11a). |
| `tests/tui_gateway/test_goal_command.py` | 196 | 11 | `/goal` slash command end-to-end via slash worker. | `packages/tui-gateway/tests/slash-worker.test.ts` (sub-task #11b). |
| `tests/tui_gateway/test_make_agent_provider.py` | 235 | 7 | `_make_agent` provider/runtime resolution — env-var precedence, static provider detection, custom providers. | `packages/tui-gateway/tests/agent-factory.test.ts` (sub-task #11b). |
| `tests/tui_gateway/test_entry_sys_path.py` | 101 | 4 | `entry.py` path-shadowing guards (`HERMES_PYTHON_SRC_ROOT` insert, strip of `''` and `'.'`). | `packages/tui-gateway/tests/entry.test.ts` (sub-task #11a). |
| `tests/tui_gateway/test_render.py` | 67 | 7 | `render.py` fallbacks when `agent.rich_output` missing or raises. | `packages/tui-gateway/tests/render.test.ts` (sub-task #11a). |
| `tests/tui_gateway/test_review_summary_callback.py` | 117 | 2 | `background_review_callback` → `review.summary` event emission. | `packages/tui-gateway/tests/notifications.test.ts` (sub-task #11b). |

Total upstream tests: **256 in 7 files, 6,430 LOC**. All must be ported. Coverage gaps surfaced during the port go in the per-sub-task TS test files, not back into upstream-shaped fixtures.

## 7. Subdivision plan

Three sub-tasks. The split is along the natural seam — transport/protocol/lifecycle (#11a) is reusable plumbing with no agent dependency; handler bodies (#11b) need most of the rest of the system to be in TS first; the optional dashboard-WS path (#11c) is a thin transport adapter and can land in either #11a or #11b but is called out separately so it can be deferred if `gateway`'s web-server port slips.

### Sub-task #11a — `packages/tui-gateway` skeleton: transport, dispatch, entry, render, slash worker (~2,200 LOC)

**Blocked by:** #10 (`@hermests/gateway`) — `gateway.session_context` is imported by `server.py` for session var setup; the contextvar pattern is also informed by `gateway/`.

**Scope:**

- `packages/tui-gateway/src/transport.ts` — `Transport` interface, `StdioTransport` (with the full peer-gone errno set; reproduce on Node using `error.code` checks for EPIPE/ECONNRESET/EBADF/ESHUTDOWN), `TeeTransport`, `bind_transport` / `current_transport` / `reset_transport` (Node `AsyncLocalStorage` is the contextvars equivalent — pin via `als.run()`).
- `packages/tui-gateway/src/render.ts` — three thin wrappers around the eventual `@hermests/agent` `rich_output` exports; return `null` when the module hasn't been built yet.
- `packages/tui-gateway/src/dispatch.ts` — `dispatch(req, transport)`, `handle_request`, `_normalize_request`, `_ok` / `_err`, `method()` decorator equivalent (a registry-pattern `register(name, fn)` is the natural TS shape since TS has no decorator-on-anonymous-function).
- `packages/tui-gateway/src/entry.ts` — `bun ../packages/tui-gateway/src/entry.ts` stdio loop. Signal handling via `process.on("SIGTERM"/"SIGHUP"/"SIGINT")` — Bun supports these on POSIX; SIGPIPE is handled differently (Node ignores by default; reproduce the crash-log behaviour by attaching the same handler). Reserve stdout for JSON-RPC: redirect `process.stdout` writes from libraries to stderr via a wrapper before any agent imports.
- `packages/tui-gateway/src/slash-worker.ts` — `bun .../slash-worker.ts --session-key …` subprocess. Until `@hermests/cli` lands, this can be a stub that returns a structured error; mark the failing tests as `it.todo(…)` referencing #11b unblocked by #14.
- `packages/tui-gateway/src/event-publisher.ts` — `WsPublisherTransport` using `ws` (the Node WebSocket library; already in `docs/dep-mapping.md`'s Python→TS table assumed). Daemon-equivalent drain via a single-shot worker promise; backpressure via a bounded queue (Node's `p-queue` or a hand-rolled `MAX=256` array with drop-on-full).
- `packages/tui-gateway/src/server.ts` — module-level state (`_sessions`, `_methods`, `_pending`, `_answers`, `_stdio_transport`, `_stdout_lock`), `write_json`, `_emit`, `_status_update`, `_block` / `_clear_pending`, `_get_db` lazy wrapper, the `@method` registry, and the *no-handler-body* part of the module (init, hooks, helpers). Handler bodies move to #11b.
- Tests: `protocol.test.ts`, `transport.test.ts`, `entry.test.ts`, `render.test.ts`, `dispatch.test.ts`, `signal-handler.test.ts`, `event-publisher.test.ts`.

**Estimated:** 1 agent, 8–10 hours. Coverage target 100%. **Branch:** `port/tui-gateway-core`.

### Sub-task #11b — Handler bodies: the 68 JSON-RPC methods (~5,000 LOC)

**Blocked by:** #11a, #5 (`@hermests/agent` — `AIAgent` is required by `_make_agent` and ~30 handlers), #6 (`@hermests/tools` — approval, mcp_tool, process_registry, terminal_tool, vision_tools, skills_tool), #2 (`@hermests/state` — `SessionDB`), #14 (`@hermests/cli` — `HermesCLI` for `_SlashWorker` and `_apply_model_switch`).

**Scope:** Port the 68 `@method(…)` handlers (full list in section 3 of this brief — referenced as `_methods` registry entries in `server.py:2233–6741`). Group internally by family for review hygiene, but ship as one TS package update:

- **Session lifecycle** (15): `session.create`, `session.list`, `session.most_recent`, `session.resume`, `session.delete`, `session.title`, `session.usage`, `session.status`, `session.history`, `session.undo`, `session.compress`, `session.save`, `session.close`, `session.branch`, `session.interrupt`.
- **Prompt / streaming** (4): `prompt.submit`, `prompt.background`, `terminal.resize`, `session.steer`.
- **Prompts & responses** (4): `clarify.respond`, `sudo.respond`, `secret.respond`, `approval.respond`.
- **Config** (5): `config.set`, `config.get`, `config.show`, `setup.status`, `process.stop`.
- **Slash & commands** (7): `slash.exec`, `cli.exec`, `command.resolve`, `command.dispatch`, `commands.catalog`, `paste.collapse`, `complete.slash`.
- **Path / drop / completion** (4): `clipboard.paste`, `image.attach`, `input.detect_drop`, `complete.path`.
- **Model / providers** (4): `model.options`, `model.save_key`, `model.disconnect`, `reload.mcp`, `reload.env`.
- **Voice** (3): `voice.toggle`, `voice.record`, `voice.tts`.
- **Spawn tree / delegation / subagent** (6): `delegation.status`, `delegation.pause`, `subagent.interrupt`, `spawn_tree.save`, `spawn_tree.list`, `spawn_tree.load`.
- **Browser** (1): `browser.manage` (with `_browser_connect` / `_browser_disconnect` helpers and the CDP probing logic).
- **Tools / toolsets / skills / agents / cron / shell** (9): `tools.list`, `tools.show`, `tools.configure`, `toolsets.list`, `skills.manage`, `skills.reload`, `agents.list`, `cron.manage`, `shell.exec`, `plugins.list`.
- **Insights / rollback** (4): `insights.get`, `rollback.list`, `rollback.restore`, `rollback.diff`.

Tests: ported from `test_tui_gateway_server.py` (181 tests), split into per-family TS files under `packages/tui-gateway/tests/handlers/*.test.ts`.

**Estimated:** 1 agent, 16–24 hours (this is the heavy lift). **Branch:** `port/tui-gateway-handlers`.

### Sub-task #11c — WebSocket transport adapter (~250 LOC) [OPTIONAL — deferrable]

**Blocked by:** #11a, #10 (the FastAPI/web_server port — `handle_ws(ws)` mounts on `app.websocket("/api/ws")` and the dashboard sidebar back-WS at `/api/pub` lives in `gateway/`'s web server).

**Scope:** `packages/tui-gateway/src/ws.ts` — port `tui_gateway/ws.py` to the chosen TS web framework (Hono / Elysia / Fastify — to be decided by #10). Implements `WSTransport` with the on-loop vs. off-loop fast paths; emits `gateway.ready` after `ws.accept()`; falls back to the module-level stdio transport for any session whose WS dies. Tests: `ws.test.ts` (port of the WS-specific corners of `test_tui_gateway_server.py` — ~12 tests).

If `@hermests/gateway` web server is still in flight, this sub-task can be deferred without blocking the TUI use case (which only needs the stdio path).

**Estimated:** 1 agent, 3–4 hours. **Branch:** `port/tui-gateway-ws`.

## 8. Effort estimates

| Sub-task | LOC ported | Agents | Hours (single agent) | Critical path? |
|---|---:|---:|---:|---|
| #11a — Core (transport, dispatch, entry, render, slash worker, event publisher, server module skeleton) | ~2,200 | 1 | 8–10 | Yes — gates #11b. |
| #11b — Handler bodies (68 methods) | ~5,000 | 1 | 16–24 | Yes — gates module merge. |
| #11c — WebSocket adapter | ~250 | 1 | 3–4 | No — defer if #10 web server slips. |
| **Total** | **~7,450** | **3** | **27–38** | |

Parallelism note: #11a and #11c can run concurrently *if* a stub `Transport` interface is agreed up front, but #11c provides no value without the corresponding `@hermests/gateway` web-server route. #11a and #11b are strictly sequential. Bigger risk than agent hours: the `slash_worker` ↔ `HermesCLI` round-trip — the TS port may need to decide between (a) a TS child process running the ported CLI (clean, requires #14 complete), (b) a Python sidecar for slash commands during transition (pragmatic, breaks the pure-TS goal), or (c) inline slash dispatch without a worker subprocess (faster, loses the long-lived interpreter benefit). Decision should land in this sub-task's PR description.
