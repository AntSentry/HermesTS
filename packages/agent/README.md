## @hermests/agent

Per-turn runtime helpers for HermesTS agents — faithful port of the upstream
`agent/` Python module (102 files, ~63k LOC). Landing as a series of PRs;
this directory holds whatever has shipped so far. Track the full plan in
[docs/port-briefs/agent.md](../../docs/port-briefs/agent.md).

### Status

In progress. Sub-task #5a (this PR) ports the 20 leaf utility files —
roughly 2,600 upstream LOC. Subsequent sub-tasks (#5b–#5o) layer the
remaining surfaces (transports, adapters, helpers, integrators) on top.

### Modules in this slice (#5a)

| Upstream `.py` | TS file | Surface |
|---|---|---|
| `async_utils.py` (68 LOC) | `src/async-utils.ts` | `safeScheduleThreadsafe` (degraded shim — see divergence). |
| `retry_utils.py` (57 LOC) | `src/retry-utils.ts` | `jitteredBackoff`, `_resetJitterCounter`. |
| `iteration_budget.py` (62 LOC) | `src/iteration-budget.ts` | `IterationBudget`. |
| `tool_result_classification.py` (26 LOC) | `src/tool-result-classification.ts` | `fileMutationResultLanded`, `FILE_MUTATING_TOOL_NAMES`. |
| `trajectory.py` (56 LOC) | `src/trajectory.ts` | `convertScratchpadToThink`, `hasIncompleteScratchpad`, `saveTrajectory`. |
| `lmstudio_reasoning.py` (48 LOC) | `src/lmstudio-reasoning.ts` | `resolveLmstudioEffort`. |
| `gemini_schema.py` (99 LOC) | `src/gemini-schema.ts` | `sanitizeGeminiSchema`, `sanitizeGeminiToolParameters`. |
| `moonshot_schema.py` (262 LOC) | `src/moonshot-schema.ts` | `sanitizeMoonshotToolParameters`, `sanitizeMoonshotTools`, `isMoonshotModel`. |
| `i18n.py` (258 LOC) | `src/i18n.ts` | `t`, `getLanguage`, `resetLanguageCache`, `setConfigLanguageProvider`, `setLocalesDirOverride`, `SUPPORTED_LANGUAGES`, `DEFAULT_LANGUAGE`. |
| `manual_compression_feedback.py` (49 LOC) | `src/manual-compression-feedback.ts` | `summarizeManualCompression`. |
| `portal_tags.py` (64 LOC) | `src/portal-tags.ts` | `hermesClientTag`, `nousPortalTags`, `setHermesVersionProvider`, `resetHermesVersionProvider`. |
| `prompt_caching.py` (79 LOC) | `src/prompt-caching.ts` | `applyAnthropicCacheControl`. |
| `markdown_tables.py` (309 LOC) | `src/markdown-tables.ts` | `isTableDivider`, `looksLikeTableRow`, `realignMarkdownTables`, `splitTableRow`. |
| `process_bootstrap.py` (167 LOC) | `src/process-bootstrap.ts` | `getProxyFromEnv`, `getProxyForBaseUrl`, `installSafeStdio`, `uninstallSafeStdio`, `SafeWriter`. |
| `file_safety.py` (256 LOC) | `src/file-safety.ts` | `buildWriteDeniedPaths`, `buildWriteDeniedPrefixes`, `getSafeWriteRoot`, `isWriteDenied`, `getReadBlockError`. |
| `system_prompt.py` (346 LOC) | `src/system-prompt.ts` | `buildSystemPrompt`, `buildSystemPromptParts`, `invalidateSystemPrompt`, `formatToolsForSystemMessage`, plus `AgentLike`/`SystemPromptDeps` DI interfaces. |
| `subdirectory_hints.py` (224 LOC) | `src/subdirectory-hints.ts` | `SubdirectoryHintTracker`, `setContextScanner`, `ContextScanner`. |
| `secret_sources/__init__.py` (13 LOC) | `src/secret-sources/index.ts` | Package marker only (`SECRET_SOURCES_DESCRIPTION`). The `bitwarden.py` body lands in sub-task #5g. |
| `__init__.py` (6 LOC) | `src/index.ts` | Barrel re-export + `AGENT_PACKAGE_DESCRIPTION`. |

### Faithful divergences

This package follows the same fidelity rules as `@hermests/core`: function
names, semantics, and edge-case behavior match upstream. Where Python has
no direct Node equivalent the divergence is documented with the upstream
`file:line` reference.

| Upstream construct | TS port | Reason |
|---|---|---|
| `safe_schedule_threadsafe(coro, loop)` — coroutine close + return future when scheduling fails (`async_utils.py`) | `safeScheduleThreadsafe(taskFn, loop)` — null short-circuit when `loop===null`, Promise otherwise. No coroutine-close because Node has no equivalent failure mode. | Node has one event loop, no `loop` parameter, no "coroutine was never awaited" warning. The shim exists for call-site parity only. |
| `threading.Lock` for jitter counter / iteration budget (`retry_utils.py:16`, `iteration_budget.py:35`) | Plain non-locked increment / counter. | Node's event loop is single-threaded; the locks only protected against multi-thread races that can't occur here. |
| `wcwidth.wcswidth` (`markdown_tables.py:35`) | `string-width` npm package. | Direct TS equivalent — both clamp control chars to 0 cells and handle CJK / emoji-VS16 correctly. |
| `_OpenAIProxy` + `_load_openai_cls` lazy `from openai import OpenAI` (`process_bootstrap.py:39-61`) | Not ported. | Node `import()` is already lazy. Adapters will wire their own HTTP clients in sub-tasks #5h/#5i/#5j. |
| `urllib.request.proxy_bypass_environment(host)` (`process_bootstrap.py:137`) | Inline `NO_PROXY` matcher — comma/space-separated patterns, `*` wildcard, optional leading dot for suffix match. | Node has no stdlib equivalent; the matcher mirrors CPython behavior. |
| `from agent.prompt_builder import _scan_context_content` (`subdirectory_hints.py:22`) | `setContextScanner(fn)` DI seam, default is identity. | `prompt_builder` lives in sub-task #5f. The #5f porter wires the real scanner at package init time. |
| `from agent.prompt_builder import DEFAULT_AGENT_IDENTITY, …` (`system_prompt.py:30-42`) | `SystemPromptDeps` interface — caller injects the constant strings + helpers. | Same dependency story — `prompt_builder.py` lives in sub-task #5f and the AIAgent shape in #5o. The interface lets this module compile and be exercised standalone today. |
| `_ra()` lazy `import run_agent` shim (`system_prompt.py:45-57`) | Replaced by the `SystemPromptDeps` interface. | Recommended replacement per `docs/port-briefs/agent.md` §5 — DI cleaner than runtime attribute lookup. |
| `from hermes_cli import __version__` (`portal_tags.py:44`) | `setHermesVersionProvider(fn)` DI seam, default returns `"unknown"`. | `hermes_cli` is downstream (#14); the cli porter wires the live version at startup. |
| `from hermes_cli.config import load_config` (`i18n.py:177`) | `setConfigLanguageProvider(fn)` DI seam, default returns `null`. | Same downstream-package reason. |
| `shlex.split(cmd)` (`subdirectory_hints.py:144`) | Plain `cmd.split(/\s+/)`. | The upstream `except ValueError → split()` branch is the documented fallback; the simpler form covers every case the discovery code actually needs. |

### Deferred tests

Cross-cutting agent tests (anthropic adapter, auxiliary client,
chat-completion helpers, etc.) live in upstream `tests/agent/*.py` and
are ported by the sub-task that owns the matching code (#5b–#5o). The
helper-level files in this slice (`test_async_utils.py`,
`test_tool_result_classification.py`, `test_moonshot_schema.py`,
`test_gemini_schema.py`, `test_markdown_tables.py`,
`test_prompt_caching.py`, `test_subdirectory_hints.py`,
`test_retry_utils.py`) are fully ported into `tests/`.

The `system_prompt` tests in upstream are integration-style (drive
`build_system_prompt_parts` through an `AIAgent` fixture). The
fixture-driven shape lives with the integrators (#5o); this slice
covers the assembly function via an `AgentLike` + `SystemPromptDeps`
fixture pair that exercises every branch directly.

Tracking row added in `docs/deferred-tests.md` flagging that the upstream
fixture-shaped `test_system_prompt_restore.py` cases land in #5o.
