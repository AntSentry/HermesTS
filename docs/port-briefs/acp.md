# Port Brief: `@hermests/acp`

> **Task #9** — port `acp_adapter/` + `acp_registry/` from `nousresearch/hermes-agent` to TypeScript.
> **Upstream snapshot**: `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/` (refresh with `opensrc fetch github:nousresearch/hermes-agent`).
> **Target package**: `packages/acp/`.
> **Blocked by**: task #5 (`@hermests/agent`).
> **Estimated subdivision**: 3 sub-tasks.

---

## 1. Scope

### 1.1 `acp_adapter/` — 10 files, ~5,017 LOC

```
__init__.py          2 LOC   package marker (single docstring line)
__main__.py          5 LOC   `python -m acp_adapter` entry
auth.py             80 LOC   provider/credential detection, AuthMethod advertisement
edit_approval.py   287 LOC   pre-execution edit gate (ContextVar-bound requester)
entry.py           267 LOC   CLI entry point — argv parse, env load, stderr-only logging, agent boot
events.py          280 LOC   AIAgent callback factories → ACP session_update notifications
permissions.py     169 LOC   approval callback bridging Hermes `terminal` tool → ACP request_permission
server.py        1,949 LOC   `HermesACPAgent(acp.Agent)` — full ACP protocol surface
session.py         629 LOC   `SessionManager` + `SessionState` (in-memory + SessionDB persistence)
tools.py         1,358 LOC   hermes-tool → ACP ToolKind mapping; rich completion content rendering
```

