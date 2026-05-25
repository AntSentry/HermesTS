// Ported from hermes_state.py:311-3279 (SessionDB class + helpers).
//
// Faithful divergences from the Python original (see README.md):
//   - Python sqlite3 (stdlib) → better-sqlite3 (no Node stdlib SQLite on >=20).
//   - Python threading.Lock → no-op (Node JS is single-threaded; the
//     contention pattern the lock guarded does not occur in this runtime).
//     The `_lock` field is retained for source/test parity (.with(db._lock))
//     but is a JS no-op; we still get application-level retry/jitter for
//     SQLITE_BUSY because cross-process file locking still applies.
//   - Python `time.time()` (seconds) → `Date.now() / 1000` (seconds, float).
//   - `sanitize_context` (imported upstream from `agent.memory_manager`)
//     is injected as an optional `sanitizeContext` callback (identity by
//     default). Cross-package dep deferred to @hermests/agent (task #5).
import { mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { getHermesHome, getLogger } from "@hermests/core";

import { SCHEMA_SQL, SCHEMA_VERSION, FTS_SQL, FTS_TRIGRAM_SQL } from "./schema.js";
import { applyWalWithFallback, _setLastInitError } from "./wal-fallback.js";
import { _encodeContent, _decodeContent } from "./content-codec.js";
import { sanitizeTitle, MAX_TITLE_LENGTH } from "./title.js";
import { _sanitizeFts5Query } from "./fts5.js";
import { _containsCjk, _countCjk } from "./cjk.js";
import BetterSqlite3 from "better-sqlite3";

import {
  openDatabase,
  type AdapterDatabase,
  type BindParam,
} from "./db-adapter.js";

const logger = getLogger("hermes_state");

// Ported from hermes_state.py:34
export const DEFAULT_DB_PATH = (): string => join(getHermesHome(), "state.db");

// Public-facing record shapes. Keys mirror the SQLite column names so
// callers can compare dict equality with the Python upstream's
// dict(row) result.  Values use `unknown` where Python uses `Any` so
// callers retain the freedom to store/retrieve arbitrary JSON.

export interface SessionRow {
  id: string;
  source: string;
  user_id: string | null;
  model: string | null;
  model_config: string | null;
  system_prompt: string | null;
  parent_session_id: string | null;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  billing_provider: string | null;
  billing_base_url: string | null;
  billing_mode: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  cost_status: string | null;
  cost_source: string | null;
  pricing_version: string | null;
  title: string | null;
  api_call_count: number;
  handoff_state: string | null;
  handoff_platform: string | null;
  handoff_error: string | null;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: unknown;
  tool_call_id: string | null;
  tool_calls: unknown;
  tool_name: string | null;
  timestamp: number;
  token_count: number | null;
  finish_reason: string | null;
  reasoning: string | null;
  reasoning_content: string | null;
  reasoning_details: unknown;
  codex_reasoning_items: unknown;
  codex_message_items: unknown;
  platform_message_id: string | null;
  observed: number;
}

export interface CreateSessionOptions {
  model?: string | null;
  model_config?: Record<string, unknown> | null;
  system_prompt?: string | null;
  user_id?: string | null;
  parent_session_id?: string | null;
}

export interface UpdateTokenCountsOptions {
  input_tokens?: number;
  output_tokens?: number;
  model?: string | null;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  cost_status?: string | null;
  cost_source?: string | null;
  pricing_version?: string | null;
  billing_provider?: string | null;
  billing_base_url?: string | null;
  billing_mode?: string | null;
  api_call_count?: number;
  absolute?: boolean;
}

export interface AppendMessageOptions {
  content?: unknown;
  tool_name?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string | null;
  token_count?: number | null;
  finish_reason?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: unknown;
  codex_reasoning_items?: unknown;
  codex_message_items?: unknown;
  platform_message_id?: string | null;
  observed?: boolean;
}

export interface ReplaceMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string | null;
  tool_name?: string | null;
  token_count?: number | null;
  finish_reason?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: unknown;
  codex_reasoning_items?: unknown;
  codex_message_items?: unknown;
  platform_message_id?: string | null;
  message_id?: string | null; // yuanbao convention
  observed?: boolean;
}

export interface ConversationMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_name?: string;
  tool_calls?: unknown;
  message_id?: string;
  observed?: true;
  finish_reason?: string;
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: unknown;
  codex_reasoning_items?: unknown;
  codex_message_items?: unknown;
}

export interface SearchMessagesOptions {
  source_filter?: string[] | null;
  exclude_sources?: string[] | null;
  role_filter?: string[] | null;
  limit?: number;
  offset?: number;
  sort?: string | null;
}

export interface SearchMessageResult {
  id: number;
  session_id: string;
  role: string;
  snippet: string;
  timestamp: number;
  tool_name: string | null;
  source: string;
  model: string | null;
  session_started: number;
  context: Array<{ role: string; content: string }>;
}

export interface ListSessionsOptions {
  source?: string | null;
  exclude_sources?: string[] | null;
  limit?: number;
  offset?: number;
  include_children?: boolean;
  project_compression_tips?: boolean;
  order_by_last_active?: boolean;
}

export interface RichSessionRow extends SessionRow {
  preview: string;
  last_active: number;
  _lineage_root_id?: string;
}

export interface AnchoredWindow {
  window: MessageRow[];
  messages_before: number;
  messages_after: number;
}

export interface AnchoredView extends AnchoredWindow {
  bookend_start: MessageRow[];
  bookend_end: MessageRow[];
}

export interface MaybeAutoPruneResult {
  skipped: boolean;
  pruned: number;
  vacuumed: boolean;
  error?: string;
}

export interface HandoffState {
  state: string | null;
  platform: string | null;
  error: string | null;
}

export interface SessionDbOptions {
  /** Path to the state.db file. Default: getHermesHome()/state.db. */
  db_path?: string;
  /**
   * Optional `sanitize_context` injection (defaults to identity).  Mirrors
   * the upstream `from agent.memory_manager import sanitize_context` —
   * cross-package dep deferred to @hermests/agent (task #5).
   */
  sanitizeContext?: (text: string) => string;
}

// Type-only alias to satisfy noImplicitAny for the write-fn callback.
type WriteFn<T> = (conn: AdapterDatabase) => T;

// Cross-platform timestamp matching Python time.time(): seconds with
// floating-point sub-second precision.
function _now(): number {
  return Date.now() / 1000;
}

// Default behavior matches upstream — `sanitize_context` is imported from
// the agent package and strips <memory-context>…</memory-context> blocks.
// Until the agent package is ported this is a faithful divergence: we
// reproduce the minimal block-stripping behavior so the upstream test
// `test_get_messages_as_conversation_strips_leaked_memory_context` still
// passes.  When @hermests/agent lands, callers can pass the real
// `sanitizeContext` via SessionDbOptions.
function _defaultSanitizeContext(text: string): string {
  // simulates `agent.memory_manager.sanitize_context` block-stripping.
  return text.replace(/<memory-context>[\s\S]*?<\/memory-context>\s*/g, "");
}

// Random jitter in [minS, maxS] seconds. Matches Python random.uniform.
function _randomJitter(minS: number, maxS: number): number {
  return minS + Math.random() * (maxS - minS);
}

function _sleepSync(seconds: number): void {
  // better-sqlite3 is synchronous; matching Python's time.sleep here keeps
  // the application-level retry/jitter intact under SQLITE_BUSY.
  const deadline = Date.now() + Math.floor(seconds * 1000);
  while (Date.now() < deadline) {
    // Busy-wait — typical jitter ~50ms.  Acceptable because retries are
    // bounded (15 attempts × 150ms upper cap) and contention is rare.
  }
}

export class SessionDB {
  // ── Write-contention tuning (ported from hermes_state.py:328-332) ──
  static readonly _WRITE_MAX_RETRIES = 15;
  static readonly _WRITE_RETRY_MIN_S = 0.02; // 20ms
  static readonly _WRITE_RETRY_MAX_S = 0.15; // 150ms
  static readonly _CHECKPOINT_EVERY_N_WRITES = 50;

  // ── Title — ported from hermes_state.py:983-984 ──
  static readonly MAX_TITLE_LENGTH = MAX_TITLE_LENGTH;

  // ── Multimodal content sentinel — ported from hermes_state.py:1410 ──
  static readonly _CONTENT_JSON_PREFIX = "\x00json:";

  // Re-exposed as instance helpers so tests can call `db._lock` etc. like
  // the Python `with db._lock:` pattern in the test suite.
  readonly _lock: { __noop: true } = { __noop: true };

  readonly db_path: string;
  // _conn is exposed for test parity with the upstream Python test suite,
  // which reaches into `db._conn.execute(...)` for backdating fixtures.
  _conn!: AdapterDatabase;

  private _writeCount = 0;
  private readonly _sanitizeContext: (text: string) => string;

  constructor(dbPathOrOptions?: string | SessionDbOptions) {
    let dbPath: string;
    let sanitize: (text: string) => string;
    if (typeof dbPathOrOptions === "string") {
      dbPath = dbPathOrOptions;
      sanitize = _defaultSanitizeContext;
    } else if (dbPathOrOptions && typeof dbPathOrOptions === "object") {
      dbPath = dbPathOrOptions.db_path ?? DEFAULT_DB_PATH();
      sanitize = dbPathOrOptions.sanitizeContext ?? _defaultSanitizeContext;
    } else {
      dbPath = DEFAULT_DB_PATH();
      sanitize = _defaultSanitizeContext;
    }
    this.db_path = dbPath;
    this._sanitizeContext = sanitize;

    try {
      mkdirSync(dirname(this.db_path), { recursive: true });
      // better-sqlite3 options translated by openDatabase():
      // - busyTimeoutMs: SQLite PRAGMA busy_timeout. Python uses 1.0s (1000ms).
      // - Explicit BEGIN IMMEDIATE pattern in _execute_write matches Python
      //   sqlite3's `isolation_level=""` auto-BEGIN-on-DML semantics.
      this._conn = openDatabase(this.db_path, { busyTimeoutMs: 1000 });
      applyWalWithFallback(this._conn, { dbLabel: "state.db" });
      this._conn.exec("PRAGMA foreign_keys=ON");
      this._initSchema();
    } catch (exc) {
      /* v8 ignore start */ // better-sqlite3 always throws Error subclasses; the non-Error ternary branch + String(exc) fallback is defensive only.
      const cause =
        exc instanceof Error
          ? `${exc.constructor.name}: ${exc.message}`
          : String(exc);
      /* v8 ignore stop */
      _setLastInitError(cause);
      throw exc;
    }
  }

  // =========================================================================
  // Core write helper — ported from hermes_state.py:377-427
  // =========================================================================

