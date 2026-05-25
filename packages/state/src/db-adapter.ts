// Thin compatibility shim over `better-sqlite3` that exposes a stable
// AdapterDatabase surface — synchronous, prepare/run/all/get, BEGIN
// IMMEDIATE for explicit transactions. Keeps session-db.ts readable
// and provides a single seam to swap drivers.
//
// Why better-sqlite3? It is the canonical Node native SQLite binding,
// includes FTS5 + the trigram tokenizer, supports WAL mode (load-bearing
// for hermes_state.py upstream parity), and its synchronous API maps
// 1:1 onto Python's `sqlite3` stdlib used upstream. Cross-process file
// locking and SQLITE_BUSY semantics also match.
import BetterSqlite3 from "better-sqlite3";
import type { Database, Statement } from "better-sqlite3";

export type BindParam =
  | string
  | number
  | bigint
  | Buffer
  | null
  | undefined
  | boolean;
export type RowObject = Record<string, unknown>;

export interface RunInfo {
  changes: number;
  lastInsertRowid: number | bigint;
}

// Adapter Statement — accepts spread `(...args)` for caller ergonomics and
// translates to better-sqlite3's variadic bind. Coerces `undefined` → `null`
// (Python sqlite3 accepts None for unbound params; better-sqlite3 rejects
// undefined outright) and `boolean` → `0|1` (better-sqlite3 rejects booleans;
// SQLite has no native boolean — Python's `sqlite3` registers boolean as
// integer adapter by default).
export interface AdapterStatement {
  run(...params: BindParam[]): RunInfo;
  all<T = RowObject>(...params: BindParam[]): T[];
  get<T = RowObject>(...params: BindParam[]): T | undefined;
}

export interface AdapterDatabase {
  /** Mirrors Python sqlite3 `conn.execute(sql)` / better-sqlite3 `db.exec`. */
  exec(sql: string): void;
  prepare(sql: string): AdapterStatement;
  /** True until close() is called. */
  readonly open: boolean;
  close(): void;
  /** Underlying better-sqlite3 DB — escape hatch for PRAGMAs (`pragma()`). */
  readonly _raw: Database;
}

// better-sqlite3 accepts: number, bigint, string, Buffer, null. It does NOT
// accept booleans or undefined. Python sqlite3 silently maps both to safe
// values, so we replicate that here so calling code matches upstream Python
// 1:1.
function _coerceParams(params: BindParam[]): unknown[] {
  if (params.length === 0) return [];
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}

class StatementWrapper implements AdapterStatement {
  constructor(private readonly _stmt: Statement) {}

  run(...params: BindParam[]): RunInfo {
    const coerced = _coerceParams(params);
    const info = this._stmt.run(...coerced);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  all<T = RowObject>(...params: BindParam[]): T[] {
    const coerced = _coerceParams(params);
    const rows = this._stmt.all(...coerced);
    return rows as unknown as T[];
  }

  get<T = RowObject>(...params: BindParam[]): T | undefined {
    const coerced = _coerceParams(params);
    const row = this._stmt.get(...coerced);
    if (row === null || row === undefined) return undefined;
    return row as unknown as T;
  }
}

class DatabaseWrapper implements AdapterDatabase {
  private _open = true;
  constructor(public readonly _raw: Database) {}

  get open(): boolean {
    return this._open && this._raw.open;
  }

  exec(sql: string): void {
    this._raw.exec(sql);
  }

  prepare(sql: string): AdapterStatement {
    return new StatementWrapper(this._raw.prepare(sql));
  }

  close(): void {
    if (this._open && this._raw.open) {
      this._raw.close();
    }
    this._open = false;
  }
}

export interface OpenOptions {
  /** SQLite busy-handler timeout in ms (PRAGMA busy_timeout). Default: 1000. */
  busyTimeoutMs?: number;
  /** Open the database in read-only mode. */
  readonly?: boolean;
}

export function openDatabase(
  path: string,
  options: OpenOptions = {},
): AdapterDatabase {
  // better-sqlite3 throws synchronously if the file path is unusable.
  const raw = new BetterSqlite3(path, {
    readonly: options.readonly ?? false,
    fileMustExist: false,
  });
  // Python's sqlite3 default isolation_level="" auto-starts transactions on
  // DML. better-sqlite3 is in autocommit mode by default; we manage our
  // own explicit BEGIN IMMEDIATE in SessionDB._execute_write so this
  // matches semantics. PRAGMA busy_timeout matches Python's `timeout=1.0`
  // kwarg.
  const busyMs = options.busyTimeoutMs ?? 1000;
  raw.pragma(`busy_timeout = ${busyMs}`);
  return new DatabaseWrapper(raw);
}
