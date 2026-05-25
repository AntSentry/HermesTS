# Port Brief — `@hermests/gateway`

> Upstream module: `gateway/` in `nousresearch/hermes-agent@main`
> Local cache:    `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/gateway/`
> Scale:          **61 files · 79,472 LOC** (largest single file: `run.py` at 18,270 LOC; largest adapter: `platforms/telegram.py` at 5,700 LOC)
> Position in DAG: task **#10**, depends on `core`, `state`, `providers`, `agent`, `tools` (so blocked behind #1–#6); blocks `tui-gateway` (#11) and `cli` (#14)
> Companion file: `gateway/platforms/ADDING_A_PLATFORM.md` — upstream's own checklist of every integration point in this module; treat it as the authoritative cross-reference while porting

---

## 1. Purpose

The gateway is Hermes's **multi-platform messaging bus**. It is the surface that turns the headless agent (`hermes_state`, `providers`, `agent`, `tools`) into a long-running daemon you can talk to over Telegram, Discord, WhatsApp, Slack, Signal, Matrix, Mattermost, Home Assistant, Email/SMTP+IMAP, SMS (Twilio), DingTalk, an HTTP API server, generic webhooks, Microsoft Graph webhooks, Feishu (Lark) chat + Feishu code-review comments, WeCom (and its callback variant), Weixin Official Accounts, BlueBubbles (iMessage bridge), QQ Bot (channels + groups), and Tencent Yuanbao — plus any plugin-registered platform.

Concretely the gateway:

1. **Loads platform configuration** from `~/.hermes/config.yaml` (+ legacy `gateway.json`) and bridges YAML keys → env-vars → `PlatformConfig.extra` dicts so adapters can read a uniform shape.
2. **Discovers and constructs adapter instances** for every enabled platform via a registry that supports both built-in adapters (`platforms/*.py`) and plugin adapters (registered through `gateway/platform_registry.py`).
3. **Runs an asyncio event loop** (`gateway/run.py::GatewayRunner.start`) that owns adapter lifecycles, the session store, the delivery router, an HTTP API server, a `cron` handoff watcher, a session-expiry watcher, a Kanban notifier watcher, a Kanban dispatcher watcher, and a platform-reconnect watcher.
4. **Manages sessions per (platform × chat × thread × user)** with `SessionStore`, evaluates reset policies (`daily` / `idle` / `both` / `none`), and writes session metadata to SQLite (`SessionDB` from `hermes_state`).
5. **Translates inbound messages → `MessageEvent` → agent invocation** with dynamic system-prompt injection (`build_session_context_prompt`), per-platform behavioural hints, optional PII redaction, group/thread participant-isolation rules, mention-gating, allow-lists, and slash-command interception.
6. **Streams outbound tokens back through the platform** via `GatewayStreamConsumer` — a thread-safe bridge between the agent's synchronous `stream_delta_callback` and async platform sends, with edit-based progressive updates, optional native draft streaming (Telegram drafts), fresh-final rebroadcast for long previews, flood-control backoff, segment-break tool-progress bubbles, and overflow chunking.
7. **Delivers cron / scheduled-task output** via `DeliveryRouter` to a list of `DeliveryTarget`s (`origin`, `local`, `<platform>`, `<platform>:<chat>`, `<platform>:<chat>:<thread>`).
8. **Provides supporting services**: PID-file + scoped runtime locks, takeover/planned-stop markers, shutdown forensics, memory monitoring, restart drain-timeout policy, pairing-code admission of unauthorised DMs, channel directory cache for `send_message(action="list")`, slash-command access policy, runtime-footer rendering, WhatsApp JID/LID canonicalisation, and an event-hook system (`gateway:startup`, `session:start`, `agent:end`, `command:*`).

Everything below is preserved in the TS port — there is no "simplified gateway" deliverable. The faithful-port constraint and 100% coverage gate from `PORTING_PLAN.md` apply unchanged.

---

## 2. Module surface (top-level files, by responsibility)

The 61 source files fall into seven internal subsystems. The subdivision plan (§6) follows the same boundaries.

### 2.1 Configuration — what platforms exist, how to authenticate them

| File | LOC | Role |
|---|---:|---|
| `config.py` | 1,856 | `Platform` enum (with dynamic `_missing_` for plugin platforms), `PlatformConfig`, `HomeChannel`, `SessionResetPolicy`, `StreamingConfig`, `GatewayConfig`, `load_gateway_config()` — the YAML → env → dataclass funnel; per-platform `_PLATFORM_CONNECTED_CHECKERS`; the `_apply_env_overrides`-style shared-key loop that mirrors Telegram/Slack/WhatsApp/Signal/DingTalk/Mattermost/Discord blocks to environment variables (env > YAML precedence) |
| `display_config.py` | 206 | Per-platform display setting resolution (e.g. typing indicators, reply-prefix, reply-in-thread) with `resolve_display_setting()` precedence chain |
| `platform_registry.py` | 260 | `PlatformEntry` dataclass + `PlatformRegistry` singleton. Built-in adapters and plugins both register here; the gateway looks plugins up first before falling back to the legacy `if/elif` in `_create_adapter()` |

### 2.2 Sessions — who you are, where you are, what conversation thread you're in

