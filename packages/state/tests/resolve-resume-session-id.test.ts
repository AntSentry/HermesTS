// Ported from tests/hermes_state/test_resolve_resume_session_id.py.
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionDB } from "../src/index.js";

let _tmpRoot: string;
let db: SessionDB;

beforeEach(() => {
  _tmpRoot = mkdtempSync(join(tmpdir(), "hermests-rr-"));
  db = new SessionDB(join(_tmpRoot, "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(_tmpRoot, { recursive: true, force: true });
});

function makeChain(rows: Array<[string, string | null]>): void {
  const base = Math.floor(Date.now() / 1000) - 10_000;
  rows.forEach(([sid, parent], i) => {
    db.create_session(sid, "cli", parent ? { parent_session_id: parent } : {});
    db._conn
      .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run(base + i * 100, sid);
  });
}

describe("resolve_resume_session_id", () => {
  it("redirects from empty head to descendant with messages", () => {
    makeChain([
      ["head", null],
      ["mid1", "head"],
      ["mid2", "mid1"],
      ["mid3", "mid2"],
      ["bulk", "mid3"],
      ["tail", "bulk"],
    ]);
    for (let i = 0; i < 5; i++) {
      db.append_message("bulk", "user", { content: `msg ${i}` });
    }
    expect(db.resolve_resume_session_id("head")).toBe("bulk");
  });

  it("returns self when session has messages", () => {
    makeChain([
      ["root", null],
      ["child", "root"],
    ]);
    db.append_message("root", "user", { content: "hi" });
    expect(db.resolve_resume_session_id("root")).toBe("root");
  });

  it("returns self when no descendant has messages", () => {
    makeChain([
      ["root", null],
      ["child1", "root"],
      ["child2", "child1"],
    ]);
    expect(db.resolve_resume_session_id("root")).toBe("root");
  });

  it("returns self for isolated session", () => {
    db.create_session("isolated", "cli");
    expect(db.resolve_resume_session_id("isolated")).toBe("isolated");
  });

  it("returns self for nonexistent session id", () => {
    expect(db.resolve_resume_session_id("does_not_exist")).toBe("does_not_exist");
  });

  it("empty / null session id passthrough", () => {
    expect(db.resolve_resume_session_id("")).toBe("");
    expect(db.resolve_resume_session_id(null)).toBe(null);
    expect(db.resolve_resume_session_id(undefined)).toBe(undefined);
  });

  it("walks from middle of chain", () => {
    makeChain([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
      ["d", "c"],
    ]);
    db.append_message("d", "user", { content: "x" });
    expect(db.resolve_resume_session_id("b")).toBe("d");
    expect(db.resolve_resume_session_id("c")).toBe("d");
  });

  it("prefers most recent child when fork exists", () => {
    makeChain([
      ["parent", null],
      ["older_fork", "parent"],
      ["newer_fork", "parent"],
    ]);
    db.append_message("newer_fork", "user", { content: "x" });
    expect(db.resolve_resume_session_id("parent")).toBe("newer_fork");
  });

  it("swallows underlying DB errors gracefully", () => {
    db.create_session("err", "cli");
    const orig = db._conn.prepare.bind(db._conn);
    db._conn.prepare = ((sql: string) => {
      if (sql.includes("FROM messages")) throw new Error("simulated");
      return orig(sql);
    }) as typeof db._conn.prepare;
    try {
      expect(db.resolve_resume_session_id("err")).toBe("err");
    } finally {
      db._conn.prepare = orig;
    }
  });

  it("swallows DB errors during child-lookup mid-walk", () => {
    // Build a chain so the function enters the for-loop. Then make the
    // *child query* (FROM sessions WHERE parent_session_id) throw, while
    // the initial messages-check succeeds (returning a row would short-
    // circuit, so the first check must return undefined → no row).
    makeChain([
      ["root", null],
      ["c1", "root"],
    ]);
    // root has no messages; c1 has none either. Normal flow returns "root".
    const orig = db._conn.prepare.bind(db._conn);
    db._conn.prepare = ((sql: string) => {
      if (sql.includes("FROM sessions WHERE parent_session_id")) {
        throw new Error("simulated child-lookup failure");
      }
      return orig(sql);
    }) as typeof db._conn.prepare;
    try {
      expect(db.resolve_resume_session_id("root")).toBe("root");
    } finally {
      db._conn.prepare = orig;
    }
  });

  it("swallows DB errors during descendant message-check mid-walk", () => {
    // Build chain such that initial messages-check for "root" returns
    // undefined (no rows), then the child query returns "c1", and then
    // the messages-check FOR THE CHILD throws.
    makeChain([
      ["root", null],
      ["c1", "root"],
    ]);
    const orig = db._conn.prepare.bind(db._conn);
    let initialCheckPassed = false;
    db._conn.prepare = ((sql: string) => {
      if (sql.includes("FROM messages WHERE session_id")) {
        if (!initialCheckPassed) {
          initialCheckPassed = true;
          return orig(sql); // first messages-check for "root" works
        }
        // second messages-check (for child "c1") throws
        throw new Error("simulated descendant message-check failure");
      }
      return orig(sql);
    }) as typeof db._conn.prepare;
    try {
      expect(db.resolve_resume_session_id("root")).toBe("root");
    } finally {
      db._conn.prepare = orig;
    }
  });

  it("returns input when walk exhausts the 32-iteration safety cap", () => {
    // Build a chain longer than the loop cap. Each session has no messages,
    // so the walk progresses (childRow returned, no msgRow), and after 32
    // iterations the loop exits and the function returns the original id.
    const rows: Array<[string, string | null]> = [["root", null]];
    for (let i = 0; i < 40; i++) {
      rows.push([`n${i}`, i === 0 ? "root" : `n${i - 1}`]);
    }
    makeChain(rows);
    // None of the sessions have messages; the function should return the
    // original id after the cap is reached.
    expect(db.resolve_resume_session_id("root")).toBe("root");
  });
});
