// Ported from tests/test_lazy_session_regressions.py
// (TestFinalizeOrphanedCompressionSessions only — the other classes test
// tui_gateway / gateway.run and are deferred to those packages.)
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionDB } from "../src/index.js";

let _tmpRoot: string;
let db: SessionDB;

beforeEach(() => {
  _tmpRoot = mkdtempSync(join(tmpdir(), "hermests-orp-"));
  db = new SessionDB(join(_tmpRoot, "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(_tmpRoot, { recursive: true, force: true });
});

describe("finalize_orphaned_compression_sessions", () => {
  it("marks ghost continuation with compression parent", () => {
    db.create_session("parent", "tui", { model: "test" });
    db.end_session("parent", "compression");
    db.create_session("ghost-cont", "tui", { model: "test", parent_session_id: "parent" });
    db.append_message("ghost-cont", "user", { content: "hello" });
    db.append_message("ghost-cont", "assistant", { content: "hi" });
    db._execute_write((conn) => {
      conn
        .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
        .run(Date.now() / 1000 - 800000, "ghost-cont");
    });
    expect(db.finalize_orphaned_compression_sessions()).toBe(1);
    const session = db.get_session("ghost-cont");
    expect(session?.ended_at).not.toBeNull();
    expect(session?.end_reason).toBe("orphaned_compression");
  });

  it("skips session without parent", () => {
    db.create_session("ghost-notitle", "tui", { model: "test" });
    db.append_message("ghost-notitle", "user", { content: "test" });
    db._execute_write((conn) => {
      conn
        .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
        .run(Date.now() / 1000 - 800000, "ghost-notitle");
    });
    expect(db.finalize_orphaned_compression_sessions()).toBe(0);
  });

  it("skips recent sessions (< 7 days)", () => {
    db.create_session("some-parent", "tui", { model: "test" });
    db.create_session("recent", "tui", {
      model: "test",
      parent_session_id: "some-parent",
    });
    db.append_message("recent", "user", { content: "hello" });
    expect(db.finalize_orphaned_compression_sessions()).toBe(0);
  });

  it("skips sessions that already have end_reason", () => {
    db.create_session("parent", "tui", { model: "test" });
    db.end_session("parent", "compression");
    db.create_session("already-ended", "tui", {
      model: "test",
      parent_session_id: "parent",
    });
    db.append_message("already-ended", "user", { content: "hello" });
    db.end_session("already-ended", "user_exit");
    db._execute_write((conn) => {
      conn
        .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
        .run(Date.now() / 1000 - 800000, "already-ended");
    });
    expect(db.finalize_orphaned_compression_sessions()).toBe(0);
  });

  it("skips child with non-compression parent", () => {
    db.create_session("parent", "tui", { model: "test" });
    db.end_session("parent", "user_exit");
    db.create_session("child", "tui", { model: "test", parent_session_id: "parent" });
    db.append_message("child", "user", { content: "hello" });
    db._execute_write((conn) => {
      conn
        .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
        .run(Date.now() / 1000 - 800000, "child");
    });
    expect(db.finalize_orphaned_compression_sessions()).toBe(0);
  });

  it("skips sessions without messages", () => {
    db.create_session("parent", "tui", { model: "test" });
    db.end_session("parent", "compression");
    db.create_session("empty-ghost", "tui", {
      model: "test",
      parent_session_id: "parent",
    });
    db._execute_write((conn) => {
      conn
        .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
        .run(Date.now() / 1000 - 800000, "empty-ghost");
    });
    expect(db.finalize_orphaned_compression_sessions()).toBe(0);
  });

  it("titled ghost with compression parent is caught", () => {
    db.create_session("parent", "tui", { model: "test" });
    db.set_session_title("parent", "Chat");
    db.end_session("parent", "compression");
    db.create_session("titled-ghost", "tui", {
      model: "test",
      parent_session_id: "parent",
    });
    db.set_session_title("titled-ghost", "Chat (2)");
    db.append_message("titled-ghost", "user", { content: "continued..." });
    db._execute_write((conn) => {
      conn
        .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
        .run(Date.now() / 1000 - 800000, "titled-ghost");
    });
    expect(db.finalize_orphaned_compression_sessions()).toBe(1);
    expect(db.get_session("titled-ghost")?.end_reason).toBe("orphaned_compression");
  });
});