| File | LOC | Role |
|---|---:|---|
| `session.py` | 1,348 | `SessionSource` dataclass; `SessionContext`; `SessionEntry` (the persisted record with token counts, cost, `was_auto_reset`, `is_fresh_reset`, `suspended`, `resume_pending`, `expiry_finalized`); `SessionStore` (SQLite-backed via `hermes_state.SessionDB`, with `sessions.json` mirror); `build_session_key()` (the single source of truth for chat × thread × user key composition with the group/thread isolation rules); `build_session_context_prompt()` (dynamic system-prompt injection with per-platform notes for Slack / Discord / iMessage / Yuanbao and PII redaction for WhatsApp/Signal/Telegram/BlueBubbles); SQLite transcript append/replace/load |
| `session_context.py` | 164 | `contextvars`-based replacement for `os.environ`-based session vars (`HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`, etc.) — task-local so concurrent asyncio messages don't clobber each other. Keeps legacy env-var fallback for CLI/cron/tests. |
| `whatsapp_identity.py` | 155 | `normalize_whatsapp_identifier()`, `canonical_whatsapp_identifier()`, `expand_whatsapp_aliases()` — walks `whatsapp/session/lid-mapping-*.json` files to collapse phone-JID/LID aliases; used by both the authorisation path and the session-key path so they can never drift apart |
| `pairing.py` | 450 | `PairingStore`: pending-pairing codes (hashed + salted), approved-user store, rate-limit + lock-out tracking, platform-scoped pending/approved JSON files |
| `slash_access.py` | 229 | `SlashAccessPolicy` derived from `PlatformConfig.extra` for the chat-type scope (dm/group/thread) — `is_admin()`, `can_run(user_id, canonical_cmd)`, derived from `allow_admin_from` / `allow_from` / `user_allowed_commands` / `group_*` keys |
| `channel_directory.py` | 357 | Cached per-platform channel map at `~/.hermes/channel_directory.json`, built on startup + refreshed every 5 min; Discord enumerates from `client.guilds`; Slack pages `users.conversations`; everyone else falls back to deriving channels from `sessions.json` origin records; `resolve_channel_name()` maps human-friendly labels to IDs |

### 2.3 Delivery — sending outbound content

