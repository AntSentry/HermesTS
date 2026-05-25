// Thin compatibility shim over `node-sqlite3-wasm` that exposes a surface
// close to `better-sqlite3`'s — synchronous, prepare/run/all/get, BEGIN
// IMMEDIATE for explicit transactions. Keeps session-db.ts readable.
//
// Why node-sqlite3-wasm rather than better-sqlite3? Pure WebAssembly means
// no Xcode CLT / node-gyp build step (`npm/bun install` succeeds with no
// native toolchain). Works identically under Node ≥20 and Bun. SQLite is
// compiled in with FTS5 + the trigram tokenizer enabled, matching
// upstream's hermes_state.py expectations exactly.
import {
  Database as WasmDatabase,
  type Statement as WasmStatement,
  type BindValues,
  type JSValue,
  type SQLiteValue,
  type QueryResult,
} from "node-sqlite3-wasm";

export type BindParam = JSValue | bigint | Uint8Array | null | undefined | boolean;
export type RowObject = Record<string, SQLiteValue>;

export interface RunInfo {
  changes: number;
  lastInsertRowid: number | bigint;
}

// Adapter Statement — accepts spread `(...args)` for caller ergonomics and
// translates to the wasm driver's single-array `BindValues` shape. Coerces
// `undefined` → `null` (sqlite3 in Python accepts None for unbound params;
// the wasm driver rejects undefined outright).
export interface AdapterStatement {
  run(...params: BindParam[]): RunInfo;
  all<T = RowObject>(...params: BindParam[]): T[];
  get<T = RowObject>(...params: BindParam[]): T | undefined;
}

export interface AdapterDatabase {
  /** Mirrors Python sqlite3 `conn.execute(sql, ?)` / better-sqlite3 `db.exec`. */
  exec(sql: string): void;
  prepare(sql: string): AdapterStatement;
  /** True until close() is called. */
  readonly open: boolean;
  close(): void;
  /** Underlying wasm DB — escape hatch for FTS5-specific PRAGMAs. */
  readonly _raw: WasmDatabase;
}

function _coerceParams(params: BindParam[]): BindValues {
  if (params.length === 0) return [];
  const coerced: JSValue[] = params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p;
    // bigint is supported natively by node-sqlite3-wasm; pass through.
    return p as JSValue;
  });
  return coerced;
}

class StatementWrapper implements AdapterStatement {
  constructor(private readonly _stmt: WasmStatement) {}

  run(...params: BindParam[]): RunInfo {
    const info = this._stmt.run(_coerceParams(params));
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  all<T = RowObject>(...params: BindParam[]): T[] {
    const rows = this._stmt.all(_coerceParams(params)) as QueryResult[];
    return rows as unknown as T[];
  }

  get<T = RowObject>(...params: BindParam[]): T | undefined {
    const row = this._stmt.get(_coerceParams(params));
    if (row === null || row === undefined) return undefined;
    return row as unknown as T;
  }
}

class DatabaseWrapper implements AdapterDatabase {
  private _open = true;
  constructor(public readonly _raw: WasmDatabase) {}

  get open(): boolean {
    return this._open && this._raw.isOpen;
  }

  exec(sql: string): void {
    this._raw.exec(sql);
  }

  prepare(sql: string): AdapterStatement {
    return new StatementWrapper(this._raw.prepare(sql));
  }

  close(): void {
    if (this._open && this._raw.isOpen) {
      this._raw.close();
    }
    this._open = false;
  }
}

export interface OpenOptions {
  /** SQLite busy-handler timeout in ms (PRAGMA busy_timeout). Default: 1000. */
  busyTimeoutMs?: number;
}

export function openDatabase(
  path: string,
  options: OpenOptions = {},
): AdapterDatabase {
  const raw = new WasmDatabase(path);
  // Python's sqlite3 default isolation_level="" auto-starts transactions on
  // DML. node-sqlite3-wasm matches better-sqlite3's autocommit semantics by
  // default, so we don't need to touch isolation. PRAGMA busy_timeout
  // matches Python's `timeout=1.0` kwarg.
  const busyMs = options.busyTimeoutMs ?? 1000;
  raw.exec(`PRAGMA busy_timeout = ${busyMs}`);
  return new DatabaseWrapper(raw);
}