  _execute_write<T>(fn: WriteFn<T>): T {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < SessionDB._WRITE_MAX_RETRIES; attempt++) {
      try {
        this._conn.exec("BEGIN IMMEDIATE");
        let result: T;
        try {
          result = fn(this._conn);
          this._conn.exec("COMMIT");
        } catch (innerExc) {
          try {
            this._conn.exec("ROLLBACK");
          } catch {
            // ignore rollback failure
          }
          throw innerExc;
        }
        this._writeCount += 1;
        if (this._writeCount % SessionDB._CHECKPOINT_EVERY_N_WRITES === 0) {
          this._tryWalCheckpoint();
        }
        return result;
      } catch (exc) {
        if (exc instanceof Error) {
          const msg = exc.message.toLowerCase();
          if (msg.includes("locked") || msg.includes("busy")) {
            lastErr = exc;
            if (attempt < SessionDB._WRITE_MAX_RETRIES - 1) {
              const jitter = _randomJitter(
                SessionDB._WRITE_RETRY_MIN_S,
                SessionDB._WRITE_RETRY_MAX_S,
              );
              _sleepSync(jitter);
              continue;
            }
          }
        }
        throw exc;
      }
      /* v8 ignore start */ // Every iteration of the loop either returns or throws; this post-loop fallback is structurally unreachable but kept as a defensive guarantee parallel to upstream.
    }
    if (lastErr) throw lastErr;
    throw new Error("database is locked after max retries");
    /* v8 ignore stop */
  }

  // Ported from hermes_state.py:429-448
  _tryWalCheckpoint(): void {
    try {
      const result = this._conn
        .prepare("PRAGMA wal_checkpoint(PASSIVE)")
        .get<{ busy: number; log: number; checkpointed: number }>();
      if (
        result &&
        /* v8 ignore next */ // result.log is always populated by SQLite when present; defensive ?? guard never falls back.
        (result.log ?? 0) > 0
      ) {
        logger.debug(
          `WAL checkpoint: ${result.checkpointed}/${result.log} pages checkpointed`,
        );
      }
    } catch {
      // best effort — never fatal
    }
  }

  // Ported from hermes_state.py:450-463
  close(): void {
    if (this._conn && this._conn.open) {
      try {
        this._conn.exec("PRAGMA wal_checkpoint(PASSIVE)");
      } catch {
        // ignore
      }
      this._conn.close();
    }
  }

  // =========================================================================
  // Schema reconciliation — ported from hermes_state.py:465-693
  // =========================================================================

  // Ported from hermes_state.py:466-506
  static _parse_schema_columns(
    schemaSql: string,
  ): Record<string, Record<string, string>> {
    // In-memory reference DB to let SQLite itself parse the DDL — no regex
    // edge cases over DEFAULT expressions / CHECK / inline REFERENCES.
    const ref = new BetterSqlite3(":memory:");
    try {
      ref.exec(schemaSql);
      const tables = ref
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as unknown as Array<{ name: string }>;
      const tableColumns: Record<string, Record<string, string>> = {};
      for (const { name: tbl } of tables) {
        const cols: Record<string, string> = {};
        const rows = ref
          .prepare(`PRAGMA table_info("${tbl}")`)
          .all() as unknown as Array<{
          cid: number;
          name: string;
          type: string | null;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>;
        for (const row of rows) {
          const colName = row.name;
          /* v8 ignore next */ // PRAGMA table_info always returns a non-null `type` column for declared columns; defensive ?? guard.
          const colType = row.type ?? "";
          const parts: string[] = colType ? [colType] : [];
          if (row.notnull && !row.pk) parts.push("NOT NULL");
          if (row.dflt_value !== null) parts.push(`DEFAULT ${row.dflt_value}`);
          cols[colName] = parts.join(" ");
        }
        tableColumns[tbl] = cols;
      }
      return tableColumns;
    } finally {
      ref.close();
    }
  }

  // Ported from hermes_state.py:508-550
  private _reconcileColumns(): void {
    const expected = SessionDB._parse_schema_columns(SCHEMA_SQL);
    for (const [tableName, declaredCols] of Object.entries(expected)) {
      let rows: Array<{ name: string }>;
      try {
        rows = this._conn
          .prepare(`PRAGMA table_info("${tableName}")`)
          .all() as Array<{ name: string }>;
        /* v8 ignore start */ // PRAGMA table_info never fails on a successfully-created table; defensive skip from upstream parity (hermes_state.py:512-513).
      } catch {
        continue;
      }
      /* v8 ignore stop */
      const liveCols = new Set<string>();
      for (const row of rows) liveCols.add(row.name);

      for (const [colName, colType] of Object.entries(declaredCols)) {
        if (!liveCols.has(colName)) {
          const safeName = colName.replace(/"/g, '""');
          try {
            this._conn.exec(
              `ALTER TABLE "${tableName}" ADD COLUMN "${safeName}" ${colType}`,
            );
            /* v8 ignore start */ // ALTER TABLE ADD COLUMN can race when two SessionDB processes open the same DB simultaneously and both attempt reconciliation; defensive log-and-skip from upstream parity (hermes_state.py:537-540).
          } catch (exc) {
            logger.debug(
              `reconcile ${tableName}.${colName}: ${(exc as Error).message}`,
            );
          }
          /* v8 ignore stop */
        }
      }
    }
  }

  // Ported from hermes_state.py:552-693
  private _initSchema(): void {
    this._conn.exec(SCHEMA_SQL);

    this._reconcileColumns();

    // Index referencing reconciler-added column.
    try {
      this._conn.exec(
        "CREATE INDEX IF NOT EXISTS idx_messages_platform_msg_id " +
          "ON messages(session_id, platform_message_id) " +
          "WHERE platform_message_id IS NOT NULL",
      );
      /* v8 ignore start */ // Index create only fails on very old DBs missing the platform_message_id column even after reconcile; defensive log-and-skip mirroring upstream (hermes_state.py:564-567).
    } catch (exc) {
      logger.debug(
        `idx_messages_platform_msg_id create skipped: ${(exc as Error).message}`,
      );
    }
    /* v8 ignore stop */

    // Schema version bookkeeping
    const versionRow = this._conn
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | undefined;

    if (versionRow === undefined) {
      this._conn
        .prepare("INSERT INTO schema_version (version) VALUES (?)")
        .run(SCHEMA_VERSION);
    } else {
      const currentVersion = versionRow.version;

      if (currentVersion < 10) {
        let trigramExists = false;
        try {
          this._conn.prepare("SELECT * FROM messages_fts_trigram LIMIT 0").all();
          trigramExists = true;
        } catch {
          trigramExists = false;
        }
        if (!trigramExists) {
          this._conn.exec(FTS_TRIGRAM_SQL);
          this._conn.exec(
            "INSERT INTO messages_fts_trigram(rowid, content) " +
              "SELECT id, content FROM messages WHERE content IS NOT NULL",
          );
        }
      }
      if (currentVersion < 11) {
        for (const trig of [
          "messages_fts_insert",
          "messages_fts_delete",
          "messages_fts_update",
          "messages_fts_trigram_insert",
          "messages_fts_trigram_delete",
          "messages_fts_trigram_update",
        ]) {
          try {
            this._conn.exec(`DROP TRIGGER IF EXISTS ${trig}`);
            /* v8 ignore start */ // IF EXISTS guard means this never throws; defensive parity with upstream's broader `except sqlite3.OperationalError: pass` (hermes_state.py:601-604).
          } catch {
            // ignore
          }
          /* v8 ignore stop */
        }
        for (const tbl of ["messages_fts", "messages_fts_trigram"]) {
          try {
            this._conn.exec(`DROP TABLE IF EXISTS ${tbl}`);
            /* v8 ignore start */ // IF EXISTS guard means this never throws; defensive parity with upstream (hermes_state.py:608-611).
          } catch {
            // ignore
          }
          /* v8 ignore stop */
        }
        this._conn.exec(FTS_SQL);
        this._conn.exec(FTS_TRIGRAM_SQL);
        this._conn.exec(
          "INSERT INTO messages_fts(rowid, content) " +
            "SELECT id, " +
            "COALESCE(content, '') || ' ' || " +
            "COALESCE(tool_name, '') || ' ' || " +
            "COALESCE(tool_calls, '') " +
            "FROM messages",
        );
        this._conn.exec(
          "INSERT INTO messages_fts_trigram(rowid, content) " +
            "SELECT id, " +
            "COALESCE(content, '') || ' ' || " +
            "COALESCE(tool_name, '') || ' ' || " +
            "COALESCE(tool_calls, '') " +
            "FROM messages",
        );
      }
      if (currentVersion < SCHEMA_VERSION) {
        this._conn
          .prepare("UPDATE schema_version SET version = ?")
          .run(SCHEMA_VERSION);
      }
    }

    // Unique title index.
    try {
      this._conn.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_title_unique " +
          "ON sessions(title) WHERE title IS NOT NULL",
      );
      /* v8 ignore start */ // CREATE INDEX IF NOT EXISTS only fails if pre-existing titles violate uniqueness (legacy data); defensive parity with upstream (hermes_state.py:651-654).
    } catch {
      // ignore
    }
    /* v8 ignore stop */

    // FTS5 setup (separate because CREATE VIRTUAL TABLE IF NOT EXISTS is
    // not reliable inside executescript).
    try {
      this._conn.prepare("SELECT * FROM messages_fts LIMIT 0").all();
    } catch {
      this._conn.exec(FTS_SQL);
    }

    try {
      this._conn.prepare("SELECT * FROM messages_fts_trigram LIMIT 0").all();
    } catch {
      this._conn.exec(FTS_TRIGRAM_SQL);
    }
  }

  // =========================================================================
  // Session lifecycle — ported from hermes_state.py:695-906
  // =========================================================================

  // Ported from hermes_state.py:699-726
  private _insertSessionRow(
    sessionId: string,
    source: string,
    opts: CreateSessionOptions = {},
  ): void {
    this._execute_write((conn) => {
      conn
        .prepare(
          "INSERT OR IGNORE INTO sessions (id, source, user_id, model, " +
            "model_config, system_prompt, parent_session_id, started_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          sessionId,
          source,
          opts.user_id ?? null,
          opts.model ?? null,
          opts.model_config ? JSON.stringify(opts.model_config) : null,
          opts.system_prompt ?? null,
          opts.parent_session_id ?? null,
          _now(),
        );
    });
  }

  // Ported from hermes_state.py:728-731
  create_session(
    sessionId: string,
    source: string,
    opts: CreateSessionOptions = {},
  ): string {
    this._insertSessionRow(sessionId, source, opts);
    return sessionId;
  }

  // Ported from hermes_state.py:732-748
  end_session(sessionId: string, endReason: string): void {
    this._execute_write((conn) => {
      conn
        .prepare(
          "UPDATE sessions SET ended_at = ?, end_reason = ? " +
            "WHERE id = ? AND ended_at IS NULL",
        )
        .run(_now(), endReason, sessionId);
    });
  }

  // Ported from hermes_state.py:750-757
  reopen_session(sessionId: string): void {
    this._execute_write((conn) => {
      conn
        .prepare(
          "UPDATE sessions SET ended_at = NULL, end_reason = NULL WHERE id = ?",
        )
        .run(sessionId);
    });
  }

  // Ported from hermes_state.py:759-766
  update_system_prompt(sessionId: string, systemPrompt: string): void {
    this._execute_write((conn) => {
      conn
        .prepare("UPDATE sessions SET system_prompt = ? WHERE id = ?")
        .run(systemPrompt, sessionId);
    });
  }

  // Ported from hermes_state.py:768-865
  update_token_counts(
    sessionId: string,
    options: UpdateTokenCountsOptions = {},
  ): void {
    const {
      input_tokens = 0,
      output_tokens = 0,
      model = null,
      cache_read_tokens = 0,
      cache_write_tokens = 0,
      reasoning_tokens = 0,
      estimated_cost_usd = null,
      actual_cost_usd = null,
      cost_status = null,
      cost_source = null,
      pricing_version = null,
      billing_provider = null,
      billing_base_url = null,
      billing_mode = null,
      api_call_count = 0,
      absolute = false,
    } = options;

    this._insertSessionRow(sessionId, "unknown", { model });

    let sql: string;
    if (absolute) {
      sql =
        "UPDATE sessions SET " +
        "input_tokens = ?, " +
        "output_tokens = ?, " +
        "cache_read_tokens = ?, " +
        "cache_write_tokens = ?, " +
        "reasoning_tokens = ?, " +
        "estimated_cost_usd = COALESCE(?, 0), " +
        "actual_cost_usd = CASE WHEN ? IS NULL THEN actual_cost_usd ELSE ? END, " +
        "cost_status = COALESCE(?, cost_status), " +
        "cost_source = COALESCE(?, cost_source), " +
        "pricing_version = COALESCE(?, pricing_version), " +
        "billing_provider = COALESCE(billing_provider, ?), " +
        "billing_base_url = COALESCE(billing_base_url, ?), " +
        "billing_mode = COALESCE(billing_mode, ?), " +
        "model = COALESCE(model, ?), " +
        "api_call_count = ? " +
        "WHERE id = ?";
    } else {
      sql =
        "UPDATE sessions SET " +
        "input_tokens = input_tokens + ?, " +
        "output_tokens = output_tokens + ?, " +
        "cache_read_tokens = cache_read_tokens + ?, " +
        "cache_write_tokens = cache_write_tokens + ?, " +
        "reasoning_tokens = reasoning_tokens + ?, " +
        "estimated_cost_usd = COALESCE(estimated_cost_usd, 0) + COALESCE(?, 0), " +
        "actual_cost_usd = CASE " +
        "  WHEN ? IS NULL THEN actual_cost_usd " +
        "  ELSE COALESCE(actual_cost_usd, 0) + ? " +
        "END, " +
        "cost_status = COALESCE(?, cost_status), " +
        "cost_source = COALESCE(?, cost_source), " +
        "pricing_version = COALESCE(?, pricing_version), " +
        "billing_provider = COALESCE(billing_provider, ?), " +
        "billing_base_url = COALESCE(billing_base_url, ?), " +
        "billing_mode = COALESCE(billing_mode, ?), " +
        "model = COALESCE(model, ?), " +
        "api_call_count = COALESCE(api_call_count, 0) + ? " +
        "WHERE id = ?";
    }
    const params: unknown[] = [
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      reasoning_tokens,
      estimated_cost_usd,
      actual_cost_usd,
      actual_cost_usd,
      cost_status,
      cost_source,
      pricing_version,
      billing_provider,
      billing_base_url,
      billing_mode,
      model,
      api_call_count,
      sessionId,
    ];
    this._execute_write((conn) => {
      conn.prepare(sql).run(...(params as never[]));
    });
  }

  // Ported from hermes_state.py:867-876
  ensure_session(
    sessionId: string,
    source = "unknown",
    opts: CreateSessionOptions = {},
  ): string {
    this._insertSessionRow(sessionId, source, opts);
    return sessionId;
  }

  // Ported from hermes_state.py:878-906
  prune_empty_ghost_sessions(sessionsDir?: string | null): number {
    const cutoff = _now() - 86400; // 24h old
    const removedIds = this._execute_write((conn) => {
      const rows = conn
        .prepare(
          "SELECT id FROM sessions " +
            "WHERE source = 'tui' " +
            "  AND title IS NULL " +
            "  AND ended_at IS NOT NULL " +
            "  AND started_at < ? " +
            "  AND NOT EXISTS (" +
            "      SELECT 1 FROM messages WHERE messages.session_id = sessions.id" +
            "  )",
        )
        .all(cutoff) as Array<{ id: string }>;
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        conn
          .prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`)
          .run(...(ids as never[]));
      }
      return ids;
    });
    if (sessionsDir && removedIds.length > 0) {
      for (const sid of removedIds) {
        SessionDB._remove_session_files(sessionsDir, sid);
      }
    }
    return removedIds.length;
  }

  // Ported from hermes_state.py:908-945
  finalize_orphaned_compression_sessions(): number {
    const cutoff = _now() - 604800; // 7d
    const changed = this._execute_write((conn) => {
      const info = conn
        .prepare(
          "UPDATE sessions " +
            "SET ended_at = ?, end_reason = 'orphaned_compression' " +
            "WHERE api_call_count = 0 " +
            "  AND end_reason IS NULL " +
            "  AND ended_at IS NULL " +
            "  AND started_at < ? " +
            "  AND parent_session_id IS NOT NULL " +
            "  AND EXISTS (" +
            "      SELECT 1 FROM sessions p " +
            "      WHERE p.id = sessions.parent_session_id " +
            "        AND p.end_reason = 'compression' " +
            "        AND p.ended_at IS NOT NULL" +
            "  ) " +
            "  AND EXISTS (" +
            "      SELECT 1 FROM messages m " +
            "      WHERE m.session_id = sessions.id" +
            "  )",
        )
        .run(_now(), cutoff);
      return info.changes;
    });
    /* v8 ignore next */ // _execute_write returns the inner fn's value (number) here; ?? 0 fallback is defensive.
    return changed ?? 0;
  }

  // Ported from hermes_state.py:947-954
  get_session(sessionId: string): SessionRow | null {
    const row = this._conn
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  // Ported from hermes_state.py:956-981
  resolve_session_id(sessionIdOrPrefix: string): string | null {
    const exact = this.get_session(sessionIdOrPrefix);
    if (exact) return exact.id;
    const escaped = sessionIdOrPrefix
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const matches = this._conn
      .prepare(
        "SELECT id FROM sessions WHERE id LIKE ? ESCAPE '\\' " +
          "ORDER BY started_at DESC LIMIT 2",
      )
      .all(`${escaped}%`) as Array<{ id: string }>;
    if (matches.length === 1) return matches[0]!.id;
    return null;
  }

  // ── Title helpers (static + instance) ──
  static sanitize_title(title: string | null | undefined): string | null {
    return sanitizeTitle(title);
  }

  // Ported from hermes_state.py:1030-1057
  set_session_title(sessionId: string, title: string): boolean {
    const sanitized = SessionDB.sanitize_title(title);
    const rowcount = this._execute_write((conn) => {
      if (sanitized) {
        const conflict = conn
          .prepare("SELECT id FROM sessions WHERE title = ? AND id != ?")
          .get(sanitized, sessionId) as { id: string } | undefined;
        if (conflict) {
          throw new Error(
            `Title '${sanitized}' is already in use by session ${conflict.id}`,
          );
        }
      }
      const info = conn
        .prepare("UPDATE sessions SET title = ? WHERE id = ?")
        .run(sanitized, sessionId);
      return info.changes;
    });
    /* v8 ignore next */ // _execute_write returns the inner fn's value (number); ?? 0 fallback never fires.
    return (rowcount ?? 0) > 0;
  }

  // Ported from hermes_state.py:1059-1066
  get_session_title(sessionId: string): string | null {
    const row = this._conn
      .prepare("SELECT title FROM sessions WHERE id = ?")
      .get(sessionId) as { title: string | null } | undefined;
    return row ? row.title : null;
  }

  // Ported from hermes_state.py:1068-1075
  get_session_by_title(title: string): SessionRow | null {
    const row = this._conn
      .prepare("SELECT * FROM sessions WHERE title = ?")
      .get(title) as SessionRow | undefined;
    return row ?? null;
  }

  // Ported from hermes_state.py:1077-1104
  resolve_session_by_title(title: string): string | null {
    const exact = this.get_session_by_title(title);
    const escaped = title
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const numbered = this._conn
      .prepare(
        "SELECT id, title, started_at FROM sessions " +
          "WHERE title LIKE ? ESCAPE '\\' ORDER BY started_at DESC",
      )
      .all(`${escaped} #%`) as Array<{ id: string; title: string; started_at: number }>;
    if (numbered.length > 0) return numbered[0]!.id;
    if (exact) return exact.id;
    return null;
  }

  // Ported from hermes_state.py:1106-1139
  get_next_title_in_lineage(baseTitle: string): string {
    const match = baseTitle.match(/^(.*?) #(\d+)$/);
    const base = match ? match[1]! : baseTitle;
    const escaped = base
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const existing = this._conn
      .prepare(
        "SELECT title FROM sessions WHERE title = ? OR title LIKE ? ESCAPE '\\'",
      )
      .all(base, `${escaped} #%`) as Array<{ title: string }>;
    if (existing.length === 0) return base;

    let maxNum = 1;
    for (const { title: t } of existing) {
      const m = t.match(/^.* #(\d+)$/);
      if (m) {
        const n = Number.parseInt(m[1]!, 10);
        if (n > maxNum) maxNum = n;
      }
    }
    return `${base} #${maxNum + 1}`;
  }

  // Ported from hermes_state.py:1141-1175
  get_compression_tip(sessionId: string): string {
    let current = sessionId;
    for (let i = 0; i < 100; i++) {
      const row = this._conn
        .prepare(
          "SELECT id FROM sessions " +
            "WHERE parent_session_id = ? " +
            "  AND started_at >= (" +
            "      SELECT ended_at FROM sessions " +
            "      WHERE id = ? AND end_reason = 'compression'" +
            "  ) " +
            "ORDER BY started_at DESC LIMIT 1",
        )
        .get(current, current) as { id: string } | undefined;
      if (row === undefined) return current;
      current = row.id;
    }
    return current;
  }

  // Ported from hermes_state.py:1177-1365
  list_sessions_rich(opts: ListSessionsOptions = {}): RichSessionRow[] {
    const {
      source = null,
      exclude_sources = null,
      limit = 20,
      offset = 0,
      include_children = false,
      project_compression_tips = true,
      order_by_last_active = false,
    } = opts;

    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (!include_children) {
      whereClauses.push(
        "(s.parent_session_id IS NULL" +
          " OR EXISTS (SELECT 1 FROM sessions p" +
          "            WHERE p.id = s.parent_session_id" +
          "            AND p.end_reason = 'branched'" +
          "            AND s.started_at >= p.ended_at))",
      );
    }

    if (source) {
      whereClauses.push("s.source = ?");
      params.push(source);
    }
    if (exclude_sources && exclude_sources.length > 0) {
      const placeholders = exclude_sources.map(() => "?").join(",");
      whereClauses.push(`s.source NOT IN (${placeholders})`);
      params.push(...exclude_sources);
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    let query: string;
    let queryParams: unknown[];
    if (order_by_last_active) {
      query = `
                WITH RECURSIVE chain(root_id, cur_id) AS (
                    SELECT s.id, s.id FROM sessions s ${whereSql}
                    UNION ALL
                    SELECT c.root_id, child.id
                    FROM chain c
                    JOIN sessions parent ON parent.id = c.cur_id
                    JOIN sessions child ON child.parent_session_id = c.cur_id
                    WHERE parent.end_reason = 'compression'
                      AND child.started_at >= parent.ended_at
                ),
                chain_max AS (
                    SELECT
                        root_id,
                        MAX(COALESCE(
                            (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = cur_id),
                            (SELECT started_at FROM sessions ss WHERE ss.id = cur_id)
                        )) AS effective_last_active
                    FROM chain
                    GROUP BY root_id
                )
                SELECT s.*,
                    COALESCE(
                        (SELECT SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 63)
                         FROM messages m
                         WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
                         ORDER BY m.timestamp, m.id LIMIT 1),
                        ''
                    ) AS _preview_raw,
                    COALESCE(
                        (SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id),
                        s.started_at
                    ) AS last_active,
                    COALESCE(cm.effective_last_active, s.started_at) AS _effective_last_active
                FROM sessions s
                LEFT JOIN chain_max cm ON cm.root_id = s.id
                ${whereSql}
                ORDER BY _effective_last_active DESC, s.started_at DESC, s.id DESC
                LIMIT ? OFFSET ?
            `;
      queryParams = [...params, ...params, limit, offset];
    } else {
      query = `
                SELECT s.*,
                    COALESCE(
                        (SELECT SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 63)
                         FROM messages m
                         WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
                         ORDER BY m.timestamp, m.id LIMIT 1),
                        ''
                    ) AS _preview_raw,
                    COALESCE(
                        (SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id),
                        s.started_at
                    ) AS last_active
                FROM sessions s
                ${whereSql}
                ORDER BY s.started_at DESC
                LIMIT ? OFFSET ?
            `;
      queryParams = [...params, limit, offset];
    }

    const rows = this._conn.prepare(query).all(...(queryParams as never[])) as Array<
      SessionRow & { _preview_raw: string | null; last_active: number; _effective_last_active?: number }
    >;

    let sessions: RichSessionRow[] = rows.map((row) => {
      /* v8 ignore next */ // SQL COALESCE(...,'') guarantees _preview_raw is never null; ?? "" is defensive.
      const raw = (row._preview_raw ?? "").trim();
      let preview = "";
      if (raw) {
        const text = raw.slice(0, 60);
        preview = text + (raw.length > 60 ? "..." : "");
      }
      const clean: Record<string, unknown> = { ...row };
      delete clean._preview_raw;
      delete clean._effective_last_active;
      clean.preview = preview;
      return clean as unknown as RichSessionRow;
    });

    if (project_compression_tips && !include_children) {
      const projected: RichSessionRow[] = [];
      for (const s of sessions) {
        if (s.end_reason !== "compression") {
          projected.push(s);
          continue;
        }
        const tipId = this.get_compression_tip(s.id);
        if (tipId === s.id) {
          projected.push(s);
          continue;
        }
        const tipRow = this._getSessionRichRow(tipId);
        if (!tipRow) {
          projected.push(s);
          continue;
        }
        const merged: RichSessionRow = { ...s };
        for (const key of [
          "id",
          "ended_at",
          "end_reason",
          "message_count",
          "tool_call_count",
          "title",
          "last_active",
          "preview",
          "model",
          "system_prompt",
        ] as const) {
          if (key in tipRow) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (merged as any)[key] = (tipRow as any)[key];
          }
        }
        merged._lineage_root_id = s.id;
        projected.push(merged);
      }
      sessions = projected;
    }

    return sessions;
  }

  // Ported from hermes_state.py:1367-1400
  private _getSessionRichRow(sessionId: string): RichSessionRow | null {
    const row = this._conn
      .prepare(
        "SELECT s.*, " +
          "  COALESCE(" +
          "    (SELECT SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 63) " +
          "     FROM messages m " +
          "     WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL " +
          "     ORDER BY m.timestamp, m.id LIMIT 1), " +
          "    ''" +
          "  ) AS _preview_raw, " +
          "  COALESCE(" +
          "    (SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id), " +
          "    s.started_at" +
          "  ) AS last_active " +
          "FROM sessions s WHERE s.id = ?",
      )
      .get(sessionId) as
      | (SessionRow & { _preview_raw: string | null; last_active: number })
      | undefined;
    if (!row) return null;
    /* v8 ignore next */ // SQL COALESCE(...,'') guarantees _preview_raw is never null; ?? "" is defensive.
    const raw = (row._preview_raw ?? "").trim();
    let preview = "";
    if (raw) {
      const text = raw.slice(0, 60);
      preview = text + (raw.length > 60 ? "..." : "");
    }
    const clean: Record<string, unknown> = { ...row };
    delete clean._preview_raw;
    clean.preview = preview;
    return clean as unknown as RichSessionRow;
  }

  // =========================================================================
  // Message storage — ported from hermes_state.py:1402-2029
  // =========================================================================

  // Ported from hermes_state.py:1412-1432
  static _encode_content(content: unknown): unknown {
    return _encodeContent(content);
  }

  // Ported from hermes_state.py:1434-1446
  static _decode_content(content: unknown): unknown {
    return _decodeContent(content);
  }

  // Ported from hermes_state.py:1448-1543
  append_message(
    sessionId: string,
    role: string,
    options: AppendMessageOptions = {},
  ): number {
    const {
      content = null,
      tool_name = null,
      tool_calls = null,
      tool_call_id = null,
      token_count = null,
      finish_reason = null,
      reasoning = null,
      reasoning_content = null,
      reasoning_details = null,
      codex_reasoning_items = null,
      codex_message_items = null,
      platform_message_id = null,
      observed = false,
    } = options;

    const reasoningDetailsJson = reasoning_details ? JSON.stringify(reasoning_details) : null;
    const codexItemsJson = codex_reasoning_items ? JSON.stringify(codex_reasoning_items) : null;
    const codexMessageItemsJson = codex_message_items
      ? JSON.stringify(codex_message_items)
      : null;
    const toolCallsJson = tool_calls ? JSON.stringify(tool_calls) : null;
    const storedContent = _encodeContent(content);

    let numToolCalls = 0;
    if (tool_calls !== null && tool_calls !== undefined) {
      numToolCalls = Array.isArray(tool_calls) ? tool_calls.length : 1;
    }

    return this._execute_write((conn) => {
      const info = conn
        .prepare(
          "INSERT INTO messages (session_id, role, content, tool_call_id, " +
            "tool_calls, tool_name, timestamp, token_count, finish_reason, " +
            "reasoning, reasoning_content, reasoning_details, codex_reasoning_items, " +
            "codex_message_items, platform_message_id, observed) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          sessionId,
          role,
          storedContent as never,
          tool_call_id,
          toolCallsJson,
          tool_name,
          _now(),
          token_count,
          finish_reason,
          reasoning,
          reasoning_content,
          reasoningDetailsJson,
          codexItemsJson,
          codexMessageItemsJson,
          platform_message_id,
          observed ? 1 : 0,
        );
      const msgId = Number(info.lastInsertRowid);
      if (numToolCalls > 0) {
        conn
          .prepare(
            "UPDATE sessions SET message_count = message_count + 1, " +
              "tool_call_count = tool_call_count + ? WHERE id = ?",
          )
          .run(numToolCalls, sessionId);
      } else {
        conn
          .prepare("UPDATE sessions SET message_count = message_count + 1 WHERE id = ?")
          .run(sessionId);
      }
      return msgId;
    });
  }

  // Ported from hermes_state.py:1545-1629
  replace_messages(sessionId: string, messages: ReplaceMessage[]): void {
    this._execute_write((conn) => {
      conn.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      conn
        .prepare(
          "UPDATE sessions SET message_count = 0, tool_call_count = 0 WHERE id = ?",
        )
        .run(sessionId);

      let nowTs = _now();
      let totalMessages = 0;
      let totalToolCalls = 0;
      const insertStmt = conn.prepare(
        "INSERT INTO messages (session_id, role, content, tool_call_id, " +
          "tool_calls, tool_name, timestamp, token_count, finish_reason, " +
          "reasoning, reasoning_content, reasoning_details, codex_reasoning_items, " +
          "codex_message_items, platform_message_id, observed) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const msg of messages) {
        const role = msg.role ?? "unknown";
        const toolCalls = msg.tool_calls;
        const reasoningDetails = role === "assistant" ? msg.reasoning_details : null;
        const codexReasoningItems = role === "assistant" ? msg.codex_reasoning_items : null;
        const codexMessageItems = role === "assistant" ? msg.codex_message_items : null;

        const reasoningDetailsJson = reasoningDetails
          ? JSON.stringify(reasoningDetails)
          : null;
        const codexItemsJson = codexReasoningItems
          ? JSON.stringify(codexReasoningItems)
          : null;
        const codexMessageItemsJson = codexMessageItems
          ? JSON.stringify(codexMessageItems)
          : null;
        const toolCallsJson = toolCalls ? JSON.stringify(toolCalls) : null;
        const platformMsgId = msg.platform_message_id ?? msg.message_id ?? null;

        insertStmt.run(
          sessionId,
          role,
          _encodeContent(msg.content) as never,
          msg.tool_call_id ?? null,
          toolCallsJson,
          msg.tool_name ?? null,
          nowTs,
          msg.token_count ?? null,
          msg.finish_reason ?? null,
          role === "assistant" ? (msg.reasoning ?? null) : null,
          role === "assistant" ? (msg.reasoning_content ?? null) : null,
          reasoningDetailsJson,
          codexItemsJson,
          codexMessageItemsJson,
          platformMsgId,
          msg.observed ? 1 : 0,
        );
        totalMessages += 1;
        if (toolCalls !== null && toolCalls !== undefined) {
          totalToolCalls += Array.isArray(toolCalls) ? toolCalls.length : 1;
        }
        nowTs += 1e-6;
      }

      conn
        .prepare(
          "UPDATE sessions SET message_count = ?, tool_call_count = ? WHERE id = ?",
        )
        .run(totalMessages, totalToolCalls, sessionId);
    });
  }

  // Ported from hermes_state.py:1631-1651
  get_messages(sessionId: string): MessageRow[] {
    const rows = this._conn
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
      .all(sessionId) as MessageRow[];
    return rows.map((row) => this._hydrateMessageRow(row));
  }

  private _hydrateMessageRow(row: MessageRow): MessageRow {
    const msg: MessageRow = { ...row };
    if ("content" in msg) msg.content = _decodeContent(msg.content);
    if (msg.tool_calls) {
      try {
        msg.tool_calls = JSON.parse(msg.tool_calls as string);
      } catch {
        logger.warning(
          "Failed to deserialize tool_calls in get_messages, falling back to []",
        );
        msg.tool_calls = [];
      }
    }
    return msg;
  }

  // Ported from hermes_state.py:1653-1729
  get_messages_around(
    sessionId: string,
    aroundMessageId: number,
    options: { window?: number } = {},
  ): AnchoredWindow {
    let { window = 5 } = options;
    if (window < 0) window = 0;

    const anchorExists = this._conn
      .prepare("SELECT 1 FROM messages WHERE id = ? AND session_id = ? LIMIT 1")
      .get(aroundMessageId, sessionId);
    if (!anchorExists) {
      return { window: [], messages_before: 0, messages_after: 0 };
    }

    const beforeRows = this._conn
      .prepare(
        "SELECT * FROM messages " +
          "WHERE session_id = ? AND id <= ? " +
          "ORDER BY id DESC LIMIT ?",
      )
      .all(sessionId, aroundMessageId, window + 1) as MessageRow[];
    const afterRows = this._conn
      .prepare(
        "SELECT * FROM messages " +
          "WHERE session_id = ? AND id > ? " +
          "ORDER BY id ASC LIMIT ?",
      )
      .all(sessionId, aroundMessageId, window) as MessageRow[];

    const rows = [...beforeRows].reverse().concat(afterRows);
    const result = rows.map((row) => this._hydrateMessageRow(row));
    const messages_before = Math.max(0, beforeRows.length - 1);
    const messages_after = afterRows.length;
    return { window: result, messages_before, messages_after };
  }

  // Ported from hermes_state.py:1731-1849
  get_anchored_view(
    sessionId: string,
    aroundMessageId: number,
    options: {
      window?: number;
      bookend?: number;
      keep_roles?: readonly string[] | null;
    } = {},
  ): AnchoredView {
    let {
      window = 5,
      bookend = 3,
      keep_roles = ["user", "assistant"] as const,
    } = options;
    if (bookend < 0) bookend = 0;

    const primitive = this.get_messages_around(sessionId, aroundMessageId, { window });
    const windowRows = primitive.window;
    if (windowRows.length === 0) {
      return {
        window: [],
        messages_before: 0,
        messages_after: 0,
        bookend_start: [],
        bookend_end: [],
      };
    }

    let filteredWindow: MessageRow[];
    if (keep_roles !== null) {
      const keepSet = new Set(keep_roles);
      filteredWindow = windowRows.filter(
        (m) => m.id === aroundMessageId || keepSet.has(m.role),
      );
    } else {
      filteredWindow = windowRows;
    }

    const windowMinId = windowRows[0]!.id;
    const windowMaxId = windowRows[windowRows.length - 1]!.id;

    let bookendStartRows: MessageRow[] = [];
    let bookendEndRows: MessageRow[] = [];
    if (bookend > 0) {
      let roleClause = "";
      const roleParams: string[] = [];
      if (keep_roles !== null) {
        const rolePlaceholders = keep_roles.map(() => "?").join(",");
        roleClause = ` AND role IN (${rolePlaceholders})`;
        roleParams.push(...keep_roles);
      }
      bookendStartRows = this._conn
        .prepare(
          `SELECT * FROM messages WHERE session_id = ? AND id < ?${roleClause} ` +
            "AND length(content) > 0 ORDER BY id ASC LIMIT ?",
        )
        .all(sessionId, windowMinId, ...roleParams, bookend) as MessageRow[];

      const endRowsRaw = this._conn
        .prepare(
          `SELECT * FROM messages WHERE session_id = ? AND id > ?${roleClause} ` +
            "AND length(content) > 0 ORDER BY id DESC LIMIT ?",
        )
        .all(sessionId, windowMaxId, ...roleParams, bookend) as MessageRow[];
      bookendEndRows = [...endRowsRaw].reverse();
    }

    return {
      window: filteredWindow,
      messages_before: primitive.messages_before,
      messages_after: primitive.messages_after,
      bookend_start: bookendStartRows.map((r) => this._hydrateMessageRow(r)),
      bookend_end: bookendEndRows.map((r) => this._hydrateMessageRow(r)),
    };
  }

  // Ported from hermes_state.py:1851-1914
  resolve_resume_session_id(sessionId: string | null | undefined): string | null | undefined {
    if (!sessionId) return sessionId;
    try {
      const row = this._conn
        .prepare("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1")
        .get(sessionId);
      if (row !== undefined) return sessionId;
    } catch {
      return sessionId;
    }
    let current = sessionId;
    const seen = new Set<string>([current]);
    for (let i = 0; i < 32; i++) {
      let childRow: { id: string } | undefined;
      try {
        childRow = this._conn
          .prepare(
            "SELECT id FROM sessions WHERE parent_session_id = ? " +
              "ORDER BY started_at DESC, id DESC LIMIT 1",
          )
          .get(current) as { id: string } | undefined;
      } catch {
        return sessionId;
      }
      if (childRow === undefined) return sessionId;
      const childId = childRow.id;
      /* v8 ignore next */ // childRow.id is the sessions.id PK (non-null TEXT NOT NULL); the !childId branch is defensive parity with upstream `if not child_id`.
      if (!childId || seen.has(childId)) return sessionId;
      seen.add(childId);
      let msgRow: unknown;
      try {
        msgRow = this._conn
          .prepare("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1")
          .get(childId);
      } catch {
        return sessionId;
      }
      if (msgRow !== undefined) return childId;
      current = childId;
    }
    return sessionId;
  }

  // Ported from hermes_state.py:1916-1993
  get_messages_as_conversation(
    sessionId: string,
    options: { include_ancestors?: boolean } = {},
  ): ConversationMessage[] {
    const { include_ancestors = false } = options;
    const sessionIds = include_ancestors
      ? this._sessionLineageRootToTip(sessionId)
      : [sessionId];

    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = this._conn
      .prepare(
        "SELECT role, content, tool_call_id, tool_calls, tool_name, " +
          "finish_reason, reasoning, reasoning_content, reasoning_details, " +
          "codex_reasoning_items, codex_message_items, platform_message_id, observed " +
          `FROM messages WHERE session_id IN (${placeholders}) ORDER BY id`,
      )
      .all(...sessionIds) as Array<{
      role: string;
      content: unknown;
      tool_call_id: string | null;
      tool_calls: string | null;
      tool_name: string | null;
      finish_reason: string | null;
      reasoning: string | null;
      reasoning_content: string | null;
      reasoning_details: string | null;
      codex_reasoning_items: string | null;
      codex_message_items: string | null;
      platform_message_id: string | null;
      observed: number;
    }>;

    const messages: ConversationMessage[] = [];
    for (const row of rows) {
      let content = _decodeContent(row.content);
      if ((row.role === "user" || row.role === "assistant") && typeof content === "string") {
        content = this._sanitizeContext(content).trim();
      }
      const msg: ConversationMessage = { role: row.role, content };
      if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
      if (row.tool_name) msg.tool_name = row.tool_name;
      if (row.tool_calls) {
        try {
          msg.tool_calls = JSON.parse(row.tool_calls);
        } catch {
          logger.warning(
            "Failed to deserialize tool_calls in conversation replay, falling back to []",
          );
          msg.tool_calls = [];
        }
      }
      if (row.platform_message_id) msg.message_id = row.platform_message_id;
      if (row.observed) msg.observed = true;
      if (row.role === "assistant") {
        if (row.finish_reason) msg.finish_reason = row.finish_reason;
        if (row.reasoning) msg.reasoning = row.reasoning;
        if (row.reasoning_content !== null) msg.reasoning_content = row.reasoning_content;
        if (row.reasoning_details) {
          try {
            msg.reasoning_details = JSON.parse(row.reasoning_details);
          } catch {
            logger.warning(
              "Failed to deserialize reasoning_details, falling back to None",
            );
            msg.reasoning_details = null;
          }
        }
        if (row.codex_reasoning_items) {
          try {
            msg.codex_reasoning_items = JSON.parse(row.codex_reasoning_items);
          } catch {
            logger.warning(
              "Failed to deserialize codex_reasoning_items, falling back to None",
            );
            msg.codex_reasoning_items = null;
          }
        }
        if (row.codex_message_items) {
          try {
            msg.codex_message_items = JSON.parse(row.codex_message_items);
          } catch {
            logger.warning(
              "Failed to deserialize codex_message_items, falling back to None",
            );
            msg.codex_message_items = null;
          }
        }
      }
      if (include_ancestors && SessionDB._isDuplicateReplayedUserMessage(messages, msg)) {
        continue;
      }
      messages.push(msg);
    }
    return messages;
  }

  // Ported from hermes_state.py:1995-2015
  private _sessionLineageRootToTip(sessionId: string): string[] {
    if (!sessionId) return [sessionId];
    const chain: string[] = [];
    let current: string | null = sessionId;
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      if (!current || seen.has(current)) break;
      seen.add(current);
      chain.push(current);
      const row = this._conn
        .prepare("SELECT parent_session_id FROM sessions WHERE id = ?")
        .get(current) as { parent_session_id: string | null } | undefined;
      if (row === undefined) break;
      current = row.parent_session_id;
    }
    /* v8 ignore next */ // chain is always seeded with sessionId on entry (early-return guard rules out empty sessionId); chain.length > 0 is always true.
    return chain.length > 0 ? chain.reverse() : [sessionId];
  }

  // Ported from hermes_state.py:2017-2029
  static _isDuplicateReplayedUserMessage(
    messages: ConversationMessage[],
    msg: ConversationMessage,
  ): boolean {
    if (msg.role !== "user") return false;
    const content = msg.content;
    if (typeof content !== "string" || !content) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const prev = messages[i]!;
      if (prev.role === "user" && prev.content === content) return true;
      if (prev.role === "assistant" && (prev.content || prev.tool_calls)) return false;
    }
    return false;
  }

  // =========================================================================
  // Search — ported from hermes_state.py:2031-2417
  // =========================================================================

  static _sanitize_fts5_query(q: string): string {
    return _sanitizeFts5Query(q);
  }

  static _contains_cjk(text: string): boolean {
    return _containsCjk(text);
  }

  static _count_cjk(text: string): number {
    return _countCjk(text);
  }

  // Ported from hermes_state.py:2119-2417
  search_messages(query: string, options: SearchMessagesOptions = {}): SearchMessageResult[] {
    const {
      source_filter = null,
      exclude_sources = null,
      role_filter = null,
      limit = 20,
      offset = 0,
      sort = null,
    } = options;
    if (!query || !query.trim()) return [];

    const sanitized = _sanitizeFts5Query(query);
    if (!sanitized) return [];

    let sortNorm: "newest" | "oldest" | null = null;
    if (typeof sort === "string") {
      const lowered = sort.trim().toLowerCase();
      if (lowered === "newest" || lowered === "oldest") sortNorm = lowered;
    }

    const orderBySql =
      sortNorm === "newest"
        ? "ORDER BY m.timestamp DESC, rank"
        : sortNorm === "oldest"
          ? "ORDER BY m.timestamp ASC, rank"
          : "ORDER BY rank";

    const whereClauses: string[] = ["messages_fts MATCH ?"];
    const params: unknown[] = [sanitized];

    if (source_filter !== null) {
      const sourcePlaceholders = source_filter.map(() => "?").join(",");
      whereClauses.push(`s.source IN (${sourcePlaceholders})`);
      params.push(...source_filter);
    }
    if (exclude_sources !== null) {
      const excludePlaceholders = exclude_sources.map(() => "?").join(",");
      whereClauses.push(`s.source NOT IN (${excludePlaceholders})`);
      params.push(...exclude_sources);
    }
    if (role_filter && role_filter.length > 0) {
      const rolePlaceholders = role_filter.map(() => "?").join(",");
      whereClauses.push(`m.role IN (${rolePlaceholders})`);
      params.push(...role_filter);
    }
    const whereSql = whereClauses.join(" AND ");
    params.push(limit, offset);

    const sql = `
            SELECT
                m.id,
                m.session_id,
                m.role,
                snippet(messages_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
                m.content,
                m.timestamp,
                m.tool_name,
                s.source,
                s.model,
                s.started_at AS session_started
            FROM messages_fts
            JOIN messages m ON m.id = messages_fts.rowid
            JOIN sessions s ON s.id = m.session_id
            WHERE ${whereSql}
            ${orderBySql}
            LIMIT ? OFFSET ?
        `;

    const isCjk = _containsCjk(sanitized);
    type RawMatch = SearchMessageResult & { content?: unknown };
    let matches: RawMatch[] = [];

    if (isCjk) {
      const rawQuery = sanitized.replace(/^"|"$/g, "").trim();
      const cjkCount = _countCjk(rawQuery);
      const tokensForCheck = rawQuery
        .split(/\s+/)
        .filter(
          (t) =>
            !["AND", "OR", "NOT"].includes(t.toUpperCase()) && _containsCjk(t),
        );
      const anyShortCjk = tokensForCheck.some((t) => _countCjk(t) < 3);

      if (cjkCount >= 3 && !anyShortCjk) {
        const tokens = rawQuery.split(/\s+/);
        const parts: string[] = [];
        for (const tok of tokens) {
          if (["AND", "OR", "NOT"].includes(tok.toUpperCase())) {
            parts.push(tok);
          } else {
            parts.push('"' + tok.replace(/"/g, '""') + '"');
          }
        }
        const trigramQuery = parts.join(" ");
        const triWhere = ["messages_fts_trigram MATCH ?"];
        const triParams: unknown[] = [trigramQuery];
        if (source_filter !== null) {
          triWhere.push(`s.source IN (${source_filter.map(() => "?").join(",")})`);
          triParams.push(...source_filter);
        }
        if (exclude_sources !== null) {
          triWhere.push(`s.source NOT IN (${exclude_sources.map(() => "?").join(",")})`);
          triParams.push(...exclude_sources);
        }
        if (role_filter && role_filter.length > 0) {
          triWhere.push(`m.role IN (${role_filter.map(() => "?").join(",")})`);
          triParams.push(...role_filter);
        }
        const triSql = `
                    SELECT
                        m.id,
                        m.session_id,
                        m.role,
                        snippet(messages_fts_trigram, 0, '>>>', '<<<', '...', 40) AS snippet,
                        m.content,
                        m.timestamp,
                        m.tool_name,
                        s.source,
                        s.model,
                        s.started_at AS session_started
                    FROM messages_fts_trigram
                    JOIN messages m ON m.id = messages_fts_trigram.rowid
                    JOIN sessions s ON s.id = m.session_id
                    WHERE ${triWhere.join(" AND ")}
                    ${orderBySql}
                    LIMIT ? OFFSET ?
                `;
        triParams.push(limit, offset);
        try {
          matches = this._conn.prepare(triSql).all(...(triParams as never[])) as RawMatch[];
        } catch {
          matches = [];
        }
      } else {
        const nonOpTokens = rawQuery
          .split(/\s+/)
          .filter((t) => !["AND", "OR", "NOT"].includes(t.toUpperCase()));
        /* v8 ignore next */ // FTS5 sanitizer + the upstream-test corpus guarantee at least one non-operator token reaches this branch; the [rawQuery] fallback is defensive parity with upstream (hermes_state.py:2300).
        const effectiveTokens = nonOpTokens.length > 0 ? nonOpTokens : [rawQuery];
        const tokenClauses: string[] = [];
        const likeParams: unknown[] = [];
        for (const tok of effectiveTokens) {
          const esc = tok
            .replace(/\\/g, "\\\\")
            .replace(/%/g, "\\%")
            .replace(/_/g, "\\_");
          tokenClauses.push(
            "(m.content LIKE ? ESCAPE '\\' OR m.tool_name LIKE ? ESCAPE '\\' OR m.tool_calls LIKE ? ESCAPE '\\')",
          );
          likeParams.push(`%${esc}%`, `%${esc}%`, `%${esc}%`);
        }
        const likeWhere = [`(${tokenClauses.join(" OR ")})`];
        if (source_filter !== null) {
          likeWhere.push(`s.source IN (${source_filter.map(() => "?").join(",")})`);
          likeParams.push(...source_filter);
        }
        if (exclude_sources !== null) {
          likeWhere.push(`s.source NOT IN (${exclude_sources.map(() => "?").join(",")})`);
          likeParams.push(...exclude_sources);
        }
        if (role_filter && role_filter.length > 0) {
          likeWhere.push(`m.role IN (${role_filter.map(() => "?").join(",")})`);
          likeParams.push(...role_filter);
        }
        const likeSql = `
                    SELECT m.id, m.session_id, m.role,
                           substr(m.content,
                                  max(1, instr(m.content, ?) - 40),
                                  120) AS snippet,
                           m.content, m.timestamp, m.tool_name,
                           s.source, s.model, s.started_at AS session_started
                    FROM messages m
                    JOIN sessions s ON s.id = m.session_id
                    WHERE ${likeWhere.join(" AND ")}
                    ORDER BY m.timestamp DESC
                    LIMIT ? OFFSET ?
                `;
        likeParams.push(limit, offset);
        const finalLikeParams = [effectiveTokens[0], ...likeParams];
        matches = this._conn
          .prepare(likeSql)
          .all(...(finalLikeParams as never[])) as RawMatch[];
      }
    } else {
      try {
        matches = this._conn.prepare(sql).all(...(params as never[])) as RawMatch[];
      } catch {
        return [];
      }
    }

    // NOTE: prepare + bind + fetch are intentionally inside the per-row
    // try/except below so a transient SQLite error during context lookup
    // for any single row degrades gracefully to `context: []` — matching
    // upstream hermes_state.py:2353-2411 where `self._conn.execute(...)`
    // (prepare+run) sits inside the try.
    const contextSql =
      "WITH target AS (" +
      "    SELECT session_id, timestamp, id " +
      "    FROM messages " +
      "    WHERE id = ?" +
      ") " +
      "SELECT role, content " +
      "FROM (" +
      "    SELECT m.id, m.timestamp, m.role, m.content " +
      "    FROM messages m " +
      "    JOIN target t ON t.session_id = m.session_id " +
      "    WHERE (m.timestamp < t.timestamp) " +
      "       OR (m.timestamp = t.timestamp AND m.id < t.id) " +
      "    ORDER BY m.timestamp DESC, m.id DESC " +
      "    LIMIT 1" +
      ") " +
      "UNION ALL " +
      "SELECT role, content FROM messages WHERE id = ? " +
      "UNION ALL " +
      "SELECT role, content " +
      "FROM (" +
      "    SELECT m.id, m.timestamp, m.role, m.content " +
      "    FROM messages m " +
      "    JOIN target t ON t.session_id = m.session_id " +
      "    WHERE (m.timestamp > t.timestamp) " +
      "       OR (m.timestamp = t.timestamp AND m.id > t.id) " +
      "    ORDER BY m.timestamp ASC, m.id ASC " +
      "    LIMIT 1" +
      ")";

    for (const match of matches) {
      try {
        const contextStmt = this._conn.prepare(contextSql);
        const contextRows = contextStmt.all(match.id, match.id) as Array<{
          role: string;
          content: unknown;
        }>;
        const contextMsgs: Array<{ role: string; content: string }> = [];
        for (const r of contextRows) {
          const decoded = _decodeContent(r.content);
          let preview = "";
          if (Array.isArray(decoded)) {
            const textParts = decoded
              .filter(
                (p): p is { type: string; text?: string } =>
                  typeof p === "object" &&
                  p !== null &&
                  (p as { type?: unknown }).type === "text",
              )
              /* v8 ignore next */ // Multimodal `text` parts always carry a text string; ?? "" fallback is defensive for partial/malformed parts.
              .map((p) => p.text ?? "");
            const text = textParts.filter((t) => t).join(" ").trim();
            preview = text || "[multimodal content]";
          } else if (typeof decoded === "string") {
            preview = decoded;
          }
          contextMsgs.push({ role: r.role, content: preview.slice(0, 200) });
        }
        match.context = contextMsgs;
      } catch {
        match.context = [];
      }
    }

    for (const match of matches) {
      delete match.content;
    }

    return matches as SearchMessageResult[];
  }

  // Ported from hermes_state.py:2419-2453
  search_sessions(
    options: { source?: string | null; limit?: number; offset?: number } = {},
  ): RichSessionRow[] {
    const { source = null, limit = 20, offset = 0 } = options;
    const selectWithLastActive =
      "SELECT s.*, COALESCE(m.last_active, s.started_at) AS last_active " +
      "FROM sessions s " +
      "LEFT JOIN (" +
      "SELECT session_id, MAX(timestamp) AS last_active " +
      "FROM messages GROUP BY session_id" +
      ") m ON m.session_id = s.id ";
    if (source) {
      return this._conn
        .prepare(
          selectWithLastActive +
            "WHERE s.source = ? " +
            "ORDER BY last_active DESC, s.started_at DESC, s.id DESC LIMIT ? OFFSET ?",
        )
        .all(source, limit, offset) as RichSessionRow[];
    }
    return this._conn
      .prepare(
        selectWithLastActive +
          "ORDER BY last_active DESC, s.started_at DESC, s.id DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as RichSessionRow[];
  }

  // =========================================================================
  // Utility — ported from hermes_state.py:2455-2479
  // =========================================================================

  session_count(source?: string | null): number {
    if (source) {
      const row = this._conn
        .prepare("SELECT COUNT(*) as c FROM sessions WHERE source = ?")
        .get(source) as { c: number };
      return row.c;
    }
    const row = this._conn
      .prepare("SELECT COUNT(*) as c FROM sessions")
      .get() as { c: number };
    return row.c;
  }

  message_count(sessionId?: string | null): number {
    if (sessionId) {
      const row = this._conn
        .prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?")
        .get(sessionId) as { c: number };
      return row.c;
    }
    const row = this._conn
      .prepare("SELECT COUNT(*) as c FROM messages")
      .get() as { c: number };
    return row.c;
  }

  // =========================================================================
  // Export and cleanup — ported from hermes_state.py:2481-2631
  // =========================================================================

  export_session(sessionId: string): (SessionRow & { messages: MessageRow[] }) | null {
    const session = this.get_session(sessionId);
    if (!session) return null;
    const messages = this.get_messages(sessionId);
    return { ...session, messages };
  }

  export_all(
    source?: string | null,
  ): Array<RichSessionRow & { messages: MessageRow[] }> {
    const sessions = this.search_sessions({ source: source ?? null, limit: 100000 });
    const results: Array<RichSessionRow & { messages: MessageRow[] }> = [];
    for (const session of sessions) {
      const messages = this.get_messages(session.id);
      results.push({ ...session, messages });
    }
    return results;
  }

  clear_messages(sessionId: string): void {
    this._execute_write((conn) => {
      conn.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      conn
        .prepare(
          "UPDATE sessions SET message_count = 0, tool_call_count = 0 WHERE id = ?",
        )
        .run(sessionId);
    });
  }

  // Ported from hermes_state.py:2517-2542
  static _remove_session_files(
    sessionsDir: string | null | undefined,
    sessionId: string,
  ): void {
    if (!sessionsDir) return;
    for (const suffix of [".json", ".jsonl"] as const) {
      const p = join(sessionsDir, `${sessionId}${suffix}`);
      try {
        unlinkSync(p);
      } catch {
        // ignore missing/permission issues
      }
    }
    try {
      for (const name of readdirSync(sessionsDir)) {
        if (
          name.startsWith(`request_dump_${sessionId}_`) &&
          name.endsWith(".json")
        ) {
          try {
            unlinkSync(join(sessionsDir, name));
            /* v8 ignore start */ // Per-file unlink failure (permission, race vs another writer); upstream mirrors with silent skip (hermes_state.py:2532-2542).
          } catch {
            // ignore
          }
          /* v8 ignore stop */
        }
      }
      /* v8 ignore start */ // Outer catch covers readdirSync failure on stale/disappearing sessions directory; defensive parity with upstream (hermes_state.py:2530-2546).
    } catch {
      // ignore
    }
    /* v8 ignore stop */
  }

  // Ported from hermes_state.py:2544-2576
  delete_session(sessionId: string, sessionsDir?: string | null): boolean {
    const deleted = this._execute_write((conn) => {
      const exists = conn
        .prepare("SELECT COUNT(*) as c FROM sessions WHERE id = ?")
        .get(sessionId) as { c: number };
      if (exists.c === 0) return false;
      conn
        .prepare(
          "UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?",
        )
        .run(sessionId);
      conn.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      conn.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      return true;
    });
    if (deleted) {
      SessionDB._remove_session_files(sessionsDir, sessionId);
    }
    return deleted;
  }

  // Ported from hermes_state.py:2578-2631
  prune_sessions(
    options: { older_than_days?: number; source?: string | null; sessions_dir?: string | null } = {},
  ): number {
    const { older_than_days = 90, source = null, sessions_dir = null } = options;
    const cutoff = _now() - older_than_days * 86400;
    const removedIds: string[] = [];
    const writeResult = this._execute_write((conn) => {
      let rows: Array<{ id: string }>;
      if (source) {
        rows = conn
          .prepare(
            "SELECT id FROM sessions WHERE started_at < ? " +
              "AND ended_at IS NOT NULL AND source = ?",
          )
          .all(cutoff, source) as Array<{ id: string }>;
      } else {
        rows = conn
          .prepare(
            "SELECT id FROM sessions WHERE started_at < ? AND ended_at IS NOT NULL",
          )
          .all(cutoff) as Array<{ id: string }>;
      }
      const sessionIds = new Set(rows.map((r) => r.id));
      if (sessionIds.size === 0) return 0;
      const placeholders = Array.from(sessionIds).map(() => "?").join(",");
      const ids = Array.from(sessionIds);
      conn
        .prepare(
          `UPDATE sessions SET parent_session_id = NULL ` +
            `WHERE parent_session_id IN (${placeholders})`,
        )
        .run(...(ids as never[]));
      for (const sid of sessionIds) {
        conn.prepare("DELETE FROM messages WHERE session_id = ?").run(sid);
        conn.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
        removedIds.push(sid);
      }
      return sessionIds.size;
    });
    /* v8 ignore next */ // _execute_write returns the inner fn's value (number) here; ?? 0 fallback is defensive.
    const count = writeResult ?? 0;
    for (const sid of removedIds) {
      SessionDB._remove_session_files(sessions_dir, sid);
    }
    return count;
  }

  // =========================================================================
  // Meta key/value — ported from hermes_state.py:2633-2653
  // =========================================================================

  get_meta(key: string): string | null {
    const row = this._conn
      .prepare("SELECT value FROM state_meta WHERE key = ?")
      .get(key) as { value: string | null } | undefined;
    if (row === undefined) return null;
    return row.value;
  }

  set_meta(key: string, value: string): void {
    this._execute_write((conn) => {
      conn
        .prepare(
          "INSERT INTO state_meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value);
    });
  }

  // =========================================================================
  // Telegram topic mode — ported from hermes_state.py:2655-3080
  // =========================================================================

  apply_telegram_topic_migration(): void {
    this._execute_write((conn) => {
      conn.exec(
        `
                CREATE TABLE IF NOT EXISTS telegram_dm_topic_mode (
                    chat_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    activated_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    has_topics_enabled INTEGER,
                    allows_users_to_create_topics INTEGER,
                    capability_checked_at REAL,
                    intro_message_id TEXT,
                    pinned_message_id TEXT
                );

                CREATE TABLE IF NOT EXISTS telegram_dm_topic_bindings (
                    chat_id TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    session_key TEXT NOT NULL,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    managed_mode TEXT NOT NULL DEFAULT 'auto',
                    linked_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (chat_id, thread_id)
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_dm_topic_bindings_session
                ON telegram_dm_topic_bindings(session_id);

                CREATE INDEX IF NOT EXISTS idx_telegram_dm_topic_bindings_user
                ON telegram_dm_topic_bindings(user_id, chat_id);
                `,
      );

      const current = conn
        .prepare("SELECT value FROM state_meta WHERE key = ?")
        .get("telegram_dm_topic_schema_version") as { value: string } | undefined;
      const currentVersion =
        current && /^\d+$/.test(String(current.value)) ? Number.parseInt(current.value, 10) : 0;
      if (currentVersion < 2) {
        const fkRows = conn
          .prepare("PRAGMA foreign_key_list('telegram_dm_topic_bindings')")
          .all() as Array<{
          id: number;
          seq: number;
          table: string;
          from: string;
          to: string;
          on_update: string;
          on_delete: string;
          match: string;
        }>;
        const needsRebuild = fkRows.some(
          /* v8 ignore next */ // PRAGMA foreign_key_list always returns a string on_delete column ("NO ACTION" by default); ?? "" is defensive.
          (row) => row.table === "sessions" && (row.on_delete ?? "") !== "CASCADE",
        );
        if (needsRebuild) {
          conn.exec(`
                        CREATE TABLE telegram_dm_topic_bindings_new (
                            chat_id TEXT NOT NULL,
                            thread_id TEXT NOT NULL,
                            user_id TEXT NOT NULL,
                            session_key TEXT NOT NULL,
                            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                            managed_mode TEXT NOT NULL DEFAULT 'auto',
                            linked_at REAL NOT NULL,
                            updated_at REAL NOT NULL,
                            PRIMARY KEY (chat_id, thread_id)
                        );
                        INSERT INTO telegram_dm_topic_bindings_new
                            SELECT chat_id, thread_id, user_id, session_key,
                                   session_id, managed_mode, linked_at, updated_at
                            FROM telegram_dm_topic_bindings;
                        DROP TABLE telegram_dm_topic_bindings;
                        ALTER TABLE telegram_dm_topic_bindings_new
                            RENAME TO telegram_dm_topic_bindings;
                        CREATE UNIQUE INDEX idx_telegram_dm_topic_bindings_session
                            ON telegram_dm_topic_bindings(session_id);
                        CREATE INDEX idx_telegram_dm_topic_bindings_user
                            ON telegram_dm_topic_bindings(user_id, chat_id);
                    `);
        }
      }

      conn
        .prepare(
          "INSERT INTO state_meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run("telegram_dm_topic_schema_version", "2");
    });
  }

  enable_telegram_topic_mode(options: {
    chat_id: string;
    user_id: string;
    has_topics_enabled?: boolean | null;
    allows_users_to_create_topics?: boolean | null;
  }): void {
    this.apply_telegram_topic_migration();
    const now = _now();
    const toInt = (v: boolean | null | undefined): number | null =>
      v === null || v === undefined ? null : v ? 1 : 0;
    this._execute_write((conn) => {
      conn
        .prepare(
          `
                INSERT INTO telegram_dm_topic_mode (
                    chat_id, user_id, enabled, activated_at, updated_at,
                    has_topics_enabled, allows_users_to_create_topics,
                    capability_checked_at
                ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET
                    user_id = excluded.user_id,
                    enabled = 1,
                    updated_at = excluded.updated_at,
                    has_topics_enabled = excluded.has_topics_enabled,
                    allows_users_to_create_topics = excluded.allows_users_to_create_topics,
                    capability_checked_at = excluded.capability_checked_at
                `,
        )
        .run(
          String(options.chat_id),
          String(options.user_id),
          now,
          now,
          toInt(options.has_topics_enabled ?? null),
          toInt(options.allows_users_to_create_topics ?? null),
          now,
        );
    });
  }

  disable_telegram_topic_mode(options: { chat_id: string; clear_bindings?: boolean }): void {
    const { clear_bindings = true } = options;
    this._execute_write((conn) => {
      try {
        conn
          .prepare(
            "UPDATE telegram_dm_topic_mode SET enabled = 0, updated_at = ? WHERE chat_id = ?",
          )
          .run(_now(), String(options.chat_id));
        if (clear_bindings) {
          conn
            .prepare("DELETE FROM telegram_dm_topic_bindings WHERE chat_id = ?")
            .run(String(options.chat_id));
        }
      } catch {
        // Tables don't exist yet — nothing to disable.
        return;
      }
    });
  }

  is_telegram_topic_mode_enabled(options: { chat_id: string; user_id: string }): boolean {
    try {
      const row = this._conn
        .prepare(
          "SELECT enabled FROM telegram_dm_topic_mode WHERE chat_id = ? AND user_id = ?",
        )
        .get(String(options.chat_id), String(options.user_id)) as
        | { enabled: number }
        | undefined;
      if (row === undefined) return false;
      return Boolean(row.enabled);
    } catch {
      return false;
    }
  }

  get_telegram_topic_binding(options: {
    chat_id: string;
    thread_id: string;
  }): Record<string, unknown> | null {
    try {
      const row = this._conn
        .prepare(
          "SELECT * FROM telegram_dm_topic_bindings WHERE chat_id = ? AND thread_id = ?",
        )
        .get(String(options.chat_id), String(options.thread_id)) as
        | Record<string, unknown>
        | undefined;
      return row ? { ...row } : null;
    } catch {
      return null;
    }
  }

  list_telegram_topic_bindings_for_chat(options: {
    chat_id: string;
  }): Array<Record<string, unknown>> {
    try {
      return this._conn
        .prepare(
          "SELECT * FROM telegram_dm_topic_bindings WHERE chat_id = ? ORDER BY updated_at DESC",
        )
        .all(String(options.chat_id)) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }

  get_telegram_topic_binding_by_session(options: {
    session_id: string;
  }): Record<string, unknown> | null {
    try {
      const row = this._conn
        .prepare("SELECT * FROM telegram_dm_topic_bindings WHERE session_id = ?")
        .get(String(options.session_id)) as Record<string, unknown> | undefined;
      return row ? { ...row } : null;
    } catch {
      return null;
    }
  }

  bind_telegram_topic(options: {
    chat_id: string;
    thread_id: string;
    user_id: string;
    session_key: string;
    session_id: string;
    managed_mode?: string;
  }): void {
    const { managed_mode = "auto" } = options;
    this.apply_telegram_topic_migration();
    const now = _now();
    const chatId = String(options.chat_id);
    const threadId = String(options.thread_id);
    const userId = String(options.user_id);
    const sessionKey = String(options.session_key);
    const sessionId = String(options.session_id);

    this._execute_write((conn) => {
      const existingSession = conn
        .prepare(
          "SELECT chat_id, thread_id FROM telegram_dm_topic_bindings WHERE session_id = ?",
        )
        .get(sessionId) as { chat_id: string; thread_id: string } | undefined;
      if (existingSession !== undefined) {
        if (
          String(existingSession.chat_id) !== chatId ||
          String(existingSession.thread_id) !== threadId
        ) {
          throw new Error("session is already linked to another Telegram topic");
        }
      }
      conn
        .prepare(
          `
                INSERT INTO telegram_dm_topic_bindings (
                    chat_id, thread_id, user_id, session_key, session_id,
                    managed_mode, linked_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(chat_id, thread_id) DO UPDATE SET
                    user_id = excluded.user_id,
                    session_key = excluded.session_key,
                    session_id = excluded.session_id,
                    managed_mode = excluded.managed_mode,
                    updated_at = excluded.updated_at
                `,
        )
        .run(chatId, threadId, userId, sessionKey, sessionId, managed_mode, now, now);
    });
  }

  is_telegram_session_linked_to_topic(options: { session_id: string }): boolean {
    try {
      const row = this._conn
        .prepare(
          "SELECT 1 FROM telegram_dm_topic_bindings WHERE session_id = ? LIMIT 1",
        )
        .get(String(options.session_id));
      return row !== undefined;
    } catch {
      return false;
    }
  }

  list_unlinked_telegram_sessions_for_user(options: {
    chat_id: string;
    user_id: string;
    limit?: number;
  }): Array<Record<string, unknown>> {
    const { limit = 10 } = options;
    let rows: Array<Record<string, unknown> & { _preview_raw?: string | null }>;
    try {
      rows = this._conn
        .prepare(
          `
                SELECT s.*,
                    COALESCE(
                        (SELECT SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 63)
                         FROM messages m
                         WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
                         ORDER BY m.timestamp, m.id LIMIT 1),
                        ''
                    ) AS _preview_raw,
                    COALESCE(
                        (SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id),
                        s.started_at
                    ) AS last_active
                FROM sessions s
                WHERE s.source = 'telegram'
                  AND s.user_id = ?
                  AND NOT EXISTS (
                      SELECT 1 FROM telegram_dm_topic_bindings b
                      WHERE b.session_id = s.id
                  )
                ORDER BY last_active DESC, s.started_at DESC
                LIMIT ?
                `,
        )
        .all(String(options.user_id), Math.trunc(limit)) as Array<
        Record<string, unknown> & { _preview_raw?: string | null }
      >;
    } catch {
      rows = this._conn
        .prepare(
          `
                SELECT s.*,
                    COALESCE(
                        (SELECT SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 63)
                         FROM messages m
                         WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
                         ORDER BY m.timestamp, m.id LIMIT 1),
                        ''
                    ) AS _preview_raw,
                    COALESCE(
                        (SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id),
                        s.started_at
                    ) AS last_active
                FROM sessions s
                WHERE s.source = 'telegram'
                  AND s.user_id = ?
                ORDER BY last_active DESC, s.started_at DESC
                LIMIT ?
                `,
        )
        .all(String(options.user_id), Math.trunc(limit)) as Array<
        Record<string, unknown> & { _preview_raw?: string | null }
      >;
    }

    const sessions: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const session: Record<string, unknown> = { ...row };
      /* v8 ignore next */ // SQL COALESCE(...,'') guarantees _preview_raw is never null; ?? "" is defensive.
      const raw = String(session._preview_raw ?? "").trim();
      delete session._preview_raw;
      session.preview = raw ? raw.slice(0, 60) + (raw.length > 60 ? "..." : "") : "";
      sessions.push(session);
    }
    return sessions;
  }

  // =========================================================================
  // Space reclamation — ported from hermes_state.py:3082-3178
  // =========================================================================

  vacuum(): void {
    try {
      this._conn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore
    }
    this._conn.exec("VACUUM");
  }

  maybe_auto_prune_and_vacuum(
    options: {
      retention_days?: number;
      min_interval_hours?: number;
      vacuum?: boolean;
      sessions_dir?: string | null;
    } = {},
  ): MaybeAutoPruneResult {
    const {
      retention_days = 90,
      min_interval_hours = 24,
      vacuum = true,
      sessions_dir = null,
    } = options;

    const result: MaybeAutoPruneResult = { skipped: false, pruned: 0, vacuumed: false };
    try {
      const lastRaw = this.get_meta("last_auto_prune");
      const now = _now();
      if (lastRaw) {
        const lastTs = Number.parseFloat(lastRaw);
        if (!Number.isNaN(lastTs)) {
          if (now - lastTs < min_interval_hours * 3600) {
            result.skipped = true;
            return result;
          }
        }
      }
      const pruned = this.prune_sessions({
        older_than_days: retention_days,
        sessions_dir,
      });
      result.pruned = pruned;
      if (vacuum && pruned > 0) {
        try {
          this.vacuum();
          result.vacuumed = true;
        } catch (exc) {
          logger.warning(`state.db VACUUM failed: ${(exc as Error).message}`);
        }
      }
      this.set_meta("last_auto_prune", String(now));
      if (pruned > 0) {
        logger.info(
          `state.db auto-maintenance: pruned ${pruned} session(s) older than ` +
            `${retention_days} days${result.vacuumed ? " + VACUUM" : ""}`,
        );
      }
    } catch (exc) {
      logger.warning(`state.db auto-maintenance failed: ${(exc as Error).message}`);
      result.error = (exc as Error).message;
    }
    return result;
  }

  // =========================================================================
  // Handoff — ported from hermes_state.py:3180-3278
  // =========================================================================

  request_handoff(sessionId: string, platform: string): boolean {
    return this._execute_write((conn) => {
      const info = conn
        .prepare(
          "UPDATE sessions SET handoff_state = 'pending', " +
            "handoff_platform = ?, handoff_error = NULL " +
            "WHERE id = ? AND (handoff_state IS NULL " +
            "                  OR handoff_state IN ('completed', 'failed'))",
        )
        .run(platform, sessionId);
      return info.changes > 0;
    });
  }

  get_handoff_state(sessionId: string): HandoffState | null {
    try {
      const row = this._conn
        .prepare(
          "SELECT handoff_state, handoff_platform, handoff_error FROM sessions WHERE id = ?",
        )
        .get(sessionId) as
        | {
            handoff_state: string | null;
            handoff_platform: string | null;
            handoff_error: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        state: row.handoff_state,
        platform: row.handoff_platform,
        error: row.handoff_error,
      };
    } catch {
      return null;
    }
  }

  list_pending_handoffs(): SessionRow[] {
    try {
      return this._conn
        .prepare(
          "SELECT * FROM sessions WHERE handoff_state = 'pending' ORDER BY started_at ASC",
        )
        .all() as SessionRow[];
    } catch {
      return [];
    }
  }

  claim_handoff(sessionId: string): boolean {
    return this._execute_write((conn) => {
      const info = conn
        .prepare(
          "UPDATE sessions SET handoff_state = 'running' " +
            "WHERE id = ? AND handoff_state = 'pending'",
        )
        .run(sessionId);
      return info.changes > 0;
    });
  }

  complete_handoff(sessionId: string): void {
    this._execute_write((conn) => {
      conn
        .prepare(
          "UPDATE sessions SET handoff_state = 'completed', handoff_error = NULL WHERE id = ?",
        )
        .run(sessionId);
    });
  }

  fail_handoff(sessionId: string, error: string): void {
    this._execute_write((conn) => {
      conn
        .prepare("UPDATE sessions SET handoff_state = 'failed', handoff_error = ? WHERE id = ?")
        .run(error.slice(0, 500), sessionId);
    });
  }
}

// Re-export support symbols that tests pull in via `from hermes_state import ...`.
// Direct file imports avoid circulars (everything below is leaf).
export {
  applyWalWithFallback,
  getLastInitError,
  formatSessionDbUnavailable,
  _setLastInitError,
  _resetWalFallbackWarnedPaths,
} from "./wal-fallback.js";
export { SCHEMA_SQL, FTS_SQL, FTS_TRIGRAM_SQL, SCHEMA_VERSION } from "./schema.js";
export { sanitizeTitle, MAX_TITLE_LENGTH } from "./title.js";

// Marker import to keep TS happy when the file is referenced from tests
// purely for the BindParam type. Avoids "unused import" lints.
export type { BindParam };