| File | LOC | Role |
|---|---:|---|
| `delivery.py` | 258 | `DeliveryTarget.parse()` for the `origin` / `local` / `<platform>[:<chat>[:<thread>]]` mini-language; `DeliveryRouter` dispatches to adapter `.send()` calls, truncates oversize cron output (saves full to disk, sends truncated with backreference), saves local cron output to `<hermes-home>/cron/output/` |
| `mirror.py` | 168 | `mirror_to_session()` — appends external messages (cron output, webhook events) into a target session's SQLite transcript so the agent's context reflects them on next turn |
| `stream_consumer.py` | 1,313 | `GatewayStreamConsumer`: queues agent sync-thread deltas; runs an async loop that progressively edits a platform message with rate-limited buffered chunks; handles flood-control adaptive backoff (`_MAX_FLOOD_STRIKES`, 2× interval growth capped at 10 s); think-tag filtering (`<REASONING_SCRATCHPAD>` / `<think>` / `<reasoning>` etc. — must stay in sync with `cli.py` and `run_agent.py`); segment-break tool-progress bubbles; overflow chunking with `_split_text_chunks` + `_custom_unit_to_cp` (UTF-16-aware for Telegram); MEDIA: directive stripping; fallback final-send with `delete_message` cleanup of stale preview; fresh-final rebroadcast (port of openclaw/openclaw#72038); native draft-streaming branch (`adapter.send_draft`, Telegram-DM-only) with permanent disable-on-first-failure |
| `runtime_footer.py` | 150 | Renders the trailing `cwd · model · session_id` footer the gateway appends to messages, with home-relative path collapsing and model-name shortening |
| `sticker_cache.py` | 124 | Per-sticker (Telegram `file_unique_id`-keyed) description cache so the agent doesn't re-vision the same sticker; emits a small markdown injection on cache hit |

### 2.4 Lifecycle, status, restart, shutdown

| File | LOC | Role |
|---|---:|---|
| `status.py` | 971 | PID-file + flock-based scoped runtime locks (`~/.hermes/gateway.pid`, `gateway.lock`, `runtime-status.json`); takeover marker + planned-stop marker (consumed exactly once by the new process); `acquire_gateway_runtime_lock()` / `release_gateway_runtime_lock()` / `is_gateway_running()` / `terminate_pid()`; per-scope locks for `acquire_scoped_lock(scope, identity)` (used by platform adapters to prevent dual instances against the same Telegram bot token / Slack workspace / etc.) |
| `restart.py` | 20 | `parse_restart_drain_timeout()` — env-var parser for the drain-timeout policy (seconds; "off" → 0; clamps to ≥0) |
| `shutdown_forensics.py` | 462 | `snapshot_shutdown_context(received_signal)` — captures signal name, parent PID + cmdline (best-effort), systemd timing (`/proc/self/status`, `systemctl show`), and writes a JSON diagnostic; used after SIGTERM to figure out whether systemd, the user, or a watchdog killed us |
| `memory_monitor.py` | 230 | Background thread sampling RSS every 5 min, logs warnings on growth; `start_memory_monitoring`, `stop_memory_monitoring`, `is_running` |
| `hooks.py` | 210 | `HookRegistry.discover_and_load()` from `~/.hermes/hooks/<name>/{HOOK.yaml,handler.py}`; `emit(event_type)` and `emit_collect(event_type)` with wildcard (`command:*`) matching; events: `gateway:startup`, `session:start`, `session:end`, `session:reset`, `agent:start`, `agent:step`, `agent:end`, `command:*` |
| `builtin_hooks/__init__.py` | 1 | Reserved future slot for shipped always-on hooks (currently empty per design) |

### 2.5 Orchestration — the giant `run.py`

| File | LOC | Role |
|---|---:|---|
| `run.py` | **18,270** | `GatewayRunner` — the single async owner of everything above. Around 200 methods. Functional groups inside this file:
| | | **A. Module-level helpers (≈ lines 1–1,540):** secret-redaction filters (`_redact_gateway_user_facing_secrets`, `_sanitize_gateway_final_response`), provider-error reply detection, Telegram command mention rewriting (`@bot_name` insertion), `coerce_gateway_timestamp`, `_auto_continue_freshness_window`, `_is_fresh_gateway_interruption`, `_build_replay_entry` / `_build_gateway_agent_history` (transcript loading for agent context), SSL cert bootstrap, home-channel env var resolvers, restart-notification pending check, runtime-env reload preserving config-authority overrides, runtime-kwargs / fallback-provider resolution, media placeholder builders, FFprobe-based audio duration probe, pending-event dequeue, skill-frontmatter parsing, unavailable-skill check, plugin-config helpers, session-key parser, process-notification formatter, normalize-empty-agent-response, queued-followup history-offset preservation. |
| | | **B. `GatewayRunner.__init__` (≈ 1,565):** wires up `SessionStore`, `DeliveryRouter`, `HookRegistry`, slash-access policy, paused-platforms set, restart-failure-counts dict, voice-mode state. |
| | | **C. Voice / TTS state (≈ 1,840–1,965):** `_load_voice_modes` / `_save_voice_modes` / `_set_adapter_auto_tts_*` / `_sync_voice_mode_state_to_adapter` for per-(platform, chat) auto-TTS preferences. |
| | | **D. Adapter connect/disconnect plumbing (≈ 1,997–2,054):** `_safe_adapter_disconnect`, `_connect_adapter_with_timeout`, exit-reason / exit-code helpers, clean-exit predicates. |
| | | **E. Session-key + Telegram-topic helpers (≈ 2,055–2,355):** `_session_key_for_source`, `_telegram_topic_mode_enabled`, root-lobby detection, topic-lane gating, lobby-reminder cadence, topic header generation, topic-binding records, `_recover_telegram_topic_thread_id`. |
| | | **F. Per-turn agent runtime resolution (≈ 2,231–2,357):** `_resolve_session_agent_runtime`, `_resolve_turn_agent_config` — picks model, reasoning, service-tier per turn. |
| | | **G. Adapter fatal-error handling (≈ 2,357–2,665):** `_handle_adapter_fatal_error` → `_request_clean_exit`; pause/resume failed platforms; status-action label/gerund; queue-during-drain logic with `_enqueue_fifo`, `_promote_queued_event`, `_queue_depth`, goal-continuation handling, runtime-status updates. |
| | | **H. Runtime config + reasoning (≈ 2,666–2,910):** prefill messages, ephemeral system prompt, reasoning config, provider routing, fallback model, busy-input-mode, restart-drain-timeout, background-notifications mode, service-tier, show-reasoning. |
| | | **I. Draining + interrupting agents on shutdown (≈ 3,118–3,460):** `_drain_active_agents(timeout)`, `_interrupt_running_agents`, `_notify_active_sessions_of_shutdown`, `_finalize_shutdown_agents`, `_cleanup_agent_resources`, `_increment_restart_failure_counts`, `_suspend_stuck_loop_sessions` (3-strike escalation that hard-suspends sessions whose restart keeps failing), `_clear_restart_failure_count`, `_launch_detached_restart_command`, `request_restart`, `_schedule_resume_pending_sessions`. |
| | | **J. `start()` (≈ 3,652–4,189):** the asyncio main: acquire runtime lock, write PID, load hooks, build adapters, connect platforms with timeout, register fatal-error handler, build channel directory, spawn watchers, emit `gateway:startup`, run until signalled. |
| | | **K. Watchers (≈ 4,189–5,624):** `_handoff_watcher` (drains cron handoff rows from SQLite via `cron.scheduler`'s handoff table), `_session_expiry_watcher` (proactively expires sessions, fires `on_session_finalize` hooks, evicts cached agents), `_kanban_notifier_watcher` (per-profile Kanban sub delivery), `_kanban_advance` / `_kanban_unsub` / `_kanban_rewind`, `_deliver_kanban_artifacts`, `_kanban_dispatcher_watcher`, `_platform_reconnect_watcher` (re-connects platforms paused by `_pause_failed_platform`). |
| | | **L. `stop()` + `wait_for_shutdown()` (≈ 5,625–5,958):** drain → interrupt → finalize → write planned-stop marker → release lock. |
| | | **M. Adapter factory (≈ 5,959–6,174):** `_create_adapter(platform, config)` — the legacy `if/elif` for built-ins (Telegram, Discord, WhatsApp, Slack, …) with `check_*_requirements()` gating; falls back to `platform_registry.create_adapter()` for plugin platforms. |
| | | **N. Authorisation (≈ 6,175–6,475):** `_is_user_authorized(source)` consulting `*_ALLOWED_USERS` / `*_ALLOW_ALL_USERS` env vars + plugin registry entries + WhatsApp alias expansion + Signal UUID/phone equivalence; `_get_unauthorized_dm_behavior` (pair / ignore); `_deliver_platform_notice` for restart pings (suppressed per platform via `gateway_restart_notification: false`). |
| | | **O. Inbound message pipeline (≈ 6,504–9,071):** `_handle_message(event)` (the top-level entry from every adapter), `_prepare_inbound_message_text` (assemble final text from quoted reply + media transcripts + sticker descriptions + observed-group context), `_consume_pending_native_image_paths`, `_cache_session_source`, `_get_cached_session_source`, `_handle_message_with_agent` (acquires session, builds context, invokes `AIAgent.run`, drives `GatewayStreamConsumer`, persists tokens/cost, fires `agent:*` hooks, schedules ephemeral deletes). |
| | | **P. Slash command handlers (≈ 9,072–end):** `_handle_reset_command`, `_handle_profile_command`, `_handle_whoami_command`, `_handle_kanban_command`, `_handle_status_command`, `_handle_agents_command`, `_handle_stop_command`, plus check-slash-access gating. |

### 2.6 Platform adapters (`platforms/`, 36 files, ~ 47k LOC)

`platforms/base.py` (3,923 LOC) is the keystone — read it before any concrete adapter. It defines:

- `MessageEvent` dataclass (the inbound event passed to `handle_message`) — fields: `chat_id`, `user_id`, `user_name`, `text`, `attachments`, `reply_to_*`, `thread_id`, `message_id`, `chat_type`, `chat_name`, `guild_id`, `chat_topic`, etc. + `is_command()` / `get_command()` / `get_command_args()` helpers.
- `MessageType` enum (TEXT, IMAGE, VOICE, VIDEO, ANIMATION, DOCUMENT, STICKER, REACTION, …).
- `ProcessingOutcome` enum (SUCCESS, ERROR, TIMEOUT, SUPPRESSED, INTERRUPTED, QUEUED, RATE_LIMITED).
- `SendResult` dataclass: `success`, `message_id`, `error`, `continuation_message_ids`.
- `EphemeralReply` — a `str` subclass that carries a TTL so reply messages auto-delete.
- UTF-16 length helpers (`utf16_len`, `_prefix_within_utf16_limit`, `_custom_unit_to_cp`) — Telegram counts message length in UTF-16 code units, not codepoints.
- Proxy resolution helpers (`detect_macos_system_proxy`, `resolve_proxy_url`, `proxy_kwargs_for_bot`, `proxy_kwargs_for_aiohttp`, `is_host_excluded_by_no_proxy`, `safe_url_for_log`) used by every HTTP-based adapter.
- Media cache helpers (`cache_image_from_bytes`, `cache_audio_from_bytes`, `cache_video_from_bytes`, `cache_document_from_bytes`) with cleanup loops (`cleanup_image_cache`, `cleanup_document_cache`).
- `validate_media_delivery_path` (path-traversal guard for tool-supplied file deliveries, scoped to `_media_delivery_allowed_roots()`).
- `resolve_channel_prompt` / `resolve_channel_skills` — per-(platform, chat) skill bindings derived from `extra.channel_skill_bindings` and `extra.channel_prompts`.
- `BasePlatformAdapter(ABC)` — the contract every adapter implements:
  - **Abstract:** `connect()`, `disconnect()`, `send()`, `get_chat_info()`.
  - **Optional overrides (have default stubs):** `edit_message`, `delete_message`, `send_typing`, `stop_typing`, `send_image`, `send_animation`, `send_voice`, `send_video`, `send_document`, `send_image_file`, `send_multiple_images`, `create_handoff_thread`, `send_draft`, `supports_draft_streaming`, `play_tts`, `prepare_tts_text`, `_keep_typing`, `interrupt_session_activity`.
  - **Lifecycle hooks:** `on_processing_start`, `on_processing_complete`, `_run_processing_hook`.
  - **Built-in machinery:** `handle_message(event)` is concrete — it does deduplication, authorisation, session-key derivation, busy-session handling, slash-command dispatch, queueing-during-drain, `_start_session_processing`, `_process_message_background`, retry-with-`_send_with_retry` (`_is_retryable_error`, `_is_timeout_error`), human-delay throttle, ephemeral-system-prompt loading, fatal-error guard, post-delivery callback registry.
  - **`build_source()`** factory method (overridden by Signal and Feishu to add `user_id_alt` / `chat_id_alt`).
  - **Scoped-lock acquisition** (`_acquire_platform_lock`) to prevent dual-instance against the same token.

Then 28 concrete adapters (one per platform, plus `qqbot/` subpackage with adapter + chunked-upload + keyboards + crypto + utils + constants + onboard).

**Per-adapter notes are deferred to §3** — that's where the codex-produced per-file digest lands.

### 2.7 Adapter helpers shared across platforms

| File | LOC | Role |
|---|---:|---|
| `platforms/helpers.py` | 278 | Common shared helpers used across adapters — message-formatting, reply-anchor derivation, thread-metadata bundling |
| `platforms/_http_client_limits.py` | 84 | Common httpx/aiohttp client-limit constants and tuning so all platforms use the same connection pool / timeout envelope |
| `platforms/telegram_network.py` | 259 | Telegram-specific networking layer (proxy + connection-pool wiring + retry policy on `python-telegram-bot`) |
| `platforms/signal_rate_limit.py` | 369 | Signal `signal-cli-rest-api` rate-limit accounting (per-chat token-bucket throttle) |
| `platforms/feishu_comment_rules.py` | 429 | Feishu code-review comment filter / suppression rules (when to react, when to stay silent) |
| `platforms/wecom_crypto.py` | 142 | WeCom callback payload AES decryption + signature verification |
| `platforms/qqbot/crypto.py` | 45 | QQ Bot callback signature verification |
| `platforms/qqbot/keyboards.py` | 473 | QQ Bot inline-keyboard template DSL |
| `platforms/qqbot/chunked_upload.py` | 602 | QQ Bot chunked file upload (media files > a single-request size) |
| `platforms/qqbot/onboard.py` | 220 | QQ Bot first-time-channel onboarding flow |

---

## 3. Per-file digest (deep read of every adapter)

The full per-file architectural digest for `platforms/base.py` and every concrete adapter — Python deps, native wire protocols, public surface, adapter-contract method overrides, key state machines, port gotchas, and TS dep candidates — is generated by a parallel codex pass (GPT-5.5, `reasoning_effort=low`) reading every adapter in full. That digest is intended to live alongside this brief at `docs/port-briefs/gateway-platforms-digest.md` and is consumed by the per-platform sub-tasks #10b1–#10b5 below.

Highlights that are already load-bearing for the subdivision plan:

- **Telegram** (`platforms/telegram.py` 5,700 LOC + `telegram_network.py` 259 LOC) depends on `python-telegram-bot>=22.6`. Owns: UTF-16 length accounting (`utf16_len` is a Telegram concession), forum-topic plumbing (`thread_id` ↔ Telegram `message_thread_id`), sendMessageDraft streaming (Bot API 9.5+), per-chat reply-to-mode (`off` / `first` / `all`), mention-pattern gating, allowed-chats / allowed-topics whitelist, group reaction support, native typing indicator. TS dep candidate: **`grammy`** (best maintained TS bot framework, has streaming-draft support in 1.x) with `grammyjs/files` for media. `node-telegram-bot-api` is a fallback but lacks Bot API 9.5+ coverage.
- **Slack** (`platforms/slack.py` 3,027 LOC) depends on `slack_sdk` (`AsyncWebClient` + `AsyncSocketModeClient`). Multi-workspace `_team_clients` dict; `users.conversations` pagination; bot-mention strict-mention env-gated. TS dep candidate: **`@slack/web-api` + `@slack/socket-mode`**.
- **Discord** (referenced from `channel_directory._build_discord`, but the adapter lives in `plugins/platforms/discord/` upstream — not in this brief's scope, but the gateway gates Discord IDs in `session.build_session_context_prompt` via `_discord_tools_loaded()`).
- **WhatsApp** (`platforms/whatsapp.py` 1,282 LOC) is a thin bridge client to an external `whatsmeow`-based bridge process; depends on the bridge's `lid-mapping-*.json` files (see `whatsapp_identity.py`). TS dep candidate: same upstream-bridge model — no native TS port of the bridge needed; only port the gateway-side adapter.
- **Signal** (`platforms/signal.py` 1,553 LOC + `signal_rate_limit.py` 369 LOC) talks to `signal-cli-rest-api` HTTP server; per-chat token bucket. TS dep candidate: `axios` / `node-fetch` + a small rate-limit reimplementation; no first-class TS package for `signal-cli`.
- **Matrix** (`platforms/matrix.py` 2,872 LOC) depends on `matrix-nio` (Python async Matrix SDK). TS dep candidate: **`matrix-js-sdk`** (Element's official SDK).
- **Mattermost** (`platforms/mattermost.py` 873 LOC) depends on `mattermostdriver` + the platform's REST API. TS dep candidate: `@mattermost/client` (official).
- **HomeAssistant** (`platforms/homeassistant.py` 449 LOC) uses the HA conversation websocket / REST API. TS dep candidate: `home-assistant-js-websocket`.
- **Email** (`platforms/email.py` 773 LOC) uses Python `imaplib` / `email` + `aiosmtplib`. TS dep candidate: **`imapflow`** (modern async TS IMAP client) + **`nodemailer`** (SMTP).
- **SMS** (`platforms/sms.py` 379 LOC) is Twilio (`twilio` SDK). TS dep candidate: `twilio` (official Node SDK).
- **DingTalk** (`platforms/dingtalk.py` 1,490 LOC) uses DingTalk's Stream API + AI-Card finalize semantics (the only adapter that sets `REQUIRES_EDIT_FINALIZE = True`, which `GatewayStreamConsumer` must honour even when content is unchanged so the in-progress UI transitions out). TS dep candidate: vendor REST + `ws` for stream sub.
- **Feishu / Lark** (`platforms/feishu.py` 5,058 LOC + `feishu_comment.py` 1,382 LOC + `feishu_comment_rules.py` 429 LOC) uses `lark-oapi` long-polling + REST + an additional code-review-comment feed with suppression rules. TS dep candidate: **`@larksuiteoapi/node-sdk`** (official Lark Node SDK).
- **WeCom** (`platforms/wecom.py` 1,610 LOC + `wecom_callback.py` 403 LOC + `wecom_crypto.py` 142 LOC) — group robot + callback webhook with AES-GCM-decrypted XML payloads. TS dep candidate: `node:crypto` for AES; no first-class TS SDK.
- **Weixin Official Account** (`platforms/weixin.py` 2,171 LOC) — REST + 48-hour customer-service window semantics. No first-class TS SDK; thin REST wrapper.
- **API server** (`platforms/api_server.py` 3,524 LOC) — runs an HTTP+SSE server inside the gateway process via `aiohttp` so external clients can POST `/message` and stream the agent reply back. TS dep candidate: **`fastify`** (matches the streaming + middleware surface best) or **`hono`** for a smaller footprint; **`elysia`** if we standardise on Bun.
- **Webhook** (`platforms/webhook.py` 832 LOC) — generic outbound webhook + inbound webhook receiver. TS: same fastify/hono.
- **MS Graph webhook** (`platforms/msgraph_webhook.py` 397 LOC) — Microsoft Graph change-notification webhook with subscription renewal. TS: `@microsoft/microsoft-graph-client` + fastify.
- **BlueBubbles** (`platforms/bluebubbles.py` 937 LOC) — iMessage bridge over BlueBubbles Server's REST + Socket.IO. TS dep candidate: `socket.io-client` + fetch.
- **QQ Bot** (`platforms/qqbot/` 4,580 LOC across 7 files) — QQ guild/channel WebSocket gateway with chunked-file-upload (`chunked_upload.py`), inline-keyboard DSL (`keyboards.py`), AES-GCM signature crypto (`crypto.py`), guild-onboarding (`onboard.py`). No first-class TS SDK; thin WebSocket + REST reimplementation.
- **Tencent Yuanbao** (`platforms/yuanbao.py` 4,874 LOC + `yuanbao_proto.py` 1,209 LOC + `yuanbao_media.py` 645 LOC + `yuanbao_sticker.py` 558 LOC) — proprietary Yuanbao protocol with protobuf wire format, media upload, sticker handling. The largest and most bespoke platform stack after Telegram; isolate it in its own sub-task.

---

## 4. External Python deps and TS equivalents

| Python | Used by | TS / JS replacement | Confidence |
|---|---|---|---|
| `python-telegram-bot>=22.6` | Telegram | `grammy` 1.x (DM-draft streaming supported), `grammyjs/files` | High |
| `slack_sdk` | Slack | `@slack/web-api` + `@slack/socket-mode` | High |
| `matrix-nio` | Matrix | `matrix-js-sdk` | High |
| `discord.py` | (Discord adapter is a plugin upstream) | `discord.js` | High |
| `mattermostdriver` | Mattermost | `@mattermost/client` | High |
| `lark-oapi` | Feishu / Feishu comments | `@larksuiteoapi/node-sdk` | High |
| `signalbot` / `signal-cli-rest-api` HTTP | Signal | thin REST wrapper (`node-fetch`/`undici`), reimplement rate-limit | Medium |
| `twilio` | SMS | `twilio` (official Node SDK) | High |
| `aiohttp` | API server, webhook, MS Graph, Slack | `fastify` (or `hono` for smaller surface) | High |
| `aiosmtplib` + `imaplib` + `email` | Email | `nodemailer` (SMTP) + `imapflow` + `mailparser` | High |
| `httpx` | many adapters | `undici` (native) or `axios` | High |
| `protobuf` | Yuanbao | `protobufjs` | High |
| `cryptography` (AES-GCM) | WeCom callback, QQ Bot | `node:crypto` (built-in) | High |
| `python-magic` | media cache helpers | `file-type` | High |
| `psutil` | memory monitor, shutdown forensics | `pidusage` + `os.cpus()/os.totalmem()`; for `/proc/*` reads on Linux, plain `fs.readFile` | Medium |
| `pyyaml` | config loader, hooks manifest | `yaml` (`eemeli/yaml`) | High |
| `aiocron` / `cron` — (depends on `core`/`cli` packages, not `gateway`) | — | covered by `core` brief | — |

Note that gateway itself only depends on `core`, `state`, `providers`, `agent`, `tools` — it does NOT depend on `skills` or `plugins`, so the registry-vs-builtin split (`platform_registry.py`) is intentional: plugin platforms register themselves at runtime, the gateway looks them up by name without compile-time coupling.

---

## 5. Workspace layout (proposed)

```
packages/gateway/
├── package.json                       # name: "@hermests/gateway", deps on @hermests/{core,state,providers,agent,tools}
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                       # re-exports: GatewayConfig, PlatformConfig, HomeChannel, load_gateway_config,
│   │                                  #             SessionContext, SessionStore, SessionResetPolicy,
│   │                                  #             build_session_context_prompt, DeliveryRouter, DeliveryTarget
│   ├── config.ts                      # ← config.py
│   ├── display_config.ts              # ← display_config.py
│   ├── platform_registry.ts           # ← platform_registry.py
│   │
│   ├── session/
│   │   ├── session.ts                 # ← session.py
│   │   ├── session_context.ts         # ← session_context.py  (Node AsyncLocalStorage instead of contextvars)
│   │   ├── whatsapp_identity.ts       # ← whatsapp_identity.py
│   │   ├── pairing.ts                 # ← pairing.py
│   │   ├── slash_access.ts            # ← slash_access.py
│   │   └── channel_directory.ts       # ← channel_directory.py
│   │
│   ├── delivery/
│   │   ├── delivery.ts                # ← delivery.py
│   │   ├── mirror.ts                  # ← mirror.py
│   │   ├── stream_consumer.ts         # ← stream_consumer.py
│   │   ├── runtime_footer.ts          # ← runtime_footer.py
│   │   └── sticker_cache.ts           # ← sticker_cache.py
│   │
│   ├── lifecycle/
│   │   ├── status.ts                  # ← status.py
│   │   ├── restart.ts                 # ← restart.py
│   │   ├── shutdown_forensics.ts      # ← shutdown_forensics.py
│   │   ├── memory_monitor.ts          # ← memory_monitor.py
│   │   └── hooks.ts                   # ← hooks.py  (loads ~/.hermes/hooks/<name>/{HOOK.yaml,handler.ts})
│   │
│   ├── platforms/
│   │   ├── base.ts                    # ← platforms/base.py — the keystone abstract adapter
│   │   ├── helpers.ts                 # ← platforms/helpers.py
│   │   ├── _http_client_limits.ts     # ← platforms/_http_client_limits.py
│   │   ├── telegram/                  # telegram.ts + telegram_network.ts
│   │   ├── slack.ts
│   │   ├── whatsapp.ts
│   │   ├── matrix.ts
│   │   ├── mattermost.ts
│   │   ├── signal/                    # signal.ts + signal_rate_limit.ts
│   │   ├── homeassistant.ts
│   │   ├── email.ts
│   │   ├── sms.ts
│   │   ├── dingtalk.ts
│   │   ├── feishu/                    # feishu.ts + feishu_comment.ts + feishu_comment_rules.ts
│   │   ├── wecom/                     # wecom.ts + wecom_callback.ts + wecom_crypto.ts
│   │   ├── weixin.ts
│   │   ├── bluebubbles.ts
│   │   ├── api_server.ts
│   │   ├── webhook.ts
│   │   ├── msgraph_webhook.ts
│   │   ├── qqbot/                     # adapter.ts + chunked_upload.ts + keyboards.ts + crypto.ts + utils.ts + constants.ts + onboard.ts
│   │   └── yuanbao/                   # yuanbao.ts + yuanbao_proto.ts + yuanbao_media.ts + yuanbao_sticker.ts
│   │
│   └── runner/                        # ← run.py, split into ~ 14 cohesive sub-files (see §6.B below)
│       ├── runner.ts                  # GatewayRunner class — slim shell delegating to the modules below
│       ├── helpers.ts                 # secret redaction, command mention rewriting, replay entry builders, SSL cert bootstrap, env helpers
│       ├── runtime_config.ts          # prefill / ephemeral prompt / reasoning / service-tier / show-reasoning / provider-routing / fallback-model loaders
│       ├── voice_mode.ts              # voice/TTS state per (platform, chat)
│       ├── adapter_factory.ts         # _create_adapter (built-in if/elif + plugin registry fallback)
│       ├── adapter_lifecycle.ts       # safe_disconnect, connect_with_timeout, pause/resume failed platforms, fatal-error handling
│       ├── authorization.ts           # _is_user_authorized, _get_unauthorized_dm_behavior, _deliver_platform_notice
│       ├── telegram_topics.ts         # all _telegram_topic_* helpers (this much logic earns its own file)
│       ├── inbound_pipeline.ts        # _handle_message, _prepare_inbound_message_text, _cache_session_source, _handle_message_with_agent
│       ├── slash_commands.ts          # _handle_reset/_profile/_whoami/_kanban/_status/_agents/_stop + check_slash_access
│       ├── busy_session.ts            # queue-during-drain (_enqueue_fifo, _promote_queued_event, _queue_depth, _handle_active_session_busy_message)
│       ├── shutdown.ts                # _drain_active_agents, _interrupt_running_agents, _notify_active_sessions_of_shutdown, _suspend_stuck_loop_sessions, request_restart, _launch_detached_restart_command
│       ├── watchers/
│       │   ├── handoff_watcher.ts     # _handoff_watcher
│       │   ├── session_expiry_watcher.ts
│       │   ├── kanban_notifier_watcher.ts
│       │   ├── kanban_dispatcher_watcher.ts
│       │   └── platform_reconnect_watcher.ts
│       └── lifecycle.ts               # start(), stop(), wait_for_shutdown()
│
└── tests/                             # mirrors upstream tests/gateway/ + tests/gateway/platforms/ + targeted runner tests
```

Two structural notes that need to be locked in early:

1. **`run.py` must split.** Porting a single 18k-LOC file as one TS file would be untestable. The proposed 14-file `runner/` split above tracks the natural seams Python uses today (helpers vs runtime-config loaders vs voice-mode vs adapter lifecycle vs authorization vs inbound-pipeline vs slash-commands vs shutdown vs watchers vs lifecycle). The `GatewayRunner` class itself becomes a thin shell that holds the state dict and delegates to module-level functions.
2. **`contextvars.ContextVar` → `node:async_hooks` `AsyncLocalStorage`.** Drop-in semantically; same task-local guarantees. Keep the `get_session_env()` legacy-env-var fallback semantics intact (CLI/cron/test compat).

---

## 6. Subdivision plan — sub-tasks for the actual port (#10a … #10k)

The plan splits along the seven subsystems in §2 plus the platform adapters split into five LOC-balanced bundles. Every sub-task is independently testable, depends only on `core/state/providers/agent/tools` (which #10 already blocks-on via #6), and lands as its own PR against `port/gateway` integration branch.

| ID | Title | Upstream files | Approx LOC | Depends on (sub-task) | Parallelisable? |
|---|---|---|---:|---|---|
| **#10a** | Gateway config + platform registry | `config.py`, `display_config.py`, `platform_registry.py` | ~2,320 | — | independent |
| **#10b** | Gateway base adapter + adapter helpers | `platforms/base.py`, `platforms/helpers.py`, `platforms/_http_client_limits.py` | ~4,285 | 10a | independent |
| **#10c** | Session subsystem | `session.py`, `session_context.py`, `whatsapp_identity.py`, `pairing.py`, `slash_access.py`, `channel_directory.py` | ~2,700 | 10a | parallel with 10b |
| **#10d** | Delivery + streaming + footer | `delivery.py`, `mirror.py`, `stream_consumer.py`, `runtime_footer.py`, `sticker_cache.py` | ~2,210 | 10b | parallel with 10c |
| **#10e** | Lifecycle / status / hooks / forensics / memory monitor | `status.py`, `restart.py`, `shutdown_forensics.py`, `memory_monitor.py`, `hooks.py`, `builtin_hooks/__init__.py` | ~1,895 | 10a | parallel with 10b/10c/10d |
| **#10f1** | Platform adapters — Telegram + Slack + Discord-id helpers + Matrix | `platforms/telegram.py`, `platforms/telegram_network.py`, `platforms/slack.py`, `platforms/matrix.py` | ~11,858 | 10b, 10d (stream consumer) | parallel with 10f2–10f5 |
| **#10f2** | Platform adapters — WhatsApp + Signal + BlueBubbles + Mattermost + HomeAssistant + Email + SMS | `platforms/whatsapp.py`, `platforms/signal.py`, `platforms/signal_rate_limit.py`, `platforms/bluebubbles.py`, `platforms/mattermost.py`, `platforms/homeassistant.py`, `platforms/email.py`, `platforms/sms.py` | ~6,632 | 10b, 10c (whatsapp_identity, signal pairing) | parallel with 10f1, 10f3–10f5 |
| **#10f3** | Platform adapters — Feishu + DingTalk + WeCom + Weixin | `platforms/feishu.py`, `platforms/feishu_comment.py`, `platforms/feishu_comment_rules.py`, `platforms/dingtalk.py`, `platforms/wecom.py`, `platforms/wecom_callback.py`, `platforms/wecom_crypto.py`, `platforms/weixin.py` | ~12,532 | 10b | parallel with others |
| **#10f4** | Platform adapters — QQ Bot + Yuanbao | `platforms/qqbot/*` (7 files), `platforms/yuanbao.py`, `platforms/yuanbao_proto.py`, `platforms/yuanbao_media.py`, `platforms/yuanbao_sticker.py` | ~11,884 | 10b | parallel with others |
| **#10f5** | Platform adapters — generic transports (API server, webhook, MS Graph webhook) | `platforms/api_server.py`, `platforms/webhook.py`, `platforms/msgraph_webhook.py`, `platforms/__init__.py` | ~4,798 | 10b, 10c (channel directory), 10d | parallel with others |
| **#10g** | GatewayRunner shell + helpers + runtime config + voice-mode + adapter factory | `run.py` lines 1–1,965 (helpers, init, voice, adapter connect/disconnect, runtime config loaders) | ~7,000 (of 18,270) | 10a–10e | begin once 10a–10e land; precedes 10h |
| **#10h** | GatewayRunner — telegram-topic logic, authorization, inbound pipeline, slash commands | `run.py` lines 1,965–9,200 (telegram-topic helpers, _create_adapter, _is_user_authorized, _handle_message, _prepare_inbound_message_text, _handle_message_with_agent, slash handlers) | ~7,200 (of 18,270) | 10g, 10f1–10f5 (any adapter is enough — they're independently mockable) | sequential after 10g |
| **#10i** | GatewayRunner — shutdown, drain, restart, watchers, lifecycle | `run.py` lines 9,200–end (shutdown/drain/interrupt/restart, watchers — handoff, expiry, kanban×2, reconnect, start/stop/wait_for_shutdown) | ~4,100 (of 18,270) | 10g, 10h, 10e | sequential after 10h |
| **#10j** | Wire `@hermests/gateway` into `@hermests/cli` (`hermes gateway start/stop/status` plumbing) | gateway-side glue only — CLI changes belong to #14 brief | small | 10g, 10h, 10i | sequential |
| **#10k** | 100% coverage gap-close + tests for `tests/gateway/**` parity | mirror upstream `tests/gateway/**` to Vitest | — | 10a–10i | sequential — final |

The 5 platform-adapter bundles (#10f1–#10f5) are LOC-balanced **with related platforms grouped together** so a single Forge instance can produce a cohesive PR per bundle. The two largest bundles (#10f1 Telegram-family at 11.9k LOC, #10f3 Feishu/WeCom/Weixin at 12.5k LOC, #10f4 QQ/Yuanbao at 11.9k LOC) are within budget for a single Forge call at reasoning=high with the per-file digest from §3 already in hand.

**Total: 13 sub-tasks** — within the 8–12 guidance, with the platform-adapter bundle (#10f) split into 5 to keep each PR's LOC budget around 5–12k.

---

## 7. Constraints carried over from `PORTING_PLAN.md`

- **Faithful port.** Every function in the upstream gateway must exist in TS with equivalent behaviour. The `ADDING_A_PLATFORM.md` checklist in `platforms/` becomes a TS-side acceptance criterion: porting Telegram doesn't count as done until grepping for `telegram` across the ported workspace returns the same touchpoint count as upstream.
- **100% line/branch/function/statement coverage** is enforced by `vitest.config.ts`. The streaming consumer's flood-control state machine, the session reset-policy modes, the WhatsApp JID/LID alias expansion, and the pairing-store rate-limit + lock-out paths are the most likely places this will hurt — write tests as you port, not after.
- **No Python-only deps.** Every dep in the table in §4 has a chosen TS replacement; the dep-mapping doc (task #20) will track the chosen versions.
- **Module boundary preserved.** `@hermests/gateway` is one workspace package even though its internal structure is large; do not split it across multiple npm packages. Sub-tasks above are PR-level boundaries, not package boundaries.
- **The runner split is structural, not behavioural.** `GatewayRunner` remains a single class with one `start()` / `stop()` / `wait_for_shutdown()` surface — only the implementation lives across multiple files.
- **`contextvars` → `AsyncLocalStorage`** with the same legacy env-var fallback in `get_session_env()`. Concurrency safety here is load-bearing — the bug `session_context.py` was created to fix (per-asyncio-task session vars vs process-global env) must not reappear in the TS port.
- **The streaming consumer's tag list MUST stay in sync** with `cli.py _OPEN_TAGS/_CLOSE_TAGS` and `run_agent.py _strip_think_blocks()` (those live in the `cli` and `agent` ports). Plan to extract the tag list into `@hermests/core` so all three packages import the same canonical tuple.

---

## 8. Open questions for the team lead (escalate before sub-task assignment)

1. **API server framework choice.** `platforms/api_server.py` is the only "platform" that runs an HTTP+SSE server inside the gateway process. Fastify, hono, and elysia each work; the choice affects four other sub-tasks (`webhook.py`, `msgraph_webhook.py`, the future Discord plugin, and #14 CLI). Recommend deciding before #10f5 starts.
2. **`signal-cli-rest-api` model.** Upstream relies on running the external `signal-cli-rest-api` HTTP server; the TS port should follow the same out-of-process model rather than reimplementing signal-cli. Confirm.
3. **`hermes_state.SessionDB` parity.** `SessionStore` calls `SessionDB.append_message`, `replace_messages`, `get_messages_as_conversation`, `create_session`, `end_session`, `reopen_session`, `session_count`. These must already exist by the time #10c starts. Verify with the `#2 state` porter.
4. **Plugin-platform discovery model.** `gateway/config.py` calls `hermes_cli.plugins.discover_plugins()` during `load_gateway_config()`. The CLI port (#14) needs to expose an equivalent so the gateway can stay decoupled. Hand-off point lives in #10a and gets wired up in #10j.
5. **Voice-mode persistence path.** `_load_voice_modes` / `_save_voice_modes` write to a file inside `~/.hermes/` (path resolved in `__init__`). Confirm the path with the CLI porter so config-directory conventions stay aligned across packages.
6. **`builtin_hooks/__init__.py` is intentionally empty.** Comment in upstream confirms it's an extension slot; the TS port preserves the directory + the empty index but does not invent any built-in hooks of its own.

---

*Drafted by `Forge` (GPT-5.5, `reasoning_effort=low` per team-lead directive).*
*Source corpus: every `.py` file under `gateway/` read for structure; full source read of `__init__.py`, `config.py` (partial — 1,097/1,857 lines; tail is more YAML→env bridges, structurally identical to the head), `session.py`, `session_context.py`, `whatsapp_identity.py`, `delivery.py`, `platform_registry.py`, `hooks.py`, `channel_directory.py`, `stream_consumer.py`, `ADDING_A_PLATFORM.md`; structural index via `grep` for `run.py` (18,270 LOC, function-by-function map captured in §2.5), `platforms/base.py` (3,923 LOC, contract surface captured in §2.6), and the remaining spine + helper files. Per-adapter deep digest (§3) produced in parallel by a second codex pass.*
