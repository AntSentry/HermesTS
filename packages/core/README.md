# @hermests/core

Foundation utilities for HermesTS — constants, logging, time, utils, bootstrap.

## Modules

| Upstream `.py` | TS file | Surface |
|---|---|---|
| `hermes_constants.py` (438 LOC) | `src/hermes-constants.ts` | `getHermesHome`, `getDefaultHermesRoot`, `setHermesHomeOverride`/`resetHermesHomeOverride`/`getHermesHomeOverride`, `getOptionalSkillsDir`, `getBundledSkillsDir`, `getHermesDir`, `displayHermesHome`, `secureParentDir`, `getSubprocessHome`, `parseReasoningEffort`, `VALID_REASONING_EFFORTS`, `isTermux`, `isWsl`, `isContainer`, `getConfigPath`, `getSkillsDir`, `getEnvPath`, `applyIpv4Preference`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODELS_URL`, `AI_GATEWAY_BASE_URL` |
| `hermes_logging.py` (389 LOC) | `src/hermes-logging.ts` | `setupLogging`, `setupVerboseLogging`, `setSessionContext`, `clearSessionContext`, `runWithSession`, `getLogger`, `getRootLogger`, `Logger`, `Handler`, `StreamHandler`, `RotatingFileHandler`, `PercentFormatter`, `ComponentFilter`, `COMPONENT_PREFIXES`, `LogLevel`, `_LOG_FORMAT`, `_LOG_FORMAT_VERBOSE`, `_addRotatingHandler`, `_readLoggingConfig`, `_installSessionRecordFactory` |
| `hermes_time.py` (104 LOC) | `src/hermes-time.ts` | `now`, `getTimezone`, `resetTimezoneCache`, `formatInZone`, `getUtcOffsetMinutes`, `setTimezoneWarningEmitter` |
| `utils.py` (361 LOC) | `src/utils.ts` | `isTruthyValue`, `envVarEnabled`, `atomicReplace`, `atomicJsonWrite`, `atomicYamlWrite`, `atomicRoundtripYamlUpdate`, `safeJsonLoads`, `envInt`, `envBool`, `normalizeProxyUrl`, `normalizeProxyEnvVars`, `baseUrlHostname`, `baseUrlHostMatches`, `TRUTHY_STRINGS` |
| `hermes_bootstrap.py` (129 LOC) | `src/hermes-bootstrap.ts` | `applyWindowsUtf8Bootstrap`, `_state` |

## Faithful divergences

This package is a faithful port — function names, semantics, and edge-case behavior match upstream. Where Python has no direct Node equivalent, the divergence is below; the upstream `file:line` reference makes it easy to audit.

| Upstream construct | TS port | Reason |
|---|---|---|
| `contextvars.ContextVar` (constants py:L15-17) | `AsyncLocalStorage<string>` | Node has no contextvars; AsyncLocalStorage matches the per-task scoping semantics. |
| `sysconfig.get_path("data"\|"purelib"\|"platlib")` (constants py:L143-157) | `_getPackagedDataDir` returns `null` | No Python wheel concept in Node. Callers must pass an explicit `default` for skills resolution. |
| `socket.getaddrinfo` monkey-patch (constants py:L393-432) | `dns.lookup` wrapper, intercepts `family:0` → `family:4` with `ENOTFOUND`/`EAI_AGAIN` fallback | Node uses `dns.lookup` (not `getaddrinfo`); same intent, IPv4-first with IPv6 fallback. |
| `zoneinfo.ZoneInfo` (time py:L25-28) | IANA string + `Intl.DateTimeFormat` | JS `Date` has no tzinfo attachment. `now()` returns a UTC-internal `Date`; `formatInZone` and `getUtcOffsetMinutes` cover render/offset use cases. |
| `threading.local` for session context (logging py:L41) | `AsyncLocalStorage<{sessionId}>` + global fallback | Node is single-threaded but async-tasked. ALS matches the isolation guarantee. |
| Python `logging` stdlib (RotatingFileHandler, LogRecord factory, format token injection, root logger handler attachment) (logging py:L26-389) | Custom ~300 LOC handler/logger module, zero runtime deps | Per team-lead direction: roll faithful port over adding pino. Preserves `%(session_tag)s` format injection exactly. |
| `agent.redact.RedactingFormatter` (logging py:L211, L267) | Injected via `setupLogging({ formatterFactory })` | Cross-package dep — defer to `@hermests/agent`. Default uses plain `PercentFormatter`. |
| `hermes_cli.config.is_managed` (logging py:L309) | Injected via `setupLogging({ isManaged })` | Cross-package dep — defer to `@hermests/cli`. Default returns false. |
| `tempfile.mkstemp` (utils py:L110, L166, L235) | Manual `randomBytes` + `openSync('wx+', 0o600)` collision loop | Node's `mkdtempSync` works on directories, not files. Matches upstream mode + prefix scheme. |
| `ruamel.yaml` round-trip (utils py:L191-252) | `yaml` package's Document API | TS `yaml` preserves comments and quoting; full ruamel parity not guaranteed for exotic shapes. |
| Windows UTF-8 stdio reconfigure (bootstrap py:L92-119) | `setDefaultEncoding('utf8')` on stdout/stderr | Node uses UTF-8 by default on Windows for `process.stdout`; the env-var half (PYTHONUTF8/PYTHONIOENCODING) is the load-bearing fix for Python child processes we may spawn. |

## Deferred tests

A subset of the upstream test suite cross-imports modules from packages that don't exist yet (state, agent, tools, cli, gateway, cron). Those tests are tracked in `docs/deferred-tests.md` at the repo root and will be ported when their dependent package lands.
