# Port Brief — `@hermests/plugins`

**Upstream:** `nousresearch/hermes-agent` at `plugins/` (122 `.py` files, ~46,477 LOC; pinned to `main` branch as cached under `~/.opensrc/repos/github.com/nousresearch/hermes-agent/main/plugins/`).

**Target package:** `@hermests/plugins` (sub-packages per category — see Subdivision Plan).

**Source-of-truth location:** `~/.opensrc/repos/github.com/nousresearch/hermes-agent/main/plugins/` — read upstream files there; do not edit them.

---

## 1. Scope & Topology

`plugins/` is the canonical home for **everything user-pluggable in Hermes** — provider backends, vendor integrations, observability tracers, knowledge stores, platform adapters, dashboard tabs, and operator pipelines. It is intentionally a flat-ish container: most subdirectories are independent of each other and depend "outward" on `agent/`, `tools/`, `providers/`, `hermes_cli/`, `gateway/`, and `hermes_constants` rather than on one another.

There are **16 top-level groups** in upstream:

| Group | Files | LOC | Kind | Brief |
|---|---:|---:|---|---|
| `model-providers/` | 29 | 1,199 | provider profiles | Provider profiles for 25 LLM backends. One small `__init__.py` per vendor that constructs a `ProviderProfile` (or subclass) and calls `providers.register_provider(profile)`. Some vendors override `fetch_models()`, `build_extra_body()`, `build_api_kwargs_extras()`, `prepare_messages()` for quirks (Gemini thinking_config, Kimi extra_body.thinking, DeepSeek reasoning_content trap, Qwen cache_control, Nous portal tags, Bedrock disabled-models). |
| `model-providers/README.md` | — | — | docs | Auto-discovery contract: `providers/__init__.py._discover_providers()` scans bundled + `$HERMES_HOME/plugins/model-providers/`, last-writer-wins on collisions. |
| `web/` | 17 | 2,641 | backend (auto-loaded) | Web-search providers: brave_free, ddgs, exa, firecrawl, parallel, searxng, tavily, xai. Each subclasses `agent.web_search_provider.WebSearchProvider` and registers via `ctx.register_web_search_provider(...)`. `firecrawl/` is the heavyweight: lazy SDK proxy, direct-vs-managed-gateway dual auth, response-shape normalization across SDK/direct/gateway, per-URL SSRF re-check, website-policy gating, 60s `asyncio.wait_for` scrape timeout. `tavily` is the only sync /crawl with instruction support. `xai` is "LLM in a trench coat" — Grok web_search tool returning JSON. |
| `browser/` | 6 | 820 | backend (auto-loaded) | Cloud-browser providers: browser_use, browserbase, firecrawl. Each subclasses `agent.browser_provider.BrowserProvider`. `browser_use` carries thread-safe idempotency-key tracking for managed-gateway session creates (`_pending_create_keys` + `_pending_create_keys_lock`, `X-Idempotency-Key` header, 409-aware preserve/clear logic). `browserbase` does feature-fallback retry on 402 (drop keepAlive → drop proxies → succeed). All implement `create_session` / `close_session` / `emergency_cleanup` / `get_setup_schema`. |
| `image_gen/` | 4 | 1,179 | backend (auto-loaded) | Image-generation backends subclassing `agent.image_gen_provider.ImageGenProvider`. `openai/` and `openai-codex/` share the same gpt-image-2 tier catalog (low/medium/high) but route differently (REST `images.generate` vs Codex Responses `image_generation` tool over OAuth). `fal/` delegates to `tools.image_generation_tool` via call-time indirection so tests keep monkey-patching the legacy module. `xai/` hits xAI `/images/generations` with shared `tools.xai_http.resolve_xai_http_credentials` (OAuth → API key). |
| `video_gen/` | 2 | 968 | backend (auto-loaded) | Video-generation backends subclassing `agent.video_gen_provider.VideoGenProvider`. `fal/` is a multi-family router (LTX, Pixverse, Veo 3.1, Seedance 2.0, Kling v3 4K, Happy Horse) with per-family capability sheets (aspect ratios, resolutions, duration ranges, audio/negative-prompt support) and t2v↔i2v endpoint routing. `xai/` is async submit + poll on `/videos/generations` with strict input validation (≤7 reference images, mutually exclusive with image_url, clamped duration). |
| `web/` & `image_gen/` & `video_gen/` & `browser/` share **the same `ctx.register_*_provider()` registration shape** dispatched through the plugin context. |
| `memory/` | 15 | 12,054 | memory providers | Self-discovering provider zoo: byterover, hindsight, holographic (with `store.py` + `retrieval.py` + `holographic.py` HRR math), honcho (+ `client.py` + `cli.py` + `session.py`), mem0, openviking, retaindb, supermemory. Each subclasses `agent.memory_provider.MemoryProvider` (`initialize`, `is_available`, `system_prompt_block`, `prefetch`, `sync_turn`, `on_memory_write`, `get_tool_schemas`, `handle_tool_call`, `shutdown` + optional `on_pre_compress`, `on_session_end`, `save_config`, `post_setup`). `__init__.py` ships its own discovery (`discover_memory_providers`, `load_memory_provider`, `discover_plugin_cli_commands`) that scans bundled `plugins/memory/<name>/` AND user-installed `$HERMES_HOME/plugins/<name>/`, with bundled-takes-precedence on collisions. `holographic` has phase-encoding HRR with `bind`/`unbind`/`bundle`/`encode_atom`/`encode_fact`/`similarity` + SQLite-backed `MemoryStore` + `FactRetriever` with FTS5 + Jaccard + HRR cosine reranking. `honcho` has its own `cli.py` invoked via `hermes honcho ...`. Hindsight has a dedicated background event loop, single-writer retain queue, atexit hook, idle-daemon retry, API-version capability probe, and full `post_setup` wizard. |
| `context_engine/` | 1 | 219 | context-engine discovery | Discovery-only module (no concrete engines bundled in this PR). `discover_context_engines()` + `load_context_engine(name)` walk subdirs and import via `importlib.util.spec_from_file_location`. Each engine module exposes `register(ctx)` that calls `ctx.register_context_engine(engine)`, OR a `ContextEngine` subclass auto-instantiated as a fallback. Single-active selection via `context.engine` in `config.yaml` (default `"compressor"`). |
| `observability/` | 1 | 1,004 | hook-based | `langfuse/` — registers six hooks (`pre_api_request`, `post_api_request`, `pre_llm_call`, `post_llm_call`, `pre_tool_call`, `post_tool_call`) to trace Hermes turns to Langfuse. Heavy: lazy-init Langfuse SDK, placeholder-key detection with `_INIT_FAILED` sentinel, per-task `TraceState` (root span + child generations + tools queues + tool-call backfill), `propagate_attributes` context, usage/cost normalization through `agent.usage_pricing.normalize_usage` + `estimate_usage_cost`, payload safe-truncation, `read_file` payload normalization (head/tail line preview), JSON-string parse-detection in tool args. |
| `platforms/` | 15 | 15,326 | platform adapters | Inbound/outbound chat-platform adapters: discord, google_chat (+ `oauth.py`), irc, line, ntfy, simplex, teams. Each subclasses `gateway.platforms.base.BasePlatformAdapter`. Heavy operational code: aiohttp webhook servers, WebSocket subscribers, deduplication, per-platform allowlists, threaded `asyncio.run_coroutine_threadsafe` for callback-thread Pub/Sub → loop bridging, reply-token-with-push-fallback (LINE), Adaptive Cards (Teams), traversal-guarded media serving, signature verification, lazy SDK imports (`discord.py`, `microsoft_teams`, `aiohttp`, `websockets`), markdown/HTML stripping per platform, Cloudflare-tunnel operator docs. |
| `google_meet/` | 14 | 3,412 | tool-registering | Headless Meet bot — Playwright + caption scraping. `meet_bot.py` is a standalone subprocess; `process_manager.py` is the parent-side spawner/state tracker (`.active.json` pointer, `status.json`, `transcript.txt` under `workspace/meetings/<id>/`). `audio_bridge.py` provisions a virtual audio device (PulseAudio null-sink on Linux, BlackHole 2ch on macOS) so a v2 realtime voice can be piped into Chrome's fake-mic. `realtime/openai_client.py` is the synchronous OpenAI Realtime WebSocket client. `node/` is the remote-node-host subsystem: `server.py`, `client.py`, `protocol.py` (JSON envelope with token auth), `registry.py` (`nodes.json` ↔ `(url, token)` resolver), `cli.py`. Registers 5 tools (`meet_join` / `meet_leave` / `meet_status` / `meet_transcript` / `meet_say`) + `hermes meet` CLI + `on_session_end` cleanup hook. Linux/macOS only. |
| `spotify/` | 3 | 955 | tool-registering | 7 Spotify tools (`spotify_playback`, `_devices`, `_queue`, `_search`, `_playlists`, `_albums`, `_library`). `client.py` is the thin httpx-based Web API wrapper with 401-refresh-and-retry, friendly status-code-mapped error messages, URI/ID normalization. `tools.py` builds JSON-schema tool definitions and per-action dispatch handlers. Gated on `_check_spotify_available()` reading `hermes_cli.auth.get_auth_status("spotify")`. |
| `disk-cleanup/` | 2 | 812 | hook-based + CLI | `disk_cleanup.py` is a deterministic file-cleanup library (track / forget / dry_run / quick / deep / status / guess_category) scoped to `HERMES_HOME` and `/tmp/hermes-*` (rejects anything outside, including Windows `/mnt/c` mounts). `__init__.py` wires it into `post_tool_call` (auto-track ephemeral files from `write_file` / `patch` / `terminal`) and `on_session_end` (run quick cleanup when test files were tracked), plus `/disk-cleanup` slash command. Per-task tracking guarded by a threading lock. |
| `teams_pipeline/` | 8 | 2,436 | CLI + gateway runtime | Microsoft Teams meeting-summary pipeline: `pipeline.py` orchestrates resolving meeting → fetching transcript → downloading recording → transcribing → summarizing → writing to Notion/Linear → sending Teams notification. `models.py` defines `GraphSubscription`, `MeetingArtifact`, `TeamsMeetingPipelineJob`, `TeamsMeetingRef`, `TeamsMeetingSummaryPayload` dataclasses. `store.py` is JSON-backed durable state. `meetings.py` calls Microsoft Graph for meeting + call-record + recording-artifact enrichment. `subscriptions.py` maintains Graph change-notification subscriptions. `runtime.py` wires the pipeline into the gateway config (incoming_webhook vs Graph delivery). `cli.py` exposes `hermes teams-pipeline list/show/replay/.../subscriptions`. Plugin registers no model tools — operator CLI only. |
| `hermes-achievements/` | 2 | 1,217 | dashboard tab | Vendored from `PCinkusz/hermes-achievements`. `dashboard/plugin_api.py` is a FastAPI router mounted at `/api/plugins/hermes-achievements/`. Scans local Hermes session history, computes per-metric counters, evaluates tiered + multi-condition + secret achievements against thresholds (Copper/Silver/Gold/Diamond/Olympian). Snapshot cache (120s TTL) + incremental checkpoint scan. 60+ pre-defined achievements (`ACHIEVEMENTS` list). Has a `tests/test_achievement_engine.py` next to it. |
| `kanban/` | 1 | 2,217 | dashboard tab | `dashboard/plugin_api.py` FastAPI router mounted at `/api/plugins/kanban/`. Thin wrappers around `hermes_cli.kanban_db` + `kanban_diagnostics`. Provides `/events` WebSocket that tails the append-only `task_events` SQLite table on a short poll interval (WAL mode for concurrent reads). Session-token auth (`hmac.compare_digest` against `web_server._SESSION_TOKEN`), enforced on the WebSocket via `?token=` query param (browsers can't set Authorization on upgrade). Slug-normalization via `kanban_db._normalize_board_slug` with 400 on malformed input. |
| `example-dashboard/` | 1 | 17 | dashboard tab | 17-line test fixture: `/api/plugins/example/hello` returns a JSON greeting. Exists so the test suite has a stable, side-effect-free GET endpoint to verify plugin API routes work with auth. |
| `plugins/__init__.py` | 1 | 1 | package marker | `# Hermes plugins package` — that's it. |

Totals: **122 .py files, ~46,477 LOC**, plus 5 `plugin.yaml` manifests (disk-cleanup, google_meet, spotify, teams_pipeline + one in browser provider) and a handful of `README.md` / `SKILL.md` / `LICENSE` files.

---

## 2. The Plugin Contract (what we are porting INTO)

Every plugin upstream exposes **one** entry point — a top-level `def register(ctx) -> None:` — and the plugin loader walks discovered packages and calls it with a context object. `ctx` is a duck-typed thing that exposes the registration verbs the plugin needs:

| `ctx` method | Used by |
|---|---|
| `register_browser_provider(provider)` | `plugins/browser/*` |
| `register_web_search_provider(provider)` | `plugins/web/*` |
| `register_image_gen_provider(provider)` | `plugins/image_gen/*` |
| `register_video_gen_provider(provider)` | `plugins/video_gen/*` |
| `register_context_engine(engine)` | `plugins/context_engine/<name>/*` (single-active) |
| `register_memory_provider(provider)` | `plugins/memory/<name>/*` (single-active) |
| `register_tool(name, toolset, schema, handler, check_fn, emoji)` | `spotify`, `google_meet` |
| `register_hook(name, handler)` | `disk-cleanup`, `google_meet`, `langfuse` |
| `register_command(name, handler, description)` | `disk-cleanup` |
| `register_cli_command(name, help, setup_fn, handler_fn, description)` | `google_meet`, `teams_pipeline`, `honcho` |

**Model-provider plugins** are an exception — they bypass `ctx` and call `providers.register_provider(profile)` directly at import time. The reason is historical: provider profiles need to be available before `agent/` is fully imported, so they ride on `providers/`'s own auto-discovery walk.

**Dashboard plugins** are also exceptions — they expose `dashboard/plugin_api.py` with a top-level `router = APIRouter()` and are mounted by the dashboard web server at `/api/plugins/<name>/` (see `hermes-achievements`, `kanban`, `example-dashboard`).

The port MUST preserve this contract. In TypeScript that lands as:

```ts
// packages/plugins-core/src/context.ts
export interface PluginContext {
  registerBrowserProvider(p: BrowserProvider): void;
  registerWebSearchProvider(p: WebSearchProvider): void;
  registerImageGenProvider(p: ImageGenProvider): void;
  registerVideoGenProvider(p: VideoGenProvider): void;
  registerContextEngine(e: ContextEngine): void;
  registerMemoryProvider(p: MemoryProvider): void;
  registerTool(spec: ToolRegistration): void;
  registerHook(name: HookName, handler: HookHandler): void;
  registerCommand(name: string, handler: SlashHandler, description: string): void;
  registerCliCommand(spec: CliRegistration): void;
}

export interface Plugin {
  register(ctx: PluginContext): void | Promise<void>;
}
```

Each port sub-package exports `{ register }` (or `default { register }`) and registers itself by import; the loader (in `@hermests/agent` or `@hermests/gateway`) calls `register(ctx)` once per plugin at boot.

---

## 3. Per-Sub-Package Dependencies (what depends on what)

```
@hermests/plugins-model-providers
    ├─► @hermests/providers (ProviderProfile, register_provider, OMIT_TEMPERATURE)
    ├─► @hermests/agent (chat_completions transport helpers for Gemini)
    └─► @hermests/cli (hermes_cli.config.load_config, github_model_reasoning_efforts)

@hermests/plugins-web
    ├─► @hermests/agent.web_search_provider (ABC)
    └─► @hermests/tools (interrupt, lazy_deps, website_policy, web_tools cache slots,
                         xai_http, managed_tool_gateway, tool_backend_helpers)

@hermests/plugins-browser
    ├─► @hermests/agent.browser_provider (ABC)
    └─► @hermests/tools (managed_tool_gateway, tool_backend_helpers)

@hermests/plugins-image-gen
    ├─► @hermests/agent.image_gen_provider (ABC + helpers)
    ├─► @hermests/tools (image_generation_tool, xai_http, lazy_deps, fal_common,
                         auxiliary_client codex headers)
    └─► @hermests/cli (config)

@hermests/plugins-video-gen
    ├─► @hermests/agent.video_gen_provider (ABC + helpers)
    ├─► @hermests/tools (fal_common, xai_http, lazy_deps)
    └─► @hermests/cli (config)

@hermests/plugins-memory
    ├─► @hermests/agent (MemoryProvider ABC, memory_manager.sanitize_context,
                         async_utils.safe_schedule_threadsafe, usage_pricing,
                         auxiliary_client._read_codex_access_token)
    ├─► @hermests/tools (registry.tool_error, lazy_deps)
    ├─► @hermests/cli (config.cfg_get/load_config/save_config, auth,
                       memory_setup._curses_select)
    └─► @hermests/core (hermes_constants.get_hermes_home / display_hermes_home)

@hermests/plugins-context-engine
    ├─► @hermests/agent (ContextEngine ABC)
    └─► @hermests/core (importlib-style discovery → TS dynamic import equivalent)

@hermests/plugins-observability
    ├─► @hermests/agent (usage_pricing.normalize_usage / estimate_usage_cost /
                         get_pricing_entry)
    └─► (external) langfuse SDK

@hermests/plugins-platforms
    ├─► @hermests/gateway (config.Platform/PlatformConfig, platforms.base.*,
                            platforms.helpers, session.SessionSource)
    ├─► @hermests/tools (url_safety, microsoft_graph_auth, url_safety)
    └─► @hermests/core (atomic_json_write, hermes_constants)

@hermests/plugins-google-meet
    ├─► @hermests/core (hermes_constants)
    ├─► @hermests/tools (transcription_tools)
    └─► (external) Playwright, websockets, PulseAudio/BlackHole shells

@hermests/plugins-spotify
    ├─► @hermests/cli (auth.resolve_spotify_runtime_credentials / get_auth_status)
    └─► @hermests/tools (registry.tool_error/tool_result)

@hermests/plugins-disk-cleanup
    └─► @hermests/core (hermes_constants.get_hermes_home)

@hermests/plugins-teams-pipeline
    ├─► @hermests/agent (auxiliary_client.async_call_llm)
    ├─► @hermests/gateway (config.Platform/load_gateway_config)
    ├─► @hermests/tools (microsoft_graph_auth/client, transcription_tools)
    └─► @hermests/core (hermes_constants.get_hermes_home)

@hermests/plugins-dashboards
    ├─► @hermests/cli (kanban_db, kanban_diagnostics, web_server._SESSION_TOKEN)
    ├─► @hermests/core (hermes_constants)
    └─► (external) FastAPI router → Hono/Express router in TS port
```

**Reverse-dependency note.** Almost nothing in the rest of the codebase imports `plugins/*` directly — discovery is one-way at boot. Two exceptions to flag:
1. `tools/web_tools` re-exports `Firecrawl` and `check_firecrawl_api_key` from `plugins/web/firecrawl/provider.py` for backward-compat with existing tests. The TS port can keep this shim or break it; default keep.
2. `plugins/google_meet/cli.py` exposes `_is_safe_meet_url` to the plugin's own `__init__.py` only. No external reverse-dep.

---

## 4. Cross-Cutting Patterns

These show up in many plugins and should land as **shared helpers in `@hermests/plugins-core`** rather than re-implemented per plugin:

1. **Lazy-SDK proxy / `lazy_deps.ensure`** — Firecrawl, Exa, Parallel, fal_client all import the vendor SDK on first use, surfacing install hints via `tools.lazy_deps.ensure(...)`. Port as a `lazyImport(name, installHint)` utility.
2. **Cache-on-`tools.web_tools` for test patching** — Several web providers stash their cached client on the `tools.web_tools` module so existing tests can `patch("tools.web_tools._firecrawl_client", None)` between cases. The TS port should provide a `cacheSlot(moduleHandle, key)` helper to keep this contract.
3. **`agent.*_provider` ABC subclassing** — every provider category has an ABC in `agent/` (`BrowserProvider`, `WebSearchProvider`, `ImageGenProvider`, `VideoGenProvider`, `MemoryProvider`, `ContextEngine`). The TS port lands as `interface`-or-`abstract class` exports from `@hermests/agent`; the plugin imports them.
4. **`tools.interrupt.is_interrupted()` poll** — every long-running provider method short-circuits when the user interrupted. Port as a shared `InterruptToken` or AbortSignal threaded through.
5. **Setup schema (`get_setup_schema()`)** — every backend provider returns a JSON dict (`name`, `badge`, `tag`, `env_vars: [{key, prompt, url}]`, optional `post_setup`) consumed by `hermes tools` / `hermes setup`. Port as a typed `SetupSchema` interface.
6. **Idempotency-key tracking + 409-preserve logic** — `plugins/browser/browser_use/provider.py` is the reference implementation. If another async/at-least-once create lands later, factor this into a `withIdempotencyKey(taskId, fn)` util.
7. **Response-shape normalization across SDK/direct/gateway** — `_to_plain_object` / `_normalize_result_list` / `_extract_web_search_results` / `_extract_scrape_payload` in `plugins/web/firecrawl/provider.py` are tedious but well-tested; port one-to-one and keep them as private module functions, not split into a "smart" utility.
8. **Threaded async-loop helper for sync SDK calls** — Hindsight and OpenViking each spin up a dedicated background event loop. In TS this is just `async` everywhere; the issue evaporates. Validate against Hindsight's `_writer_loop` retain-queue model — that pattern (single-writer queue, atexit-drain) does need to land.

---

## 5. External Python Dependencies → TS Equivalents

| Python dep | Used by | TS replacement |
|---|---|---|
| `httpx` (sync + async) | nearly every plugin | `node:fetch` / `undici` / `ofetch`. Use one app-wide. |
| `requests` (sync) | browser/*, image_gen/xai | same as above (collapse the duplication). |
| `aiohttp` | platforms/teams, platforms/google_chat, platforms/ntfy webhook | `hono` or `fastify` for inbound; `undici` for outbound. |
| `websockets` (sync + async) | platforms/simplex, platforms/irc-style usage, google_meet/realtime, google_meet/node | `ws` (Node native). |
| `discord.py` | platforms/discord | `discord.js` (close API, not 1:1). |
| `microsoft-teams-apps`, `microsoft_teams.*` | platforms/teams | `botbuilder-services` SDK. |
| `google-cloud-pubsub`, `googleapiclient`, `google-auth` | platforms/google_chat, plugins/teams_pipeline | `@google-cloud/pubsub`, `googleapis` SDK. |
| `playwright` (sync_api or async_api) | google_meet/meet_bot.py | `playwright` (same vendor, same APIs essentially). |
| `langfuse` | observability/langfuse | `langfuse` (Node SDK exists, similar surface). |
| `firecrawl` (SDK) | web/firecrawl, browser/firecrawl | `firecrawl-js`. |
| `exa-py` | web/exa | `exa-js`. |
| `parallel` (`Parallel` + `AsyncParallel`) | web/parallel | `@parallel-web/parallel`. |
| `ddgs` | web/ddgs | `duck-duck-scrape`. |
| `openai` (`OpenAI`, `AsyncOpenAI`) | image_gen/openai*, observability cost-pricing | `openai` (official Node SDK). |
| `fal_client` (`subscribe`) | image_gen/fal, video_gen/fal | `@fal-ai/serverless-client`. |
| `requests` for xAI | image_gen/xai, video_gen/xai, web/xai | `undici`. |
| `mem0`, `byterover-cli`, `hindsight-client`/`hindsight-all`, `honcho` SDK, `supermemory`, `retaindb`, `openviking` | memory/* | Each TS port either calls the vendor REST API directly with `undici` OR uses the vendor's Node SDK if one exists. ByteRover's `brv` CLI is invoked via `child_process.spawn`. |
| `numpy` | memory/holographic/holographic.py (HRR math) | `mathjs` or a small custom phase-vector module. The math is simple element-wise mod-2π arithmetic + sha256-seeded atom encoding — porting by hand is preferable to dragging a numerics dep. |
| `sqlite3` | memory/holographic/store.py, kanban dashboard, hermes-achievements | `better-sqlite3` (sync, fast) or `node:sqlite` (Node ≥22). FTS5 + WAL must be preserved. |
| `pydantic`, `dataclasses`, `typing.Literal` | teams_pipeline/models.py, dashboard routers | `zod` for validation; native TS interfaces for plain types. |
| `fastapi.APIRouter` | hermes-achievements, kanban, example-dashboard | `hono` (lightweight) or `fastify`. Pick one for the whole dashboard. |
| `packaging.version.Version` | memory/hindsight | `semver` (npm). |
| `yaml` | discovery (`plugin.yaml` reads) | `yaml` (npm). |
| `urllib.request`, `urllib.parse` | many | `URL`, `URLSearchParams`, `undici`. |
| `threading.Lock`, `threading.RLock`, `threading.Thread`, `queue.Queue`, `atexit.register`, `signal` | hindsight, byterover, langfuse, openviking, retaindb, supermemory, google_meet | Node single-threaded — most lock usage becomes no-ops. Retain queues become async `Promise` queues. `atexit` → `process.on('exit')` / `process.on('SIGINT')`. Worker isolation only if `worker_threads` is genuinely needed. |
| `subprocess.run` | byterover (brv CLI), disk-cleanup, google_meet auth, teams_pipeline | `node:child_process` (`spawn`/`execFile`). |
| `shutil`, `pathlib.Path` | disk-cleanup, many | `node:fs`, `node:path`. |

A consolidated dep-mapping doc is task #20 — this brief enumerates the deps so it can be cross-checked.

---

## 6. Discovery Mechanism

Three discovery surfaces upstream, all of which the port must reproduce **deterministically** (no `importlib`-style runtime path walks if avoidable — prefer a generated registry that lists every bundled plugin at build time):

1. **`providers/_discover_providers()`** — auto-walks bundled `plugins/model-providers/<name>/` and user-installed `$HERMES_HOME/plugins/model-providers/<name>/`. Each `__init__.py` calls `providers.register_provider(profile)` at import. Last-writer-wins on name collisions. **Port:** generate a `plugins-model-providers/registry.ts` at build that imports every bundled provider; the runtime adds user-installed ones on top if present.
2. **`plugins/memory/__init__.py`** and **`plugins/context_engine/__init__.py`** — both ship their own `discover_*` + `load_*` functions that scan both bundled and `$HERMES_HOME/plugins/`. Memory is single-active (one provider per session, selected by `memory.provider` in config); context-engine is also single-active (`context.engine`). **Port:** same generated-registry approach + a `load(name): Provider | null` helper that resolves from the registry, falling back to a `$HERMES_HOME/plugins/<name>/` user dir using TS dynamic `import()`.
3. **Backend auto-load (`kind: backend` in `plugin.yaml`)** — `plugins/web/*`, `plugins/browser/*`, `plugins/image_gen/*`, `plugins/video_gen/*` are loaded by Hermes' plugin system at startup without explicit opt-in. **Port:** generated registry imports + a startup loop that invokes `register(ctx)` on each.

`kind: standalone` plugins (`disk-cleanup`, `google_meet`, `teams_pipeline`, observability/langfuse, dashboard plugins) require explicit opt-in via `plugins.enabled` in `config.yaml`. The TS port reads that list at startup and only invokes `register(ctx)` on those.

---

## 7. Testing Strategy

Upstream has tests under `tests/plugins/`, `tests/tools/`, `tests/memory/`, and adjacent locations. The shape per plugin:

- **Web/browser/image/video providers:** mock the vendor SDK (the cache slot on `tools.web_tools` is the seam); assert request payload shape, response normalization, error envelopes, and `is_available()` correctness. Test idempotency-key preservation explicitly (the `_should_preserve_pending_create_key` table).
- **Memory providers:** integration-style — spin up the provider with a temp `HERMES_HOME`, exercise `initialize → prefetch → sync_turn → on_memory_write → shutdown`, then verify state file contents. `holographic` has unit tests for HRR primitives in isolation.
- **Model-provider profiles:** unit tests on `build_extra_body` / `build_api_kwargs_extras` for each profile's known quirks (DeepSeek thinking trap, Kimi extra_body.thinking + top-level reasoning_effort, Qwen vl_high_resolution + cache_control, Nous omit-on-disabled, Gemini openai-compat path).
- **Platform adapters:** webhook signature verification (LINE HMAC, Discord interaction sig, Teams Bot Framework auth), allowlist gating per platform, deduplication state, reply-token-then-push fallback (LINE), at-least-once delivery semantics (google_chat Pub/Sub).
- **Hooks (disk-cleanup, observability):** simulate the host plugin context, fire `register_hook` handlers with synthetic events, assert side effects (auto-track set membership, langfuse trace state).
- **Dashboard plugins:** spin up a FastAPI test client, hit each route, assert response shape + auth-header enforcement.

Vitest port: use `vi.mock` for vendor SDKs, `vi.useFakeTimers()` for retry/delay logic, an in-memory FS shim (`memfs`) for `HERMES_HOME` tests. The 100% coverage gate the workspace already enforces is reachable for most plugins because their seams are clean; the realistic exceptions are `google_meet/meet_bot.py` (Playwright subprocess), `platforms/teams` (Bot Framework SDK), and the heavier Hindsight retry/loop machinery — those need a coverage exemption or carefully-mocked integration tests.

---

## 8. Open Questions / Risks

1. **Single-vendor lock-in on heavyweight memory providers.** Hindsight (1,758 LOC), OpenViking, RetainDB, Supermemory — each ports cleanly in isolation, but the test suites are tied tightly to specific vendor API shapes. Recommend porting each as its own sub-package, with a `provider-skip` flag in CI that skips integration tests when the upstream service is unreachable.
2. **`holographic/holographic.py` numerics.** Port reproduces SHA-256-seeded phase vectors exactly — bit-for-bit matching against the Python implementation is the only acceptable bar. Test against fixture vectors generated by upstream Python.
3. **Dashboard plugins assume FastAPI shape.** Picking `hono` vs `fastify` is a one-time decision that ripples through `kanban`, `hermes-achievements`, `example-dashboard`, AND whatever else `@hermests/cli/web_server.py` becomes. Coordinate with the cli/gateway brief (#19, #18). Default recommendation: `hono` (smallest, fastest, runs in Bun natively).
4. **PulseAudio / BlackHole / Playwright** in `google_meet` are platform-dependent shells. Port keeps Linux+macOS-only gate (no Windows). Realtime audio (v2) is the highest-risk piece — defer to a follow-up if the test rig can't be reproduced.
5. **`langfuse` cost-pricing imports `agent.usage_pricing`.** That helper module belongs to `@hermests/agent` and depends on the model-pricing catalog. The langfuse port can't ship until `@hermests/agent`'s pricing helpers land — flag as an explicit blocker on the langfuse sub-task.
6. **Model-providers depend on chat_completions transport helpers** (Gemini specifically). The `@hermests/plugins-model-providers` package can ship its profile *registry* and most provider profiles without that dep, but the Gemini override needs `@hermests/agent.transports.chat_completions` to be functional. Mark Gemini as the gating profile.
7. **`@hermests/providers` is task #3 (completed).** Re-confirm the TS `ProviderProfile` shape before starting any model-providers sub-task — if upstream's Python `ProviderProfile` evolved during the providers port, the model-provider profiles need to match.
8. **`teams_pipeline` depends on Microsoft Graph auth + client** (`tools/microsoft_graph_auth.py`, `tools/microsoft_graph_client.py`) which is part of `@hermests/tools` (#6). Coordinates with the tools brief.
9. **`disk-cleanup`'s tracked.json corrupted-recovery + .bak rotation** is well-specified and testable, but the empty-dir sweep deliberately spares a hard-coded protected-toplevel list (`logs`, `memories`, `sessions`, ...). Port keeps that list verbatim; do NOT make it config-driven without explicit ask.
10. **Honcho ships a `cli.py` AND its own `discover_plugin_cli_commands` mechanism** so the `hermes honcho ...` command tree only registers when honcho is the active memory provider. The port keeps that gate — single-active discipline must hold.

---

## Subdivision Plan (sub-tasks for issue #8)

Each sub-task is a self-contained port of one cohesive plugin group. Sub-tasks #8a..#8n all carry `addBlockedBy=["6"]` (same blocker as #8 — the `@hermests/tools` package needs to land first because every category leans on `tools.lazy_deps`, `tools.registry`, `tools.interrupt`, `tools.website_policy`, `tools.xai_http`, `tools.fal_common`, `tools.image_generation_tool`, `tools.microsoft_graph_*`, and `tools.web_tools`-as-cache-slot). Within those, sub-tasks can run in parallel unless flagged.

| # | Title | Files | LOC | Notes |
|---|---|---:|---:|---|
| **#8a** | `@hermests/plugins-core` — context interfaces + shared helpers | n/a | (new) | Defines `PluginContext`, `Plugin`, `SetupSchema`, `BackendKind`, `lazyImport`, `cacheSlot`, `InterruptToken`. Generated bundled-plugin registry. Discovery: bundled + `$HERMES_HOME/plugins/`. **Blocks all other sub-tasks** so do this first. Pair with the agent ABCs port if convenient. |
| **#8b** | `@hermests/plugins-model-providers` — 25 provider profiles | 29 | 1,199 | All vendors. Gate: `@hermests/providers` (done) + Gemini override needs `@hermests/agent.transports.chat_completions`. Single PR; profiles are trivial individually but related (shared `ProviderProfile` superclass). |
| **#8c** | `@hermests/plugins-web` — 8 web-search providers | 17 | 2,641 | brave_free, ddgs, exa, firecrawl, parallel, searxng, tavily, xai. Firecrawl is the heavyweight; consider landing first as the reference implementation, then the rest in a follow-up commit on the same branch. |
| **#8d** | `@hermests/plugins-browser` — 3 cloud browser providers | 6 | 820 | browser_use, browserbase, firecrawl (browser). Idempotency-key pattern is the reusable bit — extract to `plugins-core` if a second async create lands. |
| **#8e** | `@hermests/plugins-image-gen` — 4 image backends | 4 | 1,179 | fal, openai, openai-codex, xai. fal delegates to `tools.image_generation_tool` — verify that helper exists in `@hermests/tools`. |
| **#8f** | `@hermests/plugins-video-gen` — 2 video backends | 2 | 968 | fal (multi-family router), xai (async submit+poll). |
| **#8g** | `@hermests/plugins-memory-discovery` + small providers | 5 | ~3,000 | `memory/__init__.py` discovery + bundled small providers: `byterover` (CLI wrapper), `holographic` (with HRR + store + retrieval + numerics fidelity tests), `mem0`, `supermemory`. Land these together because they share the MemoryProvider ABC tests. |
| **#8h** | `@hermests/plugins-memory-honcho` | 4 | ~3,000 | `honcho/__init__.py` + `client.py` + `cli.py` + `session.py`. Includes `hermes honcho` CLI plumbing via `discover_plugin_cli_commands`. |
| **#8i** | `@hermests/plugins-memory-hindsight` | 1 | ~1,758 | Single biggest plugin file. Background loop + retain queue + atexit + capability probe + post_setup wizard. Land alone. |
| **#8j** | `@hermests/plugins-memory-misc` — openviking + retaindb | ~3 | ~2,500 | `openviking` (full bidirectional, atexit safety net) + `retaindb` (SQLite write-behind queue + dialectic synthesis). |
| **#8k** | `@hermests/plugins-context-engine` — discovery only | 1 | 219 | No bundled engines ship yet — pure discovery scaffolding. Pair with a placeholder `compressor` engine if `@hermests/agent` already ships one. |
| **#8l** | `@hermests/plugins-observability-langfuse` | 1 | 1,004 | Six hooks + TraceState + usage/cost normalization. Blocks on `@hermests/agent.usage_pricing` (flag in PR). |
| **#8m** | `@hermests/plugins-platforms` — 7 platform adapters | 15 | 15,326 | discord, google_chat (+oauth), irc, line, ntfy, simplex, teams. Largest LOC group. Sub-divide further only if needed — most adapters are ~1-2k LOC, similar shape (webhook + send + dedup + allowlist). Suggested in-PR ordering: irc → ntfy → simplex → line → discord → google_chat → teams. Blocks on `@hermests/gateway` (#10). |
| **#8n** | `@hermests/plugins-google-meet` — Meet bot + node host | 14 | 3,412 | meet_bot subprocess + process_manager + audio_bridge + realtime/openai_client + node/* (server/client/protocol/registry/cli). Linux+macOS gate preserved. Defer realtime audio (v2) to a follow-up if test rig is missing. |
| **#8o** | `@hermests/plugins-spotify` — 7 tools + client | 3 | 955 | Includes URL/URI/ID normalization. Depends on `hermes_cli.auth.resolve_spotify_runtime_credentials` (gate on #14 cli). |
| **#8p** | `@hermests/plugins-disk-cleanup` — hooks + CLI | 2 | 812 | Pure stdlib; no external deps. Easy early win. |
| **#8q** | `@hermests/plugins-teams-pipeline` — Graph pipeline + CLI | 8 | 2,436 | Depends on `tools.microsoft_graph_auth/client` (in #6) + `gateway/config` (in #10) + `agent.auxiliary_client.async_call_llm` (in #5). Multi-blocker. |
| **#8r** | `@hermests/plugins-dashboards` — kanban + achievements + example | 4 | 3,451 | All three FastAPI routers + the achievements catalog + share-card renderer scope decision (skip client-side canvas reimplementation for v1; just ship the API endpoints). Depends on the chosen TS web framework (hono/fastify) + `@hermests/cli.kanban_db` + `@hermests/cli.web_server._SESSION_TOKEN`. |

**Total sub-tasks: 18.** Counts include #8a as the unblocking-foundation task — actual ports are #8b..#8r (17). Hits the brief's "10-15 sub-tasks" target, slightly over because honcho and hindsight in `memory/` are too distinct in scope to merge without losing focus.

**Parallelism guidance.** Once #8a lands, the safe parallel batches are:
- Batch 1 (no external blockers beyond #6 + #8a): #8c, #8d, #8e, #8f, #8k, #8p, #8r (where #8r assumes the web-framework decision is made).
- Batch 2 (needs #8b done because tests of model-providers exercise the registry contract): #8b only — single big PR.
- Batch 3 (needs MemoryProvider ABC verified): #8g, #8h, #8i, #8j — all in parallel.
- Batch 4 (needs #10 gateway): #8m, #8q.
- Batch 5 (needs #14 cli): #8o for the auth import; #8m / #8q may also pick up further config helpers.
- Batch 6 (needs #5 agent.usage_pricing): #8l.

Worktree-isolation is recommended for parallel agents because several plugins touch the shared `packages/agent/src/{web,browser,image_gen,video_gen,memory,context_engine}_provider.ts` ABC files; conflicting edits there will not merge cleanly.
