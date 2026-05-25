// Unit coverage for the better-sqlite3 adapter shim. Most of the surface
// is exercised end-to-end via SessionDB tests; this file targets the
// parameter-coercion edges that don't naturally show up in upstream-1:1
// SessionDB code (because Python sqlite3 silently maps them and we
// have to re-create that translation explicitly).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { openDatabase, type AdapterDatabase } from "../src/db-adapter.js";

let _tmpRoot: string;
let conn: AdapterDatabase;

beforeEach(() => {
  _tmpRoot = mkdtempSync(join(tmpdir(), "hermests-adapter-"));
  conn = openDatabase(join(_tmpRoot, "a.db"));
  conn.exec("CREATE TABLE t (a INTEGER, b TEXT)");
});

afterEach(() => {
  conn.close();
  rmSync(_tmpRoot, { recursive: true, force: true });
});

describe("openDatabase + DatabaseWrapper", () => {
  it("close() is idempotent and flips `open` to false", () => {
    expect(conn.open).toBe(true);
    conn.close();
    expect(conn.open).toBe(false);
    // second close should not throw
    expect(() => conn.close()).not.toThrow();
  });

  it("PRAGMA busy_timeout is applied", () => {
    const row = conn.prepare("PRAGMA busy_timeout").get<{ timeout: number }>();
    expect(row?.timeout).toBe(1000);
  });

  it("custom busyTimeoutMs is respected", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermests-adapter2-"));
    try {
      const c = openDatabase(join(dir, "b.db"), { busyTimeoutMs: 5000 });
      try {
        const row = c.prepare("PRAGMA busy_timeout").get<{ timeout: number }>();
        expect(row?.timeout).toBe(5000);
      } finally {
        c.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("StatementWrapper._coerceParams", () => {
  it("coerces undefined to NULL", () => {
    conn.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(1, undefined);
    const row = conn.prepare("SELECT a, b FROM t WHERE a = ?").get<{ a: number; b: string | null }>(1);
    expect(row?.a).toBe(1);
    expect(row?.b).toBe(null);
  });

  it("coerces boolean true → 1, false → 0", () => {
    conn.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(true, "t");
    conn.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(false, "f");
    const rows = conn
      .prepare("SELECT a, b FROM t ORDER BY b")
      .all<{ a: number; b: string }>();
    expect(rows).toEqual([
      { a: 0, b: "f" },
      { a: 1, b: "t" },
    ]);
  });

  it("boolean coercion in get() (single-row variant)", () => {
    conn.prepare("INSERT INTO t (a) VALUES (1)").run();
    const row = conn
      .prepare("SELECT a FROM t WHERE a = ?")
      .get<{ a: number }>(true);
    expect(row?.a).toBe(1);
  });

  it("empty params array short-circuits to no binds (run/all/get)", () => {
    conn.prepare("INSERT INTO t (a, b) VALUES (1, 'x')").run();
    expect(conn.prepare("SELECT COUNT(*) AS n FROM t").get<{ n: number }>()?.n).toBe(1);
    expect(conn.prepare("SELECT * FROM t").all<{ a: number }>().length).toBe(1);
  });

  it("get() returns undefined for no matching row", () => {
    expect(conn.prepare("SELECT a FROM t WHERE a = ?").get(999)).toBeUndefined();
  });

  it("run() returns lastInsertRowid + changes", () => {
    const info = conn.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(42, "x");
    expect(info.changes).toBe(1);
    expect(typeof info.lastInsertRowid === "number" || typeof info.lastInsertRowid === "bigint").toBe(true);
  });
});