LOC total per `wc -l`: 5,026 (figure above ≈ matches the team-lead brief's 5,017 — both are correct depending on whether `__init__.py` blank lines are counted).

### 1.2 `acp_registry/` — 2 files

```
agent.json   16 LOC   ACP registry manifest (id, version, distribution.uvx.package)
icon.svg    ~10 LOC   16x16 monochrome line icon for editor UI
```

The registry is **not source code that gets ported** — it is a publication artifact for `https://github.com/coder/agent-client-protocol-registry`. In TS, the equivalent is a JSON descriptor referencing the published npm/bunx distribution. Carrying it in `packages/acp/registry/` preserves provenance and keeps the SVG asset together with the agent it represents.

### 1.3 Behaviour boundary

`acp_adapter` is the **stdio transport surface** that lets editors (Zed, Pi, OpenCode, Codex, Claude Code) drive a Hermes `AIAgent` over the [Agent Client Protocol](https://github.com/coder/agent-client-protocol). It:

1. Receives JSON-RPC frames on stdin and emits replies on stdout. **Stdout is reserved**; every logger, every `print()` is forced to stderr (see `entry._setup_logging` and `session._acp_stderr_print`).
2. Translates ACP `prompt` requests into `AIAgent.run_conversation` invocations (`server.prompt`, lines 1243–1576).
3. Streams `AIAgent` callback events (tool_started, reasoning_delta, message_delta, step_completed) back as ACP `session/update` notifications (`events.make_tool_progress_cb` etc.).
4. Bridges ACP `request_permission` into Hermes' two distinct approval surfaces: **dangerous-command approval** (`permissions.make_approval_callback`) and **pre-execution edit approval** (`edit_approval.make_acp_edit_approval_requester`).
5. Persists each ACP session to the shared `~/.hermes/state.db` (`SessionDB`) so editors survive process restarts and `session_search` can find ACP transcripts.

---

## 2. Upstream dependencies (what the adapter imports)

This list determines the topological order in which other packages **must** be ported before the ACP package can typecheck. Anything not already at "completed" in [`PORTING_PLAN.md`](../../PORTING_PLAN.md) is a hard blocker.

### 2.1 First-party (other packages in this monorepo)

| Upstream import | TS target package | Symbol used | Notes |
|---|---|---|---|
| `hermes_constants.get_hermes_home` | `@hermests/core` | `getHermesHome` | already #1 |
| `hermes_constants.is_wsl` | `@hermests/core` | `isWsl` | already #1 |
| `hermes_bootstrap` | `@hermests/core` | side-effect import | UTF-8 stdio fix on Windows; in TS a no-op on POSIX |
| `hermes_state.SessionDB` | `@hermests/state` | `SessionDB` class | #2; full surface: `get_session`, `create_session`, `list_sessions_rich`, `search_sessions`, `delete_session`, `get_messages_as_conversation`, `replace_messages`, `_conn`/`_lock` (yes, the adapter pokes the DB lock directly — `session._persist` lines 460–467) |
| `hermes_cli.runtime_provider.resolve_runtime_provider` | `@hermests/cli` | `resolveRuntimeProvider` | #14 — but **only the runtime_provider sub-module** is needed; see §6.2 |
| `hermes_cli.config.load_config` | `@hermests/cli` | `loadConfig` | #14 sub-module |
| `hermes_cli.env_loader.load_hermes_dotenv` | `@hermests/cli` | `loadHermesDotenv` | #14 sub-module |
| `hermes_cli.__version__` | `@hermests/cli` | `VERSION` const | #14 |
| `hermes_cli.models.{curated_models_for_provider, normalize_provider, provider_label, detect_provider_for_model, parse_model_input}` | `@hermests/cli` | namespace re-export | #14 |
| `hermes_cli.main.main` | `@hermests/cli` | `main()` — called only by `--setup` | #14 |
| `hermes_cli.dep_ensure.ensure_dependency` | `@hermests/cli` | `ensureDependency` — `--setup-browser` only | #14 |
| `agent.async_utils.safe_schedule_threadsafe` | `@hermests/agent` | thread-safe `Promise` scheduler equivalent | **#5 — primary blocker** |
| `agent.display.{capture_local_edit_snapshot, extract_edit_diff}` | `@hermests/agent` | snapshot capture for edit diffing | #5 |
| `agent.model_metadata.estimate_request_tokens_rough` | `@hermests/agent` | `estimateRequestTokensRough(history, {systemPrompt, tools})` | #5 |
| `agent.title_generator.maybe_auto_title` | `@hermests/agent` | post-turn title generator | #5 |
| `run_agent.AIAgent` | `@hermests/cli` | top-level agent class | #14 — but ACP only needs the **constructor + `run_conversation` + `interrupt` + `steer` + a handful of attrs** (`model`, `provider`, `base_url`, `api_mode`, `tools`, `valid_tool_names`, `enabled_toolsets`, `disabled_toolsets`, `context_compressor`, `_cached_system_prompt`, `_compress_context`, `compression_enabled`, `tool_progress_callback`, `thinking_callback`, `reasoning_callback`, `step_callback`, `stream_delta_callback`, `_session_db`, `_print_fn`, `_invalidate_system_prompt`). Treat as an **interface contract** the ACP port asserts against. |
| `tools.terminal_tool.{register_task_env_overrides, clear_task_env_overrides, set_approval_callback, _get_approval_callback}` | `@hermests/tools` | terminal tool ContextVar bridge | #6 |
| `tools.mcp_tool.{register_mcp_servers, discover_mcp_tools}` | `@hermests/tools` | MCP registration | #6 |
| `tools.fuzzy_match.fuzzy_find_and_replace` | `@hermests/tools` | for `patch` edit-proposal building | #6 |
| `tools.patch_parser.{OperationType, parse_v4a_patch}` | `@hermests/tools` | V4A patch → ACP diff blocks | #6 |
| `model_tools.get_tool_definitions` | `@hermests/tools` | tool catalog for `_cmd_tools` and MCP refresh | #6 |
| `gateway.session_context.{set_session_vars, clear_session_vars}` | `@hermests/gateway` | per-session ContextVar binding | #10 — **only `session_context.py`**, not the gateway HTTP surface |

### 2.2 Third-party

| Upstream Python | TS replacement | Notes |
|---|---|---|
| `agent-client-protocol` (`acp`) Python SDK | `@zed-industries/agent-client-protocol` (npm) | Official Zed-maintained TS SDK. Confirm exported names match: `Agent`, `Client`, `run_agent`, `update_agent_message_text`, `update_agent_thought_text`, `update_user_message_text`, `update_tool_call`, `start_tool_call`, `tool_content`, `text_block`, `tool_diff_content`, `PROTOCOL_VERSION`, and the full `acp.schema` namespace used in `server.py:19-63`. Add to [`docs/dep-mapping.md`](../dep-mapping.md). |
| `acp.exceptions.RequestError` | from same SDK | used to silence benign liveness-probe `-32601`s in `entry._BenignProbeMethodFilter` |
| `asyncio` | Node's `Promise` + an explicit event-loop bridge | see §5.1 — **this is the single biggest semantic gap** |
| `concurrent.futures.ThreadPoolExecutor` / `TimeoutError` | `node:worker_threads` or a custom queued executor | `_executor = ThreadPoolExecutor(max_workers=4)` (server.py:85) — runs `agent.run_conversation` off the event loop |
| `threading.{Event, Lock}` | `AbortController` + JS lock library (e.g. `async-mutex`) | for `state.cancel_event` and `state.runtime_lock` |
| `contextvars.{ContextVar, copy_context}` | `node:async_hooks` `AsyncLocalStorage` | used in `edit_approval._EDIT_APPROVAL_REQUESTER` and `server.prompt` to isolate per-session state on shared workers |
| `pathlib.Path` | `node:path` + `node:fs/promises` | trivial |
| `urllib.parse.{urlparse, unquote}` | `node:url` `URL` + `decodeURIComponent` | trivial |
| `base64` | `Buffer.from(..., 'base64')` | trivial |
| `tempfile.gettempdir` | `os.tmpdir()` | trivial |
| `dataclasses` | plain TS `class` or `interface` + factory | `SessionState`, `EditProposal` |
| `argparse` | `commander` or hand-rolled (`process.argv.slice(2)`) | `entry._parse_args` — 5 flags |
| `logging` | `pino` (lightweight, structured, stderr-first) or a thin wrapper around `console.error` | must write to stderr only; `_BenignProbeMethodFilter` requires custom filter hook — `pino` supports it via `transport`/`hooks` |
| `itertools.count(1)` | plain `let n = 1; () => n++` | request-id generator |

---

## 3. Public API surface (what callers actually touch)

The ACP package has a **tiny external surface** and a **very large internal surface**. The split matters for both API stability and subdivision.

### 3.1 Externally callable

| TS export | Maps from | Purpose |
|---|---|---|
| `bin/hermes-acp` | `acp_adapter.entry.main` | the only CLI entry point — `bunx @hermests/acp` |
| `HermesACPAgent` (class) | `server.HermesACPAgent` | the ACP `Agent` implementation; tests instantiate it directly with a fake `SessionManager` |
| `SessionManager` (class) | `session.SessionManager` | the only other class instantiable in tests |
| `registry/agent.json` + `registry/icon.svg` | `acp_registry/*` | static assets, copied verbatim |

### 3.2 Internally callable (cross-file, but **not** part of the package's public surface)

Everything in `auth.py`, `events.py`, `permissions.py`, `edit_approval.py`, `tools.py` is consumed only by `server.py` / `session.py`. They become non-exported module-internal symbols in the TS port (or, if helpful for unit-testing, `export`ed but documented as "test-only / unstable").

### 3.3 Inputs / outputs

- **Stdin**: JSON-RPC 2.0 frames per ACP spec.
- **Stdout**: JSON-RPC 2.0 frames per ACP spec. **Nothing else, ever.** Failure to keep stdout clean breaks every client.
- **Stderr**: All logging.
- **`~/.hermes/.env`**: loaded once at startup.
- **`~/.hermes/state.db`**: SQLite, `sessions` + `messages` tables (owned by `@hermests/state`).
- **`HERMES_INTERACTIVE`, `HERMES_SESSION_ID`**: process-level env vars set/restored per turn so the terminal tool's approval branch and per-session caches scope correctly. These must survive accurately through the TS port — see §7 risk #3.

---

## 4. Behaviour catalogue (every observable thing the adapter does)

Used as the **completeness checklist** for the porter. Grouped by file so subdivision boundaries (§6) are clean.

### 4.1 `auth.py`

1. `detect_provider()` — resolves the active provider via `resolve_runtime_provider`; accepts both string `api_key` and `Callable` `api_key` (the Azure Foundry Entra ID bearer-token-provider case).
2. `has_provider()` — boolean helper.
3. `build_auth_methods()` — always returns at least the `hermes-setup` `TerminalAuthMethod`; prepends an `AuthMethodAgent` when a provider is configured.

### 4.2 `permissions.py`

1. `_OPTION_ID_TO_HERMES` map — stable across `allow_permanent=True/False`.
2. `_PERMISSION_REQUEST_IDS` — monotonically increasing `perm-check-N` ids.
3. `_permission_option_supports_kind` — probes the installed ACP SDK for `reject_always` support (older SDKs lack it).
4. `_build_permission_options(allow_permanent)` — assembles the four/five option set in a fixed order.
5. `_build_permission_tool_call(command, description)` — builds the `ToolCallUpdate` payload (not `ToolCallStart`).
6. `_map_outcome_to_hermes(outcome, allowed_option_ids)` — guards against unknown `option_id` in the response.
7. `make_approval_callback(request_permission_fn, loop, session_id, timeout=60.0)` — returns a sync callback the terminal tool can call from a worker thread; bridges via `safe_schedule_threadsafe` + `Future.result(timeout=...)`; returns `"deny"` on schedule failure, timeout, or exception.

### 4.3 `edit_approval.py`

1. `EditProposal` dataclass — `{tool_name, path, old_text, new_text, arguments}`.
2. `_EDIT_APPROVAL_REQUESTER: ContextVar` — bound per-context, never global.
3. `SENSITIVE_AUTO_APPROVE_NAMES = {".env", ".env.local", ".env.production", "id_rsa", "id_ed25519"}`.
4. `AUTO_APPROVE_ASK | AUTO_APPROVE_WORKSPACE | AUTO_APPROVE_SESSION` policy constants.
5. `set_edit_approval_requester` / `reset_edit_approval_requester` / `clear_edit_approval_requester` / `get_edit_approval_requester`.
6. `_read_text_if_exists(path)` — UTF-8 with `errors="replace"`, raises `OSError` on non-file.
7. `_proposal_for_write_file(arguments)` — requires `path` and `content`.
8. `_proposal_for_patch_replace(arguments)` — requires `path`, `old_string`, `new_string`; uses `fuzzy_find_and_replace`; raises on no-match.
9. `build_edit_proposal(tool_name, arguments)` — handles `write_file` and `patch` (when `mode == "replace"`); returns `None` for unrelated tools.
10. `_is_sensitive_auto_approve_path(path)` — checks for `.git` / `.ssh` parts and the sensitive-filename set.
11. `should_auto_approve_edit(proposal, policy, cwd)` — sensitive paths always ask; `AUTO_APPROVE_SESSION` skips for all non-sensitive; `AUTO_APPROVE_WORKSPACE` allows under cwd and under `tempfile.gettempdir()` (handles macOS `/tmp` → `/private/tmp` symlink and Windows per-user temp).
12. `maybe_require_edit_approval(tool_name, arguments)` — returns a JSON tool-error string when blocked, `None` to continue; requester exceptions default to **deny**.
13. `build_acp_edit_tool_call(proposal)` — `ToolCallUpdate` with `kind="edit"`, `status="pending"`, `tool_diff_content`.
14. `make_acp_edit_approval_requester(...)` — sync requester wired through `safe_schedule_threadsafe`; auto-approve check via `auto_approve_getter()` before prompting.

### 4.4 `entry.py`

1. Bootstrap `hermes_bootstrap` import wrapped in `try/except ModuleNotFoundError` (graceful fallback).
2. `_BENIGN_PROBE_METHODS = {"ping", "health", "healthcheck"}`.
3. `_BenignProbeMethodFilter(logging.Filter)` — silences `acp.exceptions.RequestError` with `code == -32601` whose `data.method` is in the probe set.
4. `_setup_logging()` — `StreamHandler(sys.stderr)`, fixed format `%(asctime)s [%(levelname)s] %(name)s: %(message)s`, datefmt `%Y-%m-%d %H:%M:%S`; quiets `httpx`, `httpcore`, `openai` to WARNING.
5. `_load_env()` — calls `load_hermes_dotenv(hermes_home=get_hermes_home())`.
6. `_parse_args` — flags `--version`, `--check`, `--setup`, `--setup-browser`, `--yes`/`-y`.
7. `--version` → prints `hermes_cli.__version__`, exits 0.
8. `--check` → imports `acp` and `acp_adapter.server.HermesACPAgent`, prints `"Hermes ACP check OK"`, exits 0.
9. `--setup` → re-invokes `hermes_cli.main` with argv `["hermes", "model"]`; if stdin is a TTY, prompts y/N to install browser tools.
10. `--setup-browser` → routes through `ensure_dependency("node")` then `ensure_dependency("browser")`; exits non-zero on failure.
11. `main()` (default) → logging + env, ensures project root is on sys.path, runs MCP discovery (best-effort), constructs `HermesACPAgent`, runs `asyncio.run(acp.run_agent(agent, use_unstable_protocol=True))`, catches `KeyboardInterrupt` cleanly, exits 1 on uncaught exceptions.

### 4.5 `events.py`

1. `_json_loads_maybe_prefix(value)` — `json.loads` first, then `JSONDecoder().raw_decode` to handle "JSON + human hint" appended payloads.
2. `_build_plan_update_from_todo_result(result)` — translates the `todo` tool's JSON result into an `AgentPlanUpdate`; maps `pending|in_progress|completed|cancelled` (cancelled → `completed` with `[cancelled]` prefix).
3. `_send_update(conn, session_id, loop, update)` — fire-and-forget via `safe_schedule_threadsafe`; 5-second `future.result()` cap; swallows exceptions to debug log.
4. `make_tool_progress_cb(...)` — signature `(event_type, name, preview, args, **kwargs)`; only acts on `event_type == "tool.started"`; FIFO queue per tool name in `tool_call_ids: Dict[str, Deque[str]]` (handles same-name parallel calls); legacy `str` → `deque` upgrade for restored sessions; captures `agent.display.capture_local_edit_snapshot` for `write_file | patch | skill_manage`; for `write_file | patch`, when policy auto-approves, builds an `EditProposal` and attaches as `edit_diff` to `build_tool_start`.
5. `make_thinking_cb(conn, session_id, loop)` — pushes `update_agent_thought_text(text)`; no-op on empty.
6. `make_step_cb(...)` — drains `prev_tools` list each step; supports dict and string forms; for `todo` results, also pushes an `AgentPlanUpdate`; pops `tool_call_meta` and the queue entry.
7. `make_message_cb(conn, session_id, loop)` — pushes `update_agent_message_text(text)`; no-op on empty.

### 4.6 `session.py`

1. `_win_path_to_wsl(path)` — `^([A-Za-z]):[\\/](.*)$` → `/mnt/<drive>/<tail>`.
2. `_translate_acp_cwd(cwd)` — calls `_win_path_to_wsl` only when `is_wsl()`.
3. `_normalize_cwd_for_compare(cwd)` — expanduser + WSL translation + `/mnt/X/...` lower-casing + `os.path.normpath`.
4. `_build_session_title(title, preview, cwd)` — explicit title, else preview, else basename of cwd, else `"New thread"`.
5. `_format_updated_at` / `_updated_at_sort_key` — flexible ISO/epoch parsers.
6. `_acp_stderr_print(*args, **kwargs)` — replaces `agent._print_fn` so stdout stays clean.
7. `_register_task_cwd(task_id, cwd)` / `_clear_task_cwd(task_id)` — bridge to `tools.terminal_tool.{register,clear}_task_env_overrides`.
8. `_expand_acp_enabled_toolsets(toolsets, mcp_server_names)` — always includes `hermes-acp`; appends `mcp-<name>` per server; dedup-preserves order.
9. `SessionState` dataclass — `{session_id, agent, cwd, model, history, cancel_event, is_running, queued_prompts, runtime_lock, current_prompt_text, interrupted_prompt_text}`. **Note**: `mode` and `config_options` are set via `setattr` from `server.py` — i.e. structurally optional. The TS port should model them as explicit optional fields, not duck-typed `any`.
10. `SessionManager`:
    - `__init__(agent_factory=None, db=None)` — both optional; `db_instance` is lazy.
    - `create_session(cwd)` → new uuid, fresh agent, registers cwd, persists.
    - `get_session(session_id)` → memory first, then DB restore.
    - `remove_session(session_id)` → memory + DB.
    - `fork_session(session_id, cwd)` → deep-copy history, new agent, persists.
    - `list_sessions(cwd=None)` → merges memory + DB, filters by normalized cwd, dedup by id, drops empty-history sessions, sorts by `updated_at` desc.
    - `update_cwd(session_id, cwd)` → re-registers tool cwd override.
    - `cleanup()` → wipes memory + all `source=acp` DB rows.
    - `save_session(session_id)` → forces persist.
    - `_get_db()` → lazy; **resolves `HERMES_HOME` at call time** (the comment at lines 401–411 spells out why — `DEFAULT_DB_PATH` is import-time and breaks the `_isolate_hermes_home` test fixture).
    - `_persist(state)` → creates row if missing, replaces messages atomically; updates `model_config` JSON with `{cwd, provider, base_url, api_mode}`.
    - `_restore(session_id)` → only restores `source == "acp"` rows; recreates agent with persisted model/provider/base_url/api_mode.
    - `_delete_persisted(session_id)` → DB delete.
    - `_make_agent(...)` → constructs `AIAgent` with `platform="acp"`, `quiet_mode=True`, expanded toolsets, runtime provider resolution; sets `agent._print_fn = _acp_stderr_print`.

### 4.7 `server.py`

Behaviours grouped by concern (line numbers refer to upstream):

**Constants & module state** (85–102):
- `_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="acp-agent")` — **process-wide**, shared across `HermesACPAgent` instances.
- `_LIST_SESSIONS_PAGE_SIZE = 50`.
- `_MAX_ACP_RESOURCE_BYTES = 512 * 1024`.
- `_TEXT_RESOURCE_MIME_PREFIXES` / `_TEXT_RESOURCE_MIME_TYPES`.

**Resource handling** (105–442):
- `_resource_display_name`, `_is_text_resource`, `_is_image_resource`, `_guess_image_mime_from_path`, `_image_data_url`, `_path_from_file_uri` (handles `file://` URIs + Windows drive paths + WSL `/mnt/` translation), `_decode_text_bytes` (utf-8-sig → utf-8 → latin-1 fallback), `_format_resource_text`.
- `_resource_link_to_parts(block)` — for `ResourceContentBlock`: emits an `image_url` part + header for image MIMEs (cap-checked); emits a text part with truncated inlined body for text; emits a `"binary omitted"` note otherwise.
- `_embedded_resource_to_parts(block)` — same for `EmbeddedResourceContentBlock` (handles both `TextResourceContents` and base64 `BlobResourceContents`).
- `_extract_text(prompt)` — plain-text extraction for slash-command parsing.
- `_image_block_to_openai_part(block)` — converts ACP `ImageContentBlock` to OpenAI `image_url` part.
- `_content_blocks_to_openai_user_content(prompt)` — returns `str` for text-only prompts (legacy path), `list[dict]` for multimodal.

**`HermesACPAgent` class**:

- Class constants: `_SLASH_COMMANDS` (9 commands), `_ADVERTISED_COMMANDS` (with `input_hint` for `model`, `steer`, `queue`), `_EDIT_APPROVAL_POLICY_*`, `_MODE_*`, `_MODE_TO_EDIT_APPROVAL_POLICY`, `_EDIT_APPROVAL_POLICY_TO_MODE`.

- `__init__(session_manager=None)` — default `SessionManager()`.

- `on_connect(conn)` — stores `self._conn`.

- Session-mode helpers: `_session_modes(state)` — returns `SessionModeState` with three modes (`default`, `accept_edits`, `dont_ask`); `_edit_approval_policy_for_state(state)` — maps mode → policy + cwd.

- Model helpers: `_encode_model_choice(provider, model)` → `"provider:model"`; `_build_model_state(state)` → `SessionModelState` with curated models, deduplicated, "current" marker, fallback shape on import failure.

- `_resolve_model_selection(raw_model, current_provider)` — uses `parse_model_input` then `detect_provider_for_model`; swallows exceptions and falls back to raw.

- `_build_usage_update(state)` — reads `agent.context_compressor.context_length`; estimates `used` via `estimate_request_tokens_rough(history, system_prompt=agent._cached_system_prompt, tools=agent.tools)`; emits `UsageUpdate(size, used)`.

- `_send_usage_update(state)` / `_send_session_info_update(session_id)` — async helpers.

- `_schedule_usage_update(state)` — `loop.call_soon(asyncio.create_task, ...)`.

- `_register_session_mcp_servers(state, mcp_servers)` — accepts `McpServerStdio | McpServerHttp | McpServerSse`; calls `register_mcp_servers(config_map)` on a thread; refreshes `state.agent.tools` and `valid_tool_names`; invalidates the cached system prompt.

- `initialize(protocol_version, client_capabilities, client_info, **kw)` → returns `InitializeResponse(protocol_version=acp.PROTOCOL_VERSION, agent_info=Implementation("hermes-agent", HERMES_VERSION), agent_capabilities=AgentCapabilities(load_session=True, prompt_capabilities=PromptCapabilities(image=True), session_capabilities=SessionCapabilities(fork=..., list=..., resume=...)), auth_methods=build_auth_methods())`.

- `authenticate(method_id)` — validates method id against advertised provider; `hermes-setup` only succeeds when a provider is configured.

- History replay helpers (`_flatten_history_text`, `_history_message_text`, `_history_reasoning_text` — checks both `reasoning_content` and `reasoning`, `_history_message_update`, `_history_thought_update`, `_history_tool_call_name_args` — handles `arguments` as both dict and JSON string, `_history_tool_call_id`).

- `_replay_session_history(state)` — awaited inline from `load_session` and `resume_session`; emits `UserMessageChunk` / `AgentMessageChunk` / `AgentThoughtChunk` / `ToolCallStart` / `ToolCallUpdate` / `AgentPlanUpdate` (when tool name is `todo`); aborts on send failure; tracks `active_tool_calls` to recover function args on the matching `tool` message.

- `new_session(cwd, mcp_servers)` → `NewSessionResponse(session_id, models, modes)` + scheduled commands/usage updates.

- `load_session(cwd, session_id, mcp_servers)` → `LoadSessionResponse(models, modes)` after **awaited** replay; outer `try/except` so a corrupted message never turns a successful load into a JSON-RPC error.

- `resume_session(cwd, session_id, mcp_servers)` → same shape; creates a new session if id missing.

- `cancel(session_id)` → sets `cancel_event`, captures `current_prompt_text` into `interrupted_prompt_text` while running, calls `agent.interrupt()` best-effort.

- `fork_session(cwd, session_id, mcp_servers)` → `ForkSessionResponse(session_id, models, modes)`.

- `list_sessions(cursor, cwd)` → cursor-paginated `ListSessionsResponse(sessions, next_cursor)`, page size 50.

- `prompt(prompt, session_id)` — **the central loop**, 333 LOC, lines 1243–1576:
  1. Look up state; refuse with `stop_reason="refusal"` if missing.
  2. Extract text + multimodal content; short-circuit `end_turn` if empty.
  3. `/steer` on idle salvage: replay the interrupted prompt with the steer guidance appended; plain `/steer` on idle is rewritten as a normal prompt.
  4. Slash command interception (text-only prompts starting with `/`).
  5. If `state.is_running`, append to `state.queued_prompts` and emit a "Queued for the next turn. (N queued)" reply.
  6. Otherwise mark running, capture `current_prompt_text`, clear cancel event.
  7. Wire callbacks: `tool_progress_cb`, `reasoning_cb` (no thinking_cb — ACP must not receive Hermes' local waiting text), `step_cb`, `stream_delta_cb` (wraps `message_cb` and tracks whether anything was streamed), `approval_cb`, `edit_approval_requester`.
  8. Define `_run_agent`:
     - Sets per-session ContextVars via `gateway.session_context.set_session_vars(session_key=session_id)`.
     - Sets terminal-tool approval callback (thread-local; **must** be set inside the executor thread, not on the event loop thread).
     - Binds the edit approval requester via `set_edit_approval_requester`.
     - Forces `HERMES_INTERACTIVE=1` and `HERMES_SESSION_ID=<id>`; **saves and restores prior values** so a reused executor thread never leaks across sessions.
     - Calls `agent.run_conversation(user_message=user_content, conversation_history=state.history, task_id=session_id, persist_user_message=user_text or "[Image attachment]")`.
     - Restores everything in `finally`.
  9. Submits `_run_agent` to `_executor` via `loop.run_in_executor(_executor, ctx.run, _run_agent)`, where `ctx = contextvars.copy_context()` (so concurrent ACP sessions don't stomp each other's ContextVars).
  10. Persists `state.history = result["messages"]`, calls `save_session`.
  11. `maybe_auto_title(db, session_id, user_text, final_response, history, title_callback=_notify_title_update)` (best-effort).
  12. If a final response exists and nothing was streamed, push it via `update_agent_message_text`.
  13. Mark idle; drain `state.queued_prompts` recursively (re-entering `self.prompt` with the queued text).
  14. Build `Usage` from `prompt_tokens / completion_tokens / total_tokens / reasoning_tokens / cache_read_tokens` if present.
  15. Send `_send_usage_update`.
  16. Return `PromptResponse(stop_reason="cancelled" if cancelled else "end_turn", usage=usage)`.

- Slash-command surface (`_handle_slash_command` + per-cmd handlers):
  - `help` — formatted command list.
  - `model` — no arg = "Current model: ...\nProvider: ..."; with arg = resolve provider+model, rebuild agent, persist, return "Model switched to: ...".
  - `tools` — lists tools via `get_tool_definitions(enabled_toolsets, quiet_mode=True)`, truncates descriptions to 80 chars.
  - `context` — message counts by role + model/provider/context-window usage + compression threshold guidance.
  - `reset` — `state.history.clear()` + save.
  - `compact` — calls `agent._compress_context(...)`; bypasses the SQLite session-split side effect by nulling `_session_db` for the duration.
  - `steer` — calls `agent.steer(steer_text)` if running and supported; otherwise queues.
  - `queue` — appends to `state.queued_prompts`.
  - `version` — prints `HERMES_VERSION`.
  - Unrecognized `/foo` returns `None` so the LLM handles it.

- `set_session_model(model_id, session_id)` — `_resolve_model_selection` → rebuild agent with optional base_url/api_mode preservation (only when provider didn't change).
- `set_session_mode(mode_id, session_id)` — validates against `_MODE_TO_EDIT_APPROVAL_POLICY`.
- `set_config_option(config_id, session_id, value)` — special-cases `edit_approval_policy` (maps back to mode); otherwise stashes on `state.config_options` dict.

### 4.8 `tools.py`

Two-layer concern: **tool-call event construction** (`build_tool_start`, `build_tool_complete`) and **rich completion content rendering** (the `_format_*` helpers).

- `TOOL_KIND_MAP` (24 entries) → ACP `ToolKind` (`read | edit | execute | search | fetch | think | other`).
- `_POLISHED_TOOLS` set — drives content rendering choices.
- `get_tool_kind(name)`, `make_tool_call_id()` (`tc-<12hex>`), `build_tool_title(name, args)` (per-tool title format — read/write/patch/search/web_search/web_extract/process/delegate/session_search/memory/execute_code/todo/skill_view/skills_list/skill_manage/browser_*/vision_analyze/image_generate/cronjob, plus default).
- Helpers: `_text`, `_json_loads_maybe` (with raw-decode fallback), `_tool_result_failed` (canonical "Error executing tool '..." prefix → failed; structured `success=False` / `ok=False` / non-zero `exit_code/returncode` → failed; for `_POLISHED_TOOLS`, `{error: ...}` without `content` → failed), `_truncate_text` (limit 5000 default), `_fenced_text` (computes longest backtick run to avoid breaking fences).
- 14 per-tool result formatters: `_format_todo_result`, `_format_read_file_result` (line-numbered → fenced), `_format_search_files_result` (files list and matches list, 20/12 caps), `_format_execute_code_result`, `_format_skill_view_result` (extracts markdown headings), `_format_skill_manage_result`, `_format_web_search_result` (10 items), `_format_web_extract_result` (errors-only — success stays compact), `_format_process_result`, `_format_delegate_result` (icon-prefixed status per task), `_format_session_search_result`, `_format_memory_result`, `_format_edit_result`, `_format_browser_result`, `_format_media_or_cron_result`, plus the generic `_format_structured_value` recursion (`max_depth=3`, `max_items=8`) and `_format_generic_structured_result` (priority-key surface + recursion).
- `_build_polished_completion_content(name, result, args)` — dispatch table → formatter, fallback to `_format_generic_structured_result`.
- `_build_patch_mode_content(patch_text)` — parses V4A patches into per-file `tool_diff_content` blocks; UPDATE / ADD / DELETE / MOVE operations; falls back to plain text on parse error.
- `_strip_diff_prefix(path)` — strips `a/` / `b/`.
- `_parse_unified_diff_content(diff_text)` — full unified-diff parser → `tool_diff_content` blocks; tracks `--- ` / `+++ ` headers; `/dev/null` → skip; `@@` header lines skipped.
- `_build_tool_complete_content(name, result, function_args, snapshot)` — `skill_manage` is special-cased to call `agent.display.extract_edit_diff` and feed `_parse_unified_diff_content`; otherwise dispatches to polished/generic.
- `build_tool_start(tool_call_id, tool_name, arguments, edit_diff=None)` — emits `ToolCallStart` with per-tool content (`patch` and `write_file` use `tool_diff_content` when an `edit_diff` proposal was auto-approved; `terminal` shows `$ command`; `read_file` and `web_extract` send `content=None` so Zed renders compactly; `todo` shows up to 8 items; `execute_code` truncates to 1200 chars; `skill_manage` per-action content; the generic fallback emits pretty-printed JSON arguments).
- `_is_structured_json_result(result)`.
- `build_tool_complete(tool_call_id, tool_name, result, function_args, snapshot)` — `web_extract` only emits content on failure; status `"failed"` per `_tool_result_failed`; `raw_output` omitted for polished/structured results.
- `extract_locations(arguments)` — `[ToolCallLocation(path, line=offset or line)]` if `arguments.path` present.

---

## 5. Port strategy — concrete recommendations

### 5.1 Concurrency model (the load-bearing decision)

The Python adapter runs the synchronous `AIAgent.run_conversation` on a `ThreadPoolExecutor` while the ACP event loop handles JSON-RPC. Callbacks invoked from inside the agent thread cross the thread boundary via `asyncio.run_coroutine_threadsafe(...)`, with the result awaited via `Future.result(timeout=...)` from the worker side.

Node is single-threaded by default. Two viable approaches:

- **(A) Keep `AIAgent` async-native in TS.** If the agent port (#5) exposes `runConversation` as an `async` function that uses `await` for everything, the entire ACP layer can stay single-threaded and the `ThreadPoolExecutor` simply disappears. Callbacks become plain `Promise`-returning functions, `safe_schedule_threadsafe` becomes a no-op, and `contextvars.copy_context()` becomes `AsyncLocalStorage.run(store, fn)`.
- **(B) Mirror the worker-thread shape.** Use `node:worker_threads` with a 4-worker pool. The ACP server passes structured payloads in, gets streamed callbacks back via `MessagePort`, and awaits the final result. This faithfully preserves the upstream thread model but adds significant complexity (serialization across worker boundaries, separate `AsyncLocalStorage` instances per worker, etc.).

**Recommendation: (A).** The thread pool exists upstream because Python's GIL makes async/sync interop expensive and because `AIAgent` was written as a synchronous loop. TS doesn't have those constraints, and the agent porter (#5) is starting from a clean sheet. Document this decision in the agent brief (#15) so `runConversation` is born async. **If #5 ports to synchronous TS for fidelity reasons**, the ACP package switches to (B). Coordinate with the brief-agent agent (task #15) before locking this in.

### 5.2 Stdout discipline

Hard rule: **the ACP process must not write a single byte to stdout outside of `@zed-industries/agent-client-protocol`'s JSON-RPC writer.**

- Force `pino` (or chosen logger) to stderr at boot.
- Wrap any `process.stdout.write` outside the ACP SDK as a build-time lint error (a small `eslint` / `biome` custom rule, or a runtime assertion that panics in dev).
- Mirror `session._acp_stderr_print` by injecting an explicit `printFn` into the agent that defaults to stderr.

### 5.3 ContextVars → AsyncLocalStorage

Map cleanly:
- `acp_adapter.edit_approval._EDIT_APPROVAL_REQUESTER` → an `AsyncLocalStorage<EditApprovalRequester | null>`.
- `gateway.session_context` ContextVars → a single `AsyncLocalStorage<{sessionKey: string}>` consumed by the terminal tool's interactive-sudo cache.
- Per-turn `HERMES_INTERACTIVE` / `HERMES_SESSION_ID` env mutations → either keep as `process.env` (with save/restore around `_runAgent`) **or** convert to `AsyncLocalStorage` reads inside the terminal/approval code paths. The env-var approach is faithful to upstream but leaks across concurrent sessions in TS just as it does in CPython without the `contextvars.copy_context()` shield — switch to `AsyncLocalStorage` for these too if the agent porter agrees.

### 5.4 SQLite

`@hermests/state` (#2) owns the SQLite client. The ACP port should consume **only the typed `SessionDB` interface** — never reach for `db._conn` / `db._lock` the way `session._persist` does upstream. Add a typed method `updateSessionMeta(sessionId, modelConfigJson, model?)` to `SessionDB` and call it from the ACP port. Flag this requirement in the #2 review.

### 5.5 ACP SDK gaps

Before merging the port, exercise `@zed-industries/agent-client-protocol` for **every symbol** listed in `server.py:19-63`. If any name is missing or renamed, document the substitution in [`docs/dep-mapping.md`](../dep-mapping.md) and add a thin adapter shim in `packages/acp/src/_acp.ts` so the rest of the code reads identically to the Python.

The Python adapter does an SDK-capability probe in `permissions._permission_option_supports_kind` for `reject_always`. The TS SDK either supports it or doesn't — replace the probe with a build-time check.

### 5.6 Snapshot capture & V4A patch parsing

`agent.display.capture_local_edit_snapshot`, `agent.display.extract_edit_diff`, and `tools.patch_parser.parse_v4a_patch` are non-trivial dependencies. Confirm the agent (#5) and tools (#6) briefs list them. If they slip, the ACP port can ship with stubs that render the raw payload as text (degrades to upstream's `except` fallback) — but only as a temporary measure flagged with a `TODO(blocked-by:#5)` comment and a failing test.

### 5.7 Faithful logging & error messages

The exact error/text strings emitted by Hermes ACP are observable behaviour (editors render them). Keep them byte-for-byte: `"No active turn — queued for the next turn. ({depth} queued)"`, `"Hermes ACP check OK"`, `"Conversation history cleared."`, `"⏩ Steer queued for the active turn: <preview>"`, `"Compression: due now (threshold ~...)"`, etc. Pin them as constants in `packages/acp/src/strings.ts` and assert on them in tests.

---

## 6. Subdivision plan — 3 sub-tasks

Each sub-task gets its own GitHub PR, branches off the merged dependencies. All three share `packages/acp/package.json`, `tsconfig.json`, `README.md`, and the registry/ assets (committed in sub-task #9a so #9b and #9c have something to build on).

### Sub-task #9a — Adapter core (auth, permissions, edit_approval, events, session)

- **Files**: `auth.ts`, `permissions.ts`, `edit_approval.ts`, `events.ts`, `session.ts`, types/`index.d.ts` for `SessionState` / `EditProposal`.
- **Tests**: port `tests/acp_adapter/test_detect_provider_entra.py` (the only upstream test that directly targets these files). Add new tests for the WSL path translation, the auto-approve policy matrix (asks for sensitive paths under all policies; allows under cwd/tmp for `workspace_session`), the `_BenignProbeMethodFilter` equivalent (validated indirectly via the entry sub-task), the queue/fork/cleanup/list paths on `SessionManager` (use the `agent_factory=` test seam already present upstream), and the FIFO ordering on `tool_call_ids` when two same-name tools run concurrently.
- **Estimated LOC**: ~1,500 TS (5 files + tests).
- **Blocked by**: #1 (core), #2 (state), #5 (agent — for `safe_schedule_threadsafe` shape decision and the `AIAgent` interface), #6 (tools — for terminal_tool ContextVar bridge, fuzzy_match, mcp_tool).

### Sub-task #9b — Tool-call rendering (`tools.ts`)

- **Files**: `tools.ts` (≈1,400 LOC, port of `acp_adapter/tools.py`); test fixtures under `packages/acp/tests/fixtures/`.
- **Tests**: build a fixture-per-formatter pattern. The upstream tests for these renderers live alongside the prompt-flow tests in `test_acp_commands.py`; expand them so every formatter has at least:
  - one happy-path fixture,
  - one structured-error fixture (`success: false`),
  - one canonical-prefix-error fixture (`"Error executing tool '..."`),
  - one polished-tool-without-content fixture for `_tool_result_failed`.
- The two parsers (V4A patch, unified diff) each need their own dedicated test file with at least the UPDATE/ADD/DELETE/MOVE happy paths and one malformed input that falls back cleanly.
- This sub-task is **pure data transformation** — no I/O, no ACP wire calls. It can be implemented and tested entirely standalone with mocked SDK types.
- **Estimated LOC**: ~1,800 TS (impl + fixtures + tests).
- **Blocked by**: #1, #6 (only for `tools.patch_parser` + `agent.display.extract_edit_diff` — both can be temporarily stubbed if #6 lags).

### Sub-task #9c — Server, entry, registry (the glue)

- **Files**: `server.ts` (≈2,200 TS), `entry.ts` + `bin/hermes-acp` (≈300 TS), `registry/agent.json` + `registry/icon.svg` copied verbatim, `__main__` equivalent (a `default-export-and-call-main` pattern that's `npm-style`).
- **Tests**: port `tests/acp_adapter/test_acp_commands.py` (slash-command coverage) and `tests/acp_adapter/test_acp_images.py` (multimodal prompt → OpenAI parts). Add new integration tests:
  - End-to-end `initialize` → `new_session` → `prompt` → `cancel` against a fake ACP client.
  - `load_session` / `resume_session` await the replay before returning (the upstream comment at server.py:1099-1108 cites the spec — make this explicit in a test).
  - Concurrent two-session prompt doesn't leak `HERMES_SESSION_ID` between sessions.
  - The slash-command intercept does **not** fire on multimodal prompts even if the first text block starts with `/`.
  - `_steer` salvage path: cancel an in-flight prompt, send `/steer fix X`, expect the replay shape.
- **Estimated LOC**: ~3,000 TS (impl + tests).
- **Blocked by**: #9a, #9b, plus #5 (`AIAgent` interface), #6 (`get_tool_definitions`, `register_mcp_servers`), #10 (`gateway.session_context`), and #14 (`hermes_cli.*`).

### Convergence

Once #9a and #9b are green, #9c can begin against an `AIAgent` mock that satisfies the interface contract listed in §2.1. When #5 lands, swap the mock for the real type and run the integration tests under both Bun and Node ≥20.

---

## 7. Risks, gotchas, and open questions

1. **ACP SDK divergence.** The Python SDK and the official TS SDK are both Zed-maintained but may have diverged in symbol names, kind enums, or content-block constructors. **Action**: open a dependency probe ticket (consider sub-task #9d if the gap is large) and pin the SDK version in the package.json with an exact match, not a caret.

2. **AIAgent async surface (#5 coupling).** If `runConversation` ports as a callback-emitting sync function, sub-task #9a must also include a thread-pool/worker-port shim. If it ports as `async`, this entire surface simplifies. **Action**: align with brief-agent (task #15) before #9a starts.

3. **Process-level env vars (`HERMES_INTERACTIVE`, `HERMES_SESSION_ID`).** Concurrent prompts on a single process will race on these unless `AsyncLocalStorage` replaces them. Upstream relies on `copy_context()` per worker thread to shield writes — TS has no equivalent for `process.env`. **Action**: change the agent's terminal/approval code paths to read from `AsyncLocalStorage` (preferred), or document the single-prompt-at-a-time constraint (faithful but worse than upstream).

4. **`session._persist` reaches into `db._conn` and `db._lock` directly** (lines 460–467). Faithful 1:1 port would expose those on `SessionDB`'s TS class. Better: add a typed `SessionDB.updateMeta(sessionId, modelConfig, model?)` and consume from there. **Action**: tracked above (§5.4); requires a tiny addition to the #2 port surface.

5. **The 5,000-char and 7,000-char truncation caps in `tools.ts`** are observable behaviour — editors will see truncation markers. Keep these constants exact, including the `f"\n... ({len(text)} chars total, truncated)"` suffix format. Pin as `MAX_FORMATTED_CHARS` constants and assert in tests.

6. **`prompt` recursion via `await self.prompt(...)` during queue drain** (server.py:1558). In TS this is a straight `await this.prompt(...)`, but if the drain queue grows unbounded the stack does too. Convert to an explicit `while (queue.length) await this.prompt(...)` loop without recursion — semantically identical, no stack risk.

7. **V8 microtask vs `loop.call_soon` semantics.** `_schedule_available_commands_update` and `_schedule_usage_update` rely on the update firing **after** the response is queued but before any new prompt. `queueMicrotask` or `setImmediate` should suffice in Node; verify against an integration test that sends a second prompt back-to-back.

8. **MCP server registration** (`_register_session_mcp_servers`) is called from `new_session`, `load_session`, `resume_session`, and `fork_session`. It mutates `state.agent.tools` and `enabled_toolsets` and invalidates the cached system prompt. The TS port must hold the same invariant: a subsequent `prompt` sees the refreshed tool surface. Add a regression test.

9. **`_isolate_hermes_home` fixture parity.** Upstream tests rely on `HERMES_HOME` env-var changes taking effect mid-test. The `_get_db` lazy resolution (session.py:401–411) is the mechanism. Replicate the same lazy pattern in TS, and write the fixture-equivalent test helper in `@hermests/state` so all consumers (not just ACP) benefit.

10. **Coverage threshold reminder.** `vitest.config.ts` requires 100% line/branch/function/statement coverage. The ACP package has at least 7 narrow exception/best-effort code paths (`logger.debug(..., exc_info=True)` blocks) that are easy to miss. Plan: explicit `expect(...).rejects.toThrow(...)` tests for every catch arm, and `/* v8 ignore next */` only where genuinely unreachable (with a per-PORTING_PLAN-rule justification comment).

---

## 8. Acceptance criteria for the merged `@hermests/acp` package

- All three sub-task PRs merged into `port/acp`.
- `bun run typecheck` and `bun run test` green at repo root.
- `vitest --coverage` reports 100% across `packages/acp/src/**` with no threshold lowering.
- `bun run packages/acp/bin/hermes-acp --check` exits 0 against a working `~/.hermes/.env`.
- `bun run packages/acp/bin/hermes-acp --version` prints the same version as the rest of the workspace.
- A manual smoke test with Zed (or a recorded ACP transcript fixture) reproduces: `new_session` → `prompt "hello"` → streamed `agent_message_chunk` → final `PromptResponse(stop_reason="end_turn", usage=...)`.
- README.md status table flipped from `pending` to `complete` for `@hermests/acp`.
- `PORTING_PLAN.md` workstream status updated.
- Registry assets present under `packages/acp/registry/` and referenced from `package.json` (`"files": [..., "registry"]`).

---

*Brief generated 2026-05-25 from upstream `nousresearch/hermes-agent@main` snapshot at `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/`. Refresh with `opensrc fetch github:nousresearch/hermes-agent` before starting the port.*
