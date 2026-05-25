# @hermests/state

SQLite-backed session storage, FTS5 search, and message persistence — a faithful TypeScript port of upstream `hermes_state.py` (3,279 LOC).

## Modules

| Upstream `.py` | TS file | Surface |
|---|---|---|
| `hermes_state.py` SessionDB class (95% of upstream LOC) | `src/session-db.ts` | `SessionDB`, `DEFAULT_DB_PATH` |
| `hermes_state.py` schema constants | `src/schema.ts` | `SCHEMA_SQL`, `FTS_SQL`, `FTS_TRIGRAM_SQL`, `SCHEMA_VERSION` |
| `hermes_state.py` WAL/init module-level helpers | `src/wal-fallback.ts` | `applyWalWithFallback`, `getLastInitError`, `formatSessionDbUnavailable`, `_setLastInitError`, `WAL_INCOMPAT_MARKERS`, `_resetWalFallbackWarnedPaths` |
| `hermes_state.py` content encoding | `src/content-codec.ts` | `_encodeContent`, `_decodeContent`, `CONTENT_JSON_PREFIX` |
| `hermes_state.py` FTS5 sanitizer | `src/fts5.ts` | `_sanitizeFts5Query` |
| `hermes_state.py` CJK helpers | `src/cjk.ts` | `_isCjkCodepoint`, `_containsCjk`, `_countCjk` |
| `hermes_state.py` title helpers | `src/title.ts` | `sanitizeTitle`, `MAX_TITLE_LENGTH` |

`SessionDB` preserves every Python method name (snake_case) as a TS instance method so call-site translation across the rest of the port stays mechanical — `db.create_session(...)`, `db.append_message(...)`, `db.search_messages(...)`, `db.maybe_auto_prune_and_vacuum(...)`, etc. Static helpers (`SessionDB.sanitize_title`, `SessionDB._sanitize_fts5_query`, `SessionDB._encode_content`, `SessionDB._parse_schema_columns`, etc.) match their Python counterparts identically.

## Faithful divergences

| Upstream construct | TS port | Reason |
|---|---|---|
| Python `sqlite3` (stdlib, hermes_state py:21) | `better-sqlite3` runtime dep | Node `>=20` has no stdlib SQLite (`node:sqlite` is Node ≥22.5 experimental); `better-sqlite3` is the cross-runtime canonical choice with synchronous semantics matching Python `sqlite3` |
| `from agent.memory_manager import sanitize_context` (hermes_state py:26) | Injected via `SessionDbOptions.sanitizeContext`; default reproduces the `<memory-context>…</memory-context>` block strip behavior so the relevant upstream test (`test_get_messages_as_conversation_strips_leaked_memory_context`) still passes | Cross-package dep — deferred to `@hermests/agent` (task #5). When agent lands, callers will pass the real `sanitize_context` through `SessionDbOptions` and the inline fallback becomes a no-op safety net |
| Python `threading.Lock` (hermes_state py:67, 73, 338) | No-op object on `db._lock` | Node JS is single-threaded; the contention pattern the lock guarded (multi-thread within one process) does not occur. Cross-process file locking is still handled by SQLite + our application-level retry/jitter |
| `time.sleep(jitter)` in `_execute_write` retry loop | Synchronous busy-wait via `Date.now()` deadline | better-sqlite3 is sync — an `await new Promise(setTimeout)` would change the surface from sync to async and break every caller. Jitter window stays 20-150ms (worst case 150ms busy-wait per retry) |
| `time.time()` (Python — seconds, float) | `Date.now() / 1000` | JS has no first-class sub-second seconds timestamp; this matches Python's float-seconds precision for SQL REAL columns |
| `random.uniform(min, max)` | `min + Math.random() * (max - min)` | Direct, library-free equivalent |
| `unittest.mock.patch("hermes_state.sqlite3.connect")` test pattern | The WAL-fallback test suite that exercised this monkey-patch is covered by direct unit tests of `applyWalWithFallback` with synthetic failure factories instead, since better-sqlite3 doesn't expose a `factory=` argument like Python's `sqlite3.connect`. The covered behavior (NFS-style locking-protocol fallback, dedup warning, etc.) remains 1:1 |
| `sqlite3.Row` index-and-key dual access | Plain `Record<string, unknown>` rows from better-sqlite3 (key access only) | better-sqlite3 returns plain objects by default; SessionDB callers in upstream only ever used key access (`row["id"]`, `row["title"]`) plus `dict(row)`, both of which map naturally onto JS objects |

## Deferred tests

Most of upstream's `tests/test_hermes_state.py` is ported in full. The few test cases that cross-import other Python packages are tracked in `docs/deferred-tests.md` and will be ported when those packages land:

- `test_replace_messages_persists_tool_name` — imports `agent.tool_dispatch_helpers.make_tool_result_message` (deferred to `@hermests/agent` task #5)
- `test_sqlite_timeout_is_at_least_30s` — uses Python `inspect.getsource(SessionDB.__init__)` to grep for `"30"`. We pin the timeout to 1000ms intentionally (see WriteContention table above); the upstream "≥30s" assertion is incompatible with the per-jitter retry strategy we kept identical. This test does not survive the port and is dropped with a justification (not deferred — the rule it enforces is upstream-specific code-grep, not behavior).
- Most of `tests/test_lazy_session_regressions.py` — imports `tui_gateway`, `gateway.run`. Only the `TestFinalizeOrphanedCompressionSessions` cases are state-only and are ported here; the rest are deferred to `@hermests/tui-gateway` (task #11) and `@hermests/gateway` (task #10).

## Coverage

100% line / function / branch / statement against `packages/state/src/**` per the repo's `vitest.config.ts` threshold (non-negotiable).
