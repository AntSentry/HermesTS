# HermesTS Glossary

Domain terminology used in `hermes-agent` (upstream Python) and `@hermests/*`
(this TypeScript port). Every entry includes the file and line where the term
is first introduced upstream, plus the target `@hermests/*` package that hosts
the equivalent code in the port.

Upstream root for all `upstream:` paths:
`/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/`

Conventions used in entries:

- **First introduced at** — first canonical definition site (class declaration,
  constant assignment, or named API surface) in the upstream Python tree. For
  doctrine terms documented in `AGENTS.md` first, the AGENTS.md line is cited.
- **In the port** — the target `@hermests/<pkg>` workspace package per
  `PORTING_PLAN.md` § Dependency order.
- **Related** — sibling terms, with `[[wikilink]]`-style references resolved
  inside this document via the table of contents below.

---

## Table of contents

- [ACP / Agent Client Protocol](#acp--agent-client-protocol)
- [AIAgent](#aiagent)
- [Approval (command approval)](#approval-command-approval)
- [Auxiliary client](#auxiliary-client)
- [Background process notifications](#background-process-notifications)
- [BasePlatformAdapter](#baseplatformadapter)
- [BatchRunner](#batchrunner)
- [Board (kanban)](#board-kanban)
- [Bootstrap (hermes_bootstrap)](#bootstrap-hermes_bootstrap)
- [Catchup window (cron)](#catchup-window-cron)
- [CDPSupervisor](#cdpsupervisor)
- [Checkpoint](#checkpoint)
- [Clarify](#clarify)
- [CommandDef](#commanddef)
- [Compression (context / trajectory)](#compression-context--trajectory)
- [ContextEngine](#contextengine)
- [ContextReference](#contextreference)
- [CredentialPool](#credentialpool)
- [Cron job](#cron-job)
- [Curator](#curator)
- [Delegation (delegate_task)](#delegation-delegate_task)
- [DeliveryRouter](#deliveryrouter)
- [Dispatcher (kanban)](#dispatcher-kanban)
- [Environment (terminal backend)](#environment-terminal-backend)
- [EventBridge (MCP)](#eventbridge-mcp)
- [FileOperations](#fileoperations)
- [FTS5 session search](#fts5-session-search)
- [Gateway](#gateway)
- [GatewayRunner](#gatewayrunner)
- [HERMES_HOME](#hermes_home)
- [HermesACPAgent](#hermesacpagent)
- [HermesCLI](#hermescli)
- [HookRegistry (gateway)](#hookregistry-gateway)
- [Hub / Skills Hub](#hub--skills-hub)
- [Insights (/insights)](#insights-insights)
- [Interrupt](#interrupt)
- [IterationBudget](#iterationbudget)
- [KawaiiSpinner](#kawaiispinner)
- [Kanban](#kanban)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
- [MemoryManager](#memorymanager)
- [MemoryProvider](#memoryprovider)
- [Message guard (gateway)](#message-guard-gateway)
- [MiniSWERunner](#miniswerunner)
- [Optional skill](#optional-skill)
- [Pairing (DM pairing)](#pairing-dm-pairing)
- [Platform (messaging)](#platform-messaging)
- [PlatformRegistry](#platformregistry)
- [Plugin (general)](#plugin-general)
- [PluginContext](#plugincontext)
- [PluginManager](#pluginmanager)
- [Profile](#profile)
- [Prompt caching](#prompt-caching)
- [ProviderProfile](#providerprofile)
- [Reasoning content](#reasoning-content)
- [Routine](#routine)
- [Run loop (agent loop)](#run-loop-agent-loop)
- [SessionContext](#sessioncontext)
- [SessionDB](#sessiondb)
- [SessionSource](#sessionsource)
- [SessionStore](#sessionstore)
- [Skill](#skill)
- [SkillSource](#skillsource)
- [SkinConfig / Skin engine](#skinconfig--skin-engine)
- [Slash command](#slash-command)
- [SlashAccessPolicy](#slashaccesspolicy)
- [Streaming](#streaming)
- [Tenant (kanban)](#tenant-kanban)
- [Think scrubber](#think-scrubber)
- [Tool](#tool)
- [Tool call](#tool-call)
- [ToolEntry](#toolentry)
- [ToolRegistry](#toolregistry)
- [Toolset](#toolset)
- [TOOLSETS / `_HERMES_CORE_TOOLS`](#toolsets--_hermes_core_tools)
- [Trajectory](#trajectory)
- [TrajectoryCompressor](#trajectorycompressor)
- [TUI (`hermes --tui`)](#tui-hermes---tui)
- [TUI gateway](#tui-gateway)
- [WAL fallback](#wal-fallback)

---

## ACP / Agent Client Protocol

The standardised JSON-RPC protocol that lets IDE-style hosts (VS Code, Zed,
JetBrains) drive an external agent process. `acp_adapter/` is Hermes' ACP
server implementation; it exposes `HermesACPAgent` over stdio so an editor
can run Hermes as its agent backend without going through the gateway.

- **First introduced at:** `upstream:acp_adapter/server.py:445` (`class HermesACPAgent(acp.Agent)`)
- **In the port:** `@hermests/acp`
- **Related:** [HermesACPAgent](#hermesacpagent),
  [Gateway](#gateway), [TUI gateway](#tui-gateway)

## AIAgent

The conversation-loop orchestrator. Owns the model client, tool dispatch,
iteration budget, interrupt flag, session/credential context, and the
synchronous `run_conversation()` / `chat()` entry points. Its `__init__`
takes ~60 keyword parameters in practice (see `AGENTS.md`).

- **First introduced at:** `upstream:run_agent.py:326` (`class AIAgent`)
- **In the port:** `@hermests/agent`
- **Related:** [Run loop (agent loop)](#run-loop-agent-loop),
  [IterationBudget](#iterationbudget), [Tool call](#tool-call),
  [Trajectory](#trajectory)

## Approval (command approval)

Per-command and per-pattern allow / deny gate applied before tools that can
mutate the host (shell, file writes, browser navigations to new origins, etc.)
execute. Lives in `tools/approval.py`; surfaced to the user via the gateway's
inline `/approve` / `/deny` flow or the TUI `approval.respond` event.

- **First introduced at:** `upstream:tools/approval.py:1` (module — `approval`
  policy registry; CLI integration in `AGENTS.md:535`)
- **In the port:** `@hermests/tools` (policy core) + `@hermests/gateway`
  (UX surface)
- **Related:** [Message guard (gateway)](#message-guard-gateway),
  [Pairing (DM pairing)](#pairing-dm-pairing),
  [SlashAccessPolicy](#slashaccesspolicy)

## Auxiliary client

A side-LLM channel for non-conversational work (curator review, vision
extraction, embeddings, title generation, session search synthesis). Each
`auxiliary.*` task can pin its own provider / model / base_url /
max_tokens / reasoning_effort via `config.yaml`.

- **First introduced at:** `upstream:agent/auxiliary_client.py:908`
  (`class CodexAuxiliaryClient`); doctrine in `AGENTS.md:351`
- **In the port:** `@hermests/agent`
- **Related:** [Curator](#curator), [Insights (/insights)](#insights-insights)

## Background process notifications

Gateway-side watcher that observes long-running
`terminal(background=true, notify_on_complete=true)` invocations and triggers
a fresh agent turn when the underlying process exits. Verbosity controlled by
`display.background_process_notifications` (`all` / `result` / `error` / `off`).

- **First introduced at:** `upstream:AGENTS.md:879`
  (policy section "Background Process Notifications (Gateway)")
- **In the port:** `@hermests/gateway`
- **Related:** [Gateway](#gateway), [Tool call](#tool-call)

## BasePlatformAdapter

Abstract base every messaging platform (Telegram, Discord, Slack, WhatsApp,
Signal, Matrix, Email, …) inherits from. Defines the contract for
`connect`, `send`, `receive`, queueing under
`_active_sessions`, and the message-guard hooks that suppress new
turns while an agent is currently running.

- **First introduced at:** `upstream:gateway/platforms/base.py:1370`
- **In the port:** `@hermests/gateway`
- **Related:** [Platform (messaging)](#platform-messaging),
  [Gateway](#gateway), [Message guard (gateway)](#message-guard-gateway)

## BatchRunner

Parallel trajectory-generation engine. Spawns many independent `AIAgent`
runs against a shared task pool, persisting each conversation as a JSONL
trajectory file. Distinct from the gateway runtime — batch sessions are not
written to `state.db` and are explicitly excluded from FTS5 search.

- **First introduced at:** `upstream:batch_runner.py:527` (`class BatchRunner`)
- **In the port:** `@hermests/batch`
- **Related:** [Trajectory](#trajectory),
  [TrajectoryCompressor](#trajectorycompressor),
  [MiniSWERunner](#miniswerunner)

## Board (kanban)

The hard isolation boundary in the kanban subsystem. A worker spawned by
the dispatcher inherits `HERMES_KANBAN_BOARD` in its environment and cannot
see tasks on any other board. One process can host many boards.

- **First introduced at:** `upstream:AGENTS.md:846` (isolation model section)
- **In the port:** `@hermests/cli` (kanban-db + kanban CLI),
  `@hermests/plugins` (kanban plugin assets)
- **Related:** [Kanban](#kanban), [Tenant (kanban)](#tenant-kanban),
  [Dispatcher (kanban)](#dispatcher-kanban)

## Bootstrap (`hermes_bootstrap`)

Tiny module that MUST be the first import on Windows — it forces UTF-8 stdio
on the running interpreter. No-op on POSIX. `run_agent.py`, `cli.py`, and
gateway entry points all import it before anything else.

- **First introduced at:** `upstream:hermes_bootstrap.py:59`
  (`def apply_windows_utf8_bootstrap`)
- **In the port:** `@hermests/core`
- **Related:** [HERMES_HOME](#hermes_home),
  [Profile](#profile)

## Catchup window (cron)

How far into the past the cron scheduler will reach to fire a job whose
trigger fell during a downtime. Defined as half the job's period, clamped
to a [120s, 2h] range. Prevents resurrection of jobs that were missed by
days while still letting short-cycle jobs catch up after a brief outage.

- **First introduced at:** `upstream:AGENTS.md:806` (hardening invariants
  section of Cron)
- **In the port:** `@hermests/cli` (cron subcommand + scheduler)
- **Related:** [Cron job](#cron-job), [Routine](#routine)

## CDPSupervisor

Chrome DevTools Protocol watcher used by the browser tool. Tracks frames,
dialogs, console events, and surfaces a snapshot used by the agent loop
between turns to make sense of asynchronous page state.

- **First introduced at:** `upstream:tools/browser_supervisor.py:259`
- **In the port:** `@hermests/tools`
- **Related:** [Tool](#tool)

## Checkpoint

Per-turn durable snapshot of the agent's working state — written by
`tools/checkpoint_manager.py` and consumed by `/undo`, `/retry`, and
crash recovery. Sidecar state lives next to the active session in
`HERMES_HOME`.

- **First introduced at:** `upstream:tools/checkpoint_manager.py:575`
  (`class CheckpointManager`)
- **In the port:** `@hermests/tools`
- **Related:** [SessionDB](#sessiondb), [HERMES_HOME](#hermes_home)

## Clarify

Out-of-band channel the agent uses to ask the user a structured question
mid-turn without ending the conversation. `tools/clarify_tool.py` is the
agent-facing primitive; the gateway routes responses back through
`clarify.respond` (TUI) or a `/clarify` reply (messaging).

- **First introduced at:** `upstream:tools/clarify_tool.py:1`
  (module; doctrine in `AGENTS.md:218`)
- **In the port:** `@hermests/tools` + `@hermests/gateway`
- **Related:** [Slash command](#slash-command),
  [Approval (command approval)](#approval-command-approval)

## CommandDef

A single immutable record in the central `COMMAND_REGISTRY` describing one
slash command — its canonical name, aliases, description, category, arg
hint, and gating flags (`cli_only`, `gateway_only`, `gateway_config_gate`).
Every downstream surface (dispatch, help, Telegram BotCommand menu, Slack
subcommand map, autocomplete) derives from this registry.

- **First introduced at:** `upstream:hermes_cli/commands.py:46`
- **In the port:** `@hermests/cli`
- **Related:** [Slash command](#slash-command), [HermesCLI](#hermescli),
  [Gateway](#gateway)

## Compression (context / trajectory)

Two related but distinct operations:

1. **Context compression** — collapses the middle of a live conversation to
   stay within the model's context window. Triggers a `parent_session_id`
   chain in `SessionDB` so the pre-compression history is recoverable.
2. **Trajectory compression** — post-processing of completed conversations
   for training-corpus use; preserves protected turns and replaces the
   compressible middle with a single human summary.

- **First introduced at:** `upstream:agent/context_compressor.py:454`
  (`class ContextCompressor`) and
  `upstream:trajectory_compressor.py:332` (`class TrajectoryCompressor`)
- **In the port:** `@hermests/agent` (context),
  `@hermests/trajectory` (training-corpus)
- **Related:** [ContextEngine](#contextengine),
  [TrajectoryCompressor](#trajectorycompressor),
  [SessionDB](#sessiondb)

## ContextEngine

Abstract base for the layer that decides what context is loaded at session
start — memory injection, context files (`AGENTS.md`, `CLAUDE.md`),
subdirectory hints, and any plugin-supplied context. `ContextCompressor` is
itself a `ContextEngine` subclass.

- **First introduced at:** `upstream:agent/context_engine.py:32`
- **In the port:** `@hermests/agent`
- **Related:** [Compression (context / trajectory)](#compression-context--trajectory),
  [Plugin (general)](#plugin-general)

## ContextReference

A typed pointer to an external artifact the agent has loaded into context
(file, URL, screenshot, MCP resource). Used by the redaction and replay
machinery so a reference can be re-resolved after compression rather than
inlining its full payload into history.

- **First introduced at:** `upstream:agent/context_references.py:41`
- **In the port:** `@hermests/agent`
- **Related:** [ContextEngine](#contextengine),
  [Think scrubber](#think-scrubber)

## CredentialPool

A pool of provider credentials with rotation, health-state, and
rate-limit / quota tracking. Lets a single agent transparently fall over
between API keys when one is rate-limited or revoked.

- **First introduced at:** `upstream:agent/credential_pool.py:389`
- **In the port:** `@hermests/agent`
- **Related:** [ProviderProfile](#providerprofile),
  [AIAgent](#aiagent)

## Cron job

A user-defined or agent-defined recurring task scheduled via the `cronjob`
tool, the `hermes cron` CLI, or the `/cron` slash command. Supports duration
("30m"), "every" phrases ("every monday 9am"), 5-field cron expressions,
or a one-shot ISO timestamp. Each job is hard-interrupted at 3 minutes to
keep runaway agent loops from starving the scheduler.

- **First introduced at:** `upstream:cron/jobs.py:1` (module)
- **In the port:** `@hermests/cli` (cron + scheduler under
  `support/gateway-runtime`)
- **Related:** [Catchup window (cron)](#catchup-window-cron),
  [Routine](#routine), [Gateway](#gateway)

## Curator

Background skill-maintenance system that observes usage on agent-created
skills, runs a periodic LLM review pass, and auto-archives stale ones.
Never deletes; archives go to `~/.hermes/skills/.archive/` and are
restorable. Pinned skills are exempt from every auto-transition.

- **First introduced at:** `upstream:agent/curator.py:1`
  (module; CLI in `hermes_cli/curator.py`; doctrine in `AGENTS.md:751`)
- **In the port:** `@hermests/agent` (review + backup),
  `@hermests/cli` (verbs)
- **Related:** [Skill](#skill), [Auxiliary client](#auxiliary-client),
  [Hub / Skills Hub](#hub--skills-hub)

## Delegation (`delegate_task`)

Synchronous spawn of a subagent with an isolated context and terminal
session. `role="leaf"` (default) is a focused worker that cannot recurse;
`role="orchestrator"` can call `delegate_task` itself, bounded by
`delegation.max_spawn_depth`. Batch shape accepts `tasks: [...]` for
parallel execution capped by `delegation.max_concurrent_children`.

- **First introduced at:** `upstream:tools/delegate_tool.py:532`
  (`class DelegateEvent`; full doctrine `AGENTS.md:718`)
- **In the port:** `@hermests/tools`
- **Related:** [AIAgent](#aiagent), [Toolset](#toolset)

## DeliveryRouter

Picks which gateway platform to deliver an outbound message on when the
agent owns multiple sticky channels for the same user (e.g. user opened a
DM on Telegram but cron output should go to Email).

- **First introduced at:** `upstream:gateway/delivery.py:109`
- **In the port:** `@hermests/gateway`
- **Related:** [Platform (messaging)](#platform-messaging),
  [Gateway](#gateway)

## Dispatcher (kanban)

The long-lived loop that, by default every 60 seconds, reclaims stale
worker claims, promotes ready tasks, atomically claims them, and spawns
the assigned profile as a worker. Runs **inside the gateway** by default
via `kanban.dispatch_in_gateway: true`; can also run standalone via the
shipped systemd unit.

- **First introduced at:** `upstream:AGENTS.md:838` (Dispatcher section
  of Kanban)
- **In the port:** `@hermests/cli` (dispatcher) + `@hermests/plugins`
  (`plugins/kanban/`)
- **Related:** [Kanban](#kanban), [Board (kanban)](#board-kanban),
  [Profile](#profile)

## Environment (terminal backend)

The pluggable execution sandbox a tool call runs against — local shell,
Docker container, SSH host, Singularity image, Modal function, Daytona
workspace, or Vercel Sandbox. Implementations live under
`tools/environments/` and inherit from `BaseEnvironment`.

- **First introduced at:** `upstream:tools/environments/base.py:288`
  (`class BaseEnvironment`)
- **In the port:** `@hermests/tools`
- **Related:** [Tool](#tool), [Toolset](#toolset),
  [HERMES_HOME](#hermes_home)

## EventBridge (MCP)

Threadsafe queue/bridge that fans tool-call and session events from the
Python-side AIAgent into the stdio MCP transport so external MCP clients
(Claude Code, Cursor, Codex) can poll or wait on them via `events_poll`
and `events_wait`.

- **First introduced at:** `upstream:mcp_serve.py:204`
- **In the port:** `@hermests/mcp`
- **Related:** [MCP (Model Context Protocol)](#mcp-model-context-protocol),
  [Tool call](#tool-call)

## FileOperations

Abstract surface every file tool dispatches through — `read`, `write`,
`patch`, `search`, `lint`, `execute`. `ShellFileOperations` is the local
implementation; remote environments provide their own concretions.

- **First introduced at:** `upstream:tools/file_operations.py:259`
  (`class FileOperations(ABC)`)
- **In the port:** `@hermests/tools`
- **Related:** [Tool](#tool),
  [Environment (terminal backend)](#environment-terminal-backend)

## FTS5 session search

SQLite full-text-search index built over message bodies in
`state.db`, exposed through `hermes_state.SessionDB.search()` and consumed
by `/history`, `/branch`, `session_search` toolset, and the
`session_search` auxiliary task that LLM-summarises hits.

- **First introduced at:** `upstream:hermes_state.py:185` (`SCHEMA_SQL` —
  the FTS5 virtual table declaration)
- **In the port:** `@hermests/state`
- **Related:** [SessionDB](#sessiondb), [WAL fallback](#wal-fallback)

## Gateway

The single long-lived process that connects Hermes to all of its messaging
platforms simultaneously, brokers slash commands, manages per-channel
sessions, and runs the kanban dispatcher. Started with
`hermes gateway start`; configured by `~/.hermes/config.yaml § gateway`.

- **First introduced at:** `upstream:gateway/run.py:1542`
  (`class GatewayRunner`; sibling modules under `gateway/`)
- **In the port:** `@hermests/gateway`
- **Related:** [GatewayRunner](#gatewayrunner),
  [BasePlatformAdapter](#baseplatformadapter),
  [Message guard (gateway)](#message-guard-gateway)

## GatewayRunner

The orchestrator object inside the gateway process. Owns the platform
registry, session store, hook registry, slash-command resolution, and the
two message guards (base-adapter queue + runner inline interception) that
prevent input racing while an agent is running.

- **First introduced at:** `upstream:gateway/run.py:1542`
- **In the port:** `@hermests/gateway`
- **Related:** [Gateway](#gateway),
  [Message guard (gateway)](#message-guard-gateway)

## HERMES_HOME

The active profile's state root. Resolved by `get_hermes_home()`; defaults
to `~/.hermes`, becomes `~/.hermes/profiles/<name>` when a profile is
active. ALL state files (config.yaml, .env, state.db, logs/, skills/,
plugins/, sessions/) live under it. Hardcoding `~/.hermes` is a banned
pattern because it breaks profiles.

- **First introduced at:** `upstream:hermes_constants.py:43`
  (`def get_hermes_home`)
- **In the port:** `@hermests/core`
- **Related:** [Profile](#profile),
  [Bootstrap (hermes_bootstrap)](#bootstrap-hermes_bootstrap)

## HermesACPAgent

Hermes' concrete ACP agent class. Implements the protocol methods Zed,
VS Code, and JetBrains use to drive an external agent over stdio: session
init, model selection, prompt submission, tool approval, edit-proposal
review, and cancellation.

- **First introduced at:** `upstream:acp_adapter/server.py:445`
- **In the port:** `@hermests/acp`
- **Related:** [ACP / Agent Client Protocol](#acp--agent-client-protocol)

## HermesCLI

The interactive terminal entry point — `hermes` with no subcommand drops
into this. Owns banner rendering, the prompt_toolkit input loop, slash
command dispatch via `process_command()`, response-box layout, skin
application, and lifecycle for a single CLI-tagged session.

- **First introduced at:** `upstream:cli.py:2801` (`class HermesCLI`)
- **In the port:** `@hermests/cli`
- **Related:** [SkinConfig / Skin engine](#skinconfig--skin-engine),
  [KawaiiSpinner](#kawaiispinner), [Slash command](#slash-command)

## HookRegistry (gateway)

Plugin extension point for pre/post lifecycle hooks at the gateway layer
(`pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`,
`on_session_start`, `on_session_end`). General-plugins register through
`PluginContext`; gateway-internal hooks register against this directly.

- **First introduced at:** `upstream:gateway/hooks.py:35`
- **In the port:** `@hermests/gateway`
- **Related:** [Plugin (general)](#plugin-general),
  [PluginContext](#plugincontext), [PluginManager](#pluginmanager)

## Hub / Skills Hub

Discovery and install surface for skills from external sources — GitHub
repos, `skills.sh`, well-known URLs, ClawHub, Claude Marketplace, LobeHub,
BrowseHub, `optional-skills/`, and Hermes' own index. Each source is a
`SkillSource` subclass. Lockfile at `~/.hermes/skills/.hub.lock.json`.

- **First introduced at:** `upstream:tools/skills_hub.py:70`
  (`class SkillMeta`); base ABC `SkillSource` at
  `upstream:tools/skills_hub.py:295`
- **In the port:** `@hermests/cli` (`support/tools-config + plugins +
  skills-hub` batch)
- **Related:** [Skill](#skill), [SkillSource](#skillsource),
  [Optional skill](#optional-skill), [Curator](#curator)

## Insights (`/insights`)

Slash command and engine that summarises a user's recent activity into a
human-readable digest (recent tasks, model spend, common tool failures,
emerging skills). Backed by an auxiliary-client task.

- **First introduced at:** `upstream:agent/insights.py:93`
  (`class InsightsEngine`)
- **In the port:** `@hermests/agent`
- **Related:** [Auxiliary client](#auxiliary-client),
  [Slash command](#slash-command)

## Interrupt

In-flight signal that breaks the agent run loop between iterations. Raised
by Ctrl+C in the CLI, by `/stop` in messaging, or by a new user message
arriving mid-run. The loop checks `self._interrupt_requested` at the top
of every iteration; delegate-spawned children are cancelled on parent
interrupt.

- **First introduced at:** `upstream:tools/interrupt.py:1`
  (module; loop site `AGENTS.md:124`)
- **In the port:** `@hermests/agent`
- **Related:** [Run loop (agent loop)](#run-loop-agent-loop),
  [Delegation (delegate_task)](#delegation-delegate_task)

## IterationBudget

Counter that caps how many tool-calling iterations an `AIAgent` may run
in a single turn, shared with subagents under the same root. Exposes
`remaining` and a one-turn "grace call" flag the loop honours after the
budget hits zero to let the model write a final answer.

- **First introduced at:** `upstream:agent/iteration_budget.py:17`
- **In the port:** `@hermests/agent`
- **Related:** [AIAgent](#aiagent), [Run loop (agent loop)](#run-loop-agent-loop)

## KawaiiSpinner

The animated face / verb / wing spinner shown in the CLI between API calls.
Drawn by `agent/display.py`; faces, verbs, and optional wings are
data-driven from the active `SkinConfig`.

- **First introduced at:** `upstream:agent/display.py:559`
- **In the port:** `@hermests/cli`
- **Related:** [HermesCLI](#hermescli),
  [SkinConfig / Skin engine](#skinconfig--skin-engine)

## Kanban

Durable, SQLite-backed work queue for multi-agent collaboration. Tasks
have explicit lifecycle (`create`, `assign`, `claim`, `complete`, `block`,
`archive`) plus heartbeats so the dispatcher can reclaim stale work.
Workers are spawned as profiles inside the gateway by default.

- **First introduced at:** `upstream:hermes_cli/kanban.py:1` (CLI module);
  tool surface `upstream:tools/kanban_tools.py:1`; doctrine `AGENTS.md:820`
- **In the port:** `@hermests/cli` (kanban-db, dispatcher, verbs),
  `@hermests/plugins` (dashboard + systemd)
- **Related:** [Board (kanban)](#board-kanban),
  [Tenant (kanban)](#tenant-kanban),
  [Dispatcher (kanban)](#dispatcher-kanban), [Profile](#profile)

## MCP (Model Context Protocol)

Open stdio JSON-RPC protocol Hermes implements two ways: as a **server**
(`mcp_serve.py` exposes 10 conversation/message/permission tools to
external MCP clients) and as a **client** (`tools/mcp_tool.py` lets the
agent call into any external MCP server registered in config).

- **First introduced at:** `upstream:mcp_serve.py:1` (server module);
  client at `upstream:tools/mcp_tool.py:1012` (`class MCPServerTask`)
- **In the port:** `@hermests/mcp` (server), `@hermests/tools` (client)
- **Related:** [EventBridge (MCP)](#eventbridge-mcp), [Tool](#tool)

## MemoryManager

Orchestrator that fans the active turn out to every enabled
`MemoryProvider` (honcho, mem0, supermemory, byterover, hindsight,
holographic, openviking, retaindb), aggregates their `prefetch` returns
into a `### Memory Context` block, and shuts them down cleanly at
session end.

- **First introduced at:** `upstream:agent/memory_manager.py:244`
- **In the port:** `@hermests/agent` (manager); providers as plugins under
  `@hermests/plugins`
- **Related:** [MemoryProvider](#memoryprovider),
  [Plugin (general)](#plugin-general)

## MemoryProvider

Abstract base every pluggable memory backend implements. Lifecycle hooks:
`sync_turn(turn_messages)`, `prefetch(query)`, `shutdown()`, and optional
`post_setup(hermes_home, config)` for setup-wizard integration. New
backends ship as standalone plugin repos under
`~/.hermes/plugins/`, never in-tree.

- **First introduced at:** `upstream:agent/memory_provider.py:42`
- **In the port:** `@hermests/agent` (ABC) + `@hermests/plugins`
  (built-in implementations)
- **Related:** [MemoryManager](#memorymanager),
  [Plugin (general)](#plugin-general)

## Message guard (gateway)

The pair of sequential gates an inbound platform message passes through
while an agent is already running: (1) the base adapter's
`_pending_messages` queue keyed on `session_key in self._active_sessions`,
then (2) the gateway runner's inline interception of `/stop`, `/new`,
`/queue`, `/status`, `/approve`, `/deny`. Any new control command that
must reach the runner mid-run MUST bypass both.

- **First introduced at:** `upstream:AGENTS.md:970` (policy section)
- **In the port:** `@hermests/gateway`
- **Related:** [Gateway](#gateway), [GatewayRunner](#gatewayrunner),
  [BasePlatformAdapter](#baseplatformadapter)

## MiniSWERunner

Variant of `BatchRunner` specialised for SWE-Bench-style task corpora —
loads tasks from a manifest, scaffolds the per-task workspace, runs the
agent, and grades results.

- **First introduced at:** `upstream:mini_swe_runner.py:161`
- **In the port:** `@hermests/batch`
- **Related:** [BatchRunner](#batchrunner), [Trajectory](#trajectory)

## Optional skill

A skill that ships in the repo under `optional-skills/` but is NOT loaded
by default. Installed explicitly via
`hermes skills install official/<category>/<skill>`. The adapter exposing
optional skills to the hub is `tools/skills_hub.OptionalSkillSource`.

- **First introduced at:** `upstream:tools/skills_hub.py:2535`
  (`class OptionalSkillSource(SkillSource)`)
- **In the port:** `@hermests/skills` (content) +
  `@hermests/cli` (install verbs)
- **Related:** [Skill](#skill), [Hub / Skills Hub](#hub--skills-hub)

## Pairing (DM pairing)

Security primitive that binds a specific platform user identity (a
Telegram chat_id, Discord user_id, etc.) to the gateway operator,
preventing strangers from talking to your agent. Backed by `PairingStore`.

- **First introduced at:** `upstream:gateway/pairing.py:81`
  (`class PairingStore`)
- **In the port:** `@hermests/gateway`
- **Related:** [Gateway](#gateway), [Profile](#profile),
  [SlashAccessPolicy](#slashaccesspolicy)

## Platform (messaging)

One specific messaging channel adapter (Telegram, Discord, Slack,
WhatsApp, Signal, Matrix, Mattermost, Email, SMS, DingTalk, WeCom, WeiXin,
Feishu, QQ Bot, BlueBubbles, Yuanbao, Webhook, API server, Home
Assistant, …) that the gateway can simultaneously connect to.

- **First introduced at:** `upstream:gateway/config.py:100`
  (`class Platform(Enum)`)
- **In the port:** `@hermests/gateway`
- **Related:** [Gateway](#gateway),
  [BasePlatformAdapter](#baseplatformadapter),
  [PlatformRegistry](#platformregistry)

## PlatformRegistry

Discovery + lookup table for platform adapters. Maps platform name → entry
metadata + adapter factory. Used by the gateway to spin up only the
adapters enabled in config.

- **First introduced at:** `upstream:gateway/platform_registry.py:162`
- **In the port:** `@hermests/gateway`
- **Related:** [Platform (messaging)](#platform-messaging),
  [BasePlatformAdapter](#baseplatformadapter)

## Plugin (general)

A discoverable bundle living under `~/.hermes/plugins/`,
`./.hermes/plugins/`, or a pip entry point. Exposes `register(ctx)`; the
context lets the plugin register tools, CLI subcommands, and lifecycle
hooks. NEVER allowed to modify core files (Teknium rule, May 2026).

- **First introduced at:** `upstream:hermes_cli/plugins.py:234`
  (`class PluginManifest`)
- **In the port:** `@hermests/plugins`
- **Related:** [PluginContext](#plugincontext),
  [PluginManager](#pluginmanager),
  [MemoryProvider](#memoryprovider),
  [ProviderProfile](#providerprofile)

## PluginContext

The object handed to a plugin's `register(ctx)` function. Provides
`register_tool`, `register_cli_command`, and hook-attachment methods. The
only legal API surface for a plugin to extend Hermes.

- **First introduced at:** `upstream:hermes_cli/plugins.py:287`
- **In the port:** `@hermests/plugins`
- **Related:** [Plugin (general)](#plugin-general),
  [HookRegistry (gateway)](#hookregistry-gateway)

## PluginManager

Loader and lifecycle manager for general plugins. Walks the discovery
paths, validates manifests, instantiates each plugin, and presents the
canonical list to `hermes plugins`. Does NOT import memory-provider or
model-provider plugins (those have their own discovery to avoid
double-instantiation).

- **First introduced at:** `upstream:hermes_cli/plugins.py:770`
- **In the port:** `@hermests/plugins`
- **Related:** [Plugin (general)](#plugin-general),
  [PluginContext](#plugincontext)

## Profile

A fully isolated Hermes instance with its own `HERMES_HOME` directory
(config, API keys, memory, sessions, skills, gateway, …). Activated via
`hermes -p <name>` or the `HERMES_PROFILE` env var.
`_apply_profile_override()` in `hermes_cli/main.py` sets `HERMES_HOME`
**before** any module imports.

- **First introduced at:** `upstream:hermes_constants.py:35`
  (`get_hermes_home_override`); doctrine `AGENTS.md:892`
- **In the port:** `@hermests/core`
- **Related:** [HERMES_HOME](#hermes_home),
  [Bootstrap (hermes_bootstrap)](#bootstrap-hermes_bootstrap)

## Prompt caching

The discipline that keeps the past portion of the conversation byte-stable
so providers (Anthropic, OpenAI) can mark it as a cache hit. Slash
commands that mutate system-prompt state (skills, tools, memory) MUST
default to deferred invalidation — change takes effect on the next
session — with an opt-in `--now` flag for immediate invalidation.

- **First introduced at:** `upstream:agent/prompt_caching.py:1`
  (module; doctrine `AGENTS.md:863`)
- **In the port:** `@hermests/agent`
- **Related:** [Compression (context / trajectory)](#compression-context--trajectory),
  [SessionContext](#sessioncontext)

## ProviderProfile

The data record that describes one inference backend — name, aliases,
base URL, default models, capabilities, billing route, temperature
contract, header injectors. Every backend (OpenRouter, Anthropic, GMI,
DeepSeek, NVIDIA, …) ships as a model-provider plugin that calls
`register_provider(ProviderProfile(...))` at import time.

- **First introduced at:** `upstream:providers/base.py:39`
- **In the port:** `@hermests/providers`
- **Related:** [Plugin (general)](#plugin-general),
  [CredentialPool](#credentialpool), [AIAgent](#aiagent)

## Reasoning content

The model's intermediate "thinking" output, stored on the assistant
message as `assistant_msg["reasoning"]` (separate from `content`). Streamed
through `agent/think_scrubber.py` to detect and strip leaked
chain-of-thought from the rendered surface while preserving it for
trajectory capture.

- **First introduced at:** `upstream:AGENTS.md:138` (message-format note);
  scrubber `upstream:agent/think_scrubber.py:64`
- **In the port:** `@hermests/agent`
- **Related:** [Think scrubber](#think-scrubber), [Trajectory](#trajectory)

## Routine

User-facing name for an Hermes recurring task ("daily reports, nightly
backups, weekly audits, all in natural language, running unattended"). One
routine maps to one or more cron jobs.

- **First introduced at:** `upstream:README.md:23` ("Scheduled automations"
  table row)
- **In the port:** `@hermests/cli` (cron) + `@hermests/gateway` (delivery)
- **Related:** [Cron job](#cron-job),
  [Catchup window (cron)](#catchup-window-cron)

## Run loop (agent loop)

The synchronous `while api_call_count < max_iterations ...` body inside
`AIAgent.run_conversation()`. Each iteration: check interrupt → call model
→ if tool calls, dispatch each via `handle_function_call()` and append
results → else return content. Subagents inherit the same iteration
counter.

- **First introduced at:** `upstream:agent/conversation_loop.py:232`
  (`def run_conversation`; doctrine `AGENTS.md:120`)
- **In the port:** `@hermests/agent`
- **Related:** [AIAgent](#aiagent), [IterationBudget](#iterationbudget),
  [Interrupt](#interrupt), [Tool call](#tool-call)

## SessionContext

Per-session blackboard the gateway hands to every adapter and tool — the
session id, source platform, user/chat IDs, working directory, the active
AIAgent reference, the current `IterationBudget`, the credential pool,
and so on. The "this is everything about who the agent is talking to
right now" struct.

- **First introduced at:** `upstream:gateway/session.py:160`
- **In the port:** `@hermests/gateway`
- **Related:** [SessionDB](#sessiondb), [SessionSource](#sessionsource),
  [SessionStore](#sessionstore)

## SessionDB

The SQLite-backed session store. Replaces the legacy per-session JSONL
files. WAL mode by default with a documented DELETE-mode fallback for
NFS/SMB/FUSE filesystems. Hosts FTS5 search across the entire message
history and tracks `parent_session_id` chains for compression continuity.

- **First introduced at:** `upstream:hermes_state.py:311` (`class SessionDB`)
- **In the port:** `@hermests/state`
- **Related:** [FTS5 session search](#fts5-session-search),
  [WAL fallback](#wal-fallback),
  [Compression (context / trajectory)](#compression-context--trajectory)

## SessionSource

Enum tagging which entry point owns a session row — `cli`, `telegram`,
`discord`, `slack`, `whatsapp`, `signal`, … Used for filtering in
`/history` and to scope per-platform quotas.

- **First introduced at:** `upstream:gateway/session.py:71`
- **In the port:** `@hermests/gateway`
- **Related:** [SessionContext](#sessioncontext), [SessionDB](#sessiondb)

## SessionStore

In-process map of `(platform, channel) → SessionEntry`. Owned by the
gateway runner; the durable side lives in `SessionDB`. SessionStore is
what `/new`, `/resume`, and platform reconnect handlers mutate.

- **First introduced at:** `upstream:gateway/session.py:668`
- **In the port:** `@hermests/gateway`
- **Related:** [SessionContext](#sessioncontext), [SessionDB](#sessiondb)

## Skill

A bundled procedure the agent can invoke — a `SKILL.md` (frontmatter +
prose body) plus optional `scripts/`, `references/`, `templates/`, and
`tests/`. Two parallel surfaces: `skills/` is loaded by default,
`optional-skills/` is opt-in. Built-in slash commands like
`/<skill-name>` expose them in both CLI and messaging.

- **First introduced at:** `upstream:agent/skill_commands.py:1` (loader);
  authoring standards `AGENTS.md:587`
- **In the port:** `@hermests/skills` (content),
  `@hermests/agent` (loader)
- **Related:** [Curator](#curator), [Hub / Skills Hub](#hub--skills-hub),
  [Optional skill](#optional-skill), [SkillSource](#skillsource)

## SkillSource

Abstract base for the place a skill can be installed from — GitHub repo,
URL, `skills.sh`, ClawHub, Claude Marketplace, LobeHub, BrowseHub,
in-tree `optional-skills/`, or Hermes' own index.

- **First introduced at:** `upstream:tools/skills_hub.py:295`
- **In the port:** `@hermests/cli` (`skills-hub` support batch)
- **Related:** [Hub / Skills Hub](#hub--skills-hub), [Skill](#skill)

## SkinConfig / Skin engine

Data-driven CLI theming. `SkinConfig` is the dataclass; `skin_engine.py`
loads built-in skins (`default`, `ares`, `mono`, `slate`) plus any
`~/.hermes/skins/<name>.yaml`. Missing keys inherit from `default`.
Activated via `/skin <name>` or `display.skin` in config.

- **First introduced at:** `upstream:hermes_cli/skin_engine.py:130`
- **In the port:** `@hermests/cli` (`support/skin-engine + curses-ui +
  voice-UI` batch)
- **Related:** [HermesCLI](#hermescli), [KawaiiSpinner](#kawaiispinner)

## Slash command

A `/name [args]` directive interpreted by the CLI or gateway before the
text would otherwise be sent to the model. Defined once in
`COMMAND_REGISTRY`; every consumer (CLI dispatcher, gateway dispatcher,
Telegram BotCommand menu, Slack subcommand map, autocomplete, help)
derives from that single source.

- **First introduced at:** `upstream:hermes_cli/commands.py:46`
  (`class CommandDef`; doctrine `AGENTS.md:152`)
- **In the port:** `@hermests/cli` (registry) + `@hermests/gateway`
  (gateway dispatch)
- **Related:** [CommandDef](#commanddef), [HermesCLI](#hermescli),
  [Gateway](#gateway)

## SlashAccessPolicy

Per-platform, per-user allow/deny ruleset that controls which slash
commands a given identity may execute. Lets a gateway operator scope
`/model`, `/tools`, `/cron` to themselves while leaving conversational
slash commands open.

- **First introduced at:** `upstream:gateway/slash_access.py:57`
- **In the port:** `@hermests/gateway`
- **Related:** [Slash command](#slash-command),
  [Pairing (DM pairing)](#pairing-dm-pairing),
  [Message guard (gateway)](#message-guard-gateway)

## Streaming

Incremental delivery of model output to the consumer (CLI surface,
TUI `message.delta` events, gateway platform). Hermes streams tokens,
tool-call deltas, reasoning chunks, and tool stdout independently;
`GatewayStreamConsumer` reassembles them per session.

- **First introduced at:** `upstream:gateway/stream_consumer.py:78`
  (`class GatewayStreamConsumer`)
- **In the port:** `@hermests/gateway`
- **Related:** [Gateway](#gateway), [Tool call](#tool-call)

## Tenant (kanban)

Soft namespace *within* a kanban board. Lets one specialist worker fleet
serve multiple businesses with workspace-path + memory-key isolation.
Looser than [board](#board-kanban) — workers can in principle see across
tenants, but their tools dispatch to a tenant-scoped workspace and memory
namespace.

- **First introduced at:** `upstream:AGENTS.md:849` (Isolation model
  section of Kanban)
- **In the port:** `@hermests/cli` (kanban-db)
- **Related:** [Kanban](#kanban), [Board (kanban)](#board-kanban)

## Think scrubber

Streaming filter that detects and strips chain-of-thought content (e.g.
`<think>...</think>` blocks, "scratchpad" sections) from rendered output
while preserving them for `assistant_msg["reasoning"]` and trajectory
capture.

- **First introduced at:** `upstream:agent/think_scrubber.py:64`
- **In the port:** `@hermests/agent`
- **Related:** [Reasoning content](#reasoning-content),
  [Trajectory](#trajectory)

## Tool

A single callable the agent may invoke via function-call. Lives in
`tools/<name>.py`, registers itself at import time via
`registry.register(...)`, returns a JSON string. Auto-discovery walks
`tools/*.py`; wiring into a toolset stays manual.

- **First introduced at:** `upstream:tools/registry.py:77`
  (`class ToolEntry`); doctrine `AGENTS.md:262`
- **In the port:** `@hermests/tools`
- **Related:** [ToolEntry](#toolentry), [ToolRegistry](#toolregistry),
  [Toolset](#toolset),
  [Environment (terminal backend)](#environment-terminal-backend)

## Tool call

A single function-call request emitted by the model in one assistant turn.
Each `tool_call` carries a name + JSON args; `handle_function_call()`
dispatches it through the registry, runs guardrails, executes against the
chosen environment, and appends a `tool` role message with the result.

- **First introduced at:** `upstream:AGENTS.md:128` (run-loop snippet)
- **In the port:** `@hermests/agent` (dispatch) + `@hermests/tools`
  (execution)
- **Related:** [Tool](#tool), [Run loop (agent loop)](#run-loop-agent-loop),
  [Approval (command approval)](#approval-command-approval)

## ToolEntry

One immutable record in the tool registry — `name`, `toolset`, `schema`,
`handler`, `check_fn`, `requires_env`. Created by `registry.register(...)`
at import time.

- **First introduced at:** `upstream:tools/registry.py:77`
- **In the port:** `@hermests/tools`
- **Related:** [Tool](#tool), [ToolRegistry](#toolregistry)

## ToolRegistry

In-process global index of all registered tools. Owns schema collection,
dispatch, availability checking (via `check_fn`), and error wrapping. The
single source of truth `model_tools.discover_builtin_tools()` walks
to assemble the per-turn tool-schema array.

- **First introduced at:** `upstream:tools/registry.py:151`
- **In the port:** `@hermests/tools`
- **Related:** [Tool](#tool), [ToolEntry](#toolentry), [Toolset](#toolset)

## Toolset

A named subset of tools — `terminal`, `web`, `vision`, `memory`,
`messaging`, `kanban`, `delegation`, `code_execution`, `cronjob`,
`browser`, `clarify`, `debugging`, `file`, `image_gen`, `moa`, `rl`,
`safe`, `search`, `session_search`, `skills`, `spotify`, `todo`, `tts`,
`video`, `homeassistant`, `yuanbao`, `discord`, `discord_admin`,
`feishu_doc`, `feishu_drive`. Each platform's adapter picks a base
toolset; `_HERMES_CORE_TOOLS` is the default bundle.

- **First introduced at:** `upstream:toolsets.py:78` (`TOOLSETS = {...}`)
- **In the port:** `@hermests/tools`
- **Related:** [Tool](#tool),
  [TOOLSETS / `_HERMES_CORE_TOOLS`](#toolsets--_hermes_core_tools)

## TOOLSETS / `_HERMES_CORE_TOOLS`

`TOOLSETS` is the canonical dict in `toolsets.py` mapping toolset name →
member tool list. `_HERMES_CORE_TOOLS` is the default bundle that most
platform base toolsets inherit from — auto-discovery imports a tool, but
the tool only becomes available to an agent once it appears in some
toolset.

- **First introduced at:** `upstream:toolsets.py:31` (`_HERMES_CORE_TOOLS`)
  and `upstream:toolsets.py:78` (`TOOLSETS`)
- **In the port:** `@hermests/tools`
- **Related:** [Toolset](#toolset), [Tool](#tool)

## Trajectory

A captured conversation — list of messages (system / user / assistant /
tool, each with `reasoning` if present), tool calls and results, and
provenance metadata. Persisted by `agent/trajectory.py:save_trajectory()`
as JSONL when `save_trajectories=True`. Consumed by training-corpus
pipelines and `TrajectoryCompressor`.

- **First introduced at:** `upstream:agent/trajectory.py:30`
  (`def save_trajectory`)
- **In the port:** `@hermests/agent` (capture) +
  `@hermests/trajectory` (compression/processing)
- **Related:** [TrajectoryCompressor](#trajectorycompressor),
  [BatchRunner](#batchrunner),
  [Reasoning content](#reasoning-content)

## TrajectoryCompressor

Post-processing engine that compresses completed JSONL trajectories to a
target token budget while preserving training signal: protect first
system/human/gpt/tool turns, protect last N turns, collapse the
compressible middle into a single human-summary message starting from
the second tool response.

- **First introduced at:** `upstream:trajectory_compressor.py:332`
  (`class TrajectoryCompressor`); config dataclass at `:83`
- **In the port:** `@hermests/trajectory`
- **Related:** [Trajectory](#trajectory),
  [Compression (context / trajectory)](#compression-context--trajectory)

## TUI (`hermes --tui`)

The Ink (React) terminal interface — full replacement for the
prompt_toolkit CLI, activated via `hermes --tui` or `HERMES_TUI=1`.
TypeScript owns the screen; Python owns sessions, tools, and model calls,
communicated via newline-delimited JSON-RPC over stdio. The dashboard
chat pane embeds the real `hermes --tui` over a PTY — it is not a
rewrite.

- **First introduced at:** `upstream:ui-tui/src/entry.tsx:1` (TS entry);
  doctrine `AGENTS.md:198`
- **In the port:** `ui-tui/` workspace (TS is already TS — tracked
  separately from `@hermests/*` packages)
- **Related:** [TUI gateway](#tui-gateway), [HermesCLI](#hermescli)

## TUI gateway

The Python JSON-RPC backend the Ink TUI talks to over stdio. Owns the
AIAgent, tools, sessions, slash commands, and approval/clarify/sudo
prompt routing. See `tui_gateway/server.py` for the method/event
catalog.

- **First introduced at:** `upstream:tui_gateway/server.py:1` (module)
- **In the port:** `@hermests/tui-gateway`
- **Related:** [TUI (`hermes --tui`)](#tui-hermes---tui), [AIAgent](#aiagent)

## WAL fallback

SessionDB's documented degradation path for filesystems where SQLite's
WAL mode is unsafe (NFS, SMB/CIFS, some FUSE mounts, WSL1). On a
`SQLITE_PROTOCOL` ("locking protocol") error, `apply_wal_with_fallback`
quietly switches the connection to `journal_mode=DELETE`, logs one
WARNING per (process, db_label), and continues. Slow but correct.

- **First introduced at:** `upstream:hermes_state.py:128`
  (`def apply_wal_with_fallback`)
- **In the port:** `@hermests/state`
- **Related:** [SessionDB](#sessiondb),
  [FTS5 session search](#fts5-session-search)

---

*Generated by `glossary-builder-2` (task #28). Source of file:line
references is the upstream cache at
`/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/`
at the cache's current refresh time. Re-run `opensrc fetch
github:nousresearch/hermes-agent` before relying on a specific line
number for upstream work.*
