// Targeted coverage for optional-default branches and short-circuit
// expressions that natural session-db.test.ts flows don't exercise.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionDB } from "../src/index.js";

let _tmpRoot: string;
let db: SessionDB;

beforeEach(() => {
  _tmpRoot = mkdtempSync(join(tmpdir(), "hermests-br-"));
  db = new SessionDB(join(_tmpRoot, "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(_tmpRoot, { recursive: true, force: true });
});

// =========================================================================
// Constructor option overloads (lines 314-315)
// =========================================================================

describe("ctor option overloads", () => {
  it("accepts options object with db_path", () => {
    const p = join(_tmpRoot, "obj.db");
    const x = new SessionDB({ db_path: p });
    try {
      expect(x.db_path).toBe(p);
    } finally {
      x.close();
    }
  });

  it("accepts options object without db_path (uses default)", () => {
    // We don't want to write to the real default location. Override HOME.
    const origHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = _tmpRoot;
    try {
      const x = new SessionDB({});
      try {
        expect(x.db_path).toContain("state.db");
      } finally {
        x.close();
      }
    } finally {
      if (origHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = origHome;
    }
  });

  it("accepts options object with sanitizeContext callback", () => {
    const p = join(_tmpRoot, "san.db");
    const calls: string[] = [];
    const x = new SessionDB({
      db_path: p,
      sanitizeContext: (s) => {
        calls.push(s);
        return s.toUpperCase();
      },
    });
    try {
      x.create_session("s1", "cli");
      x.append_message("s1", "user", { content: "hello" });
      const msgs = x.get_messages_as_conversation("s1");
      expect(msgs.some((m) => m.content === "HELLO")).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      x.close();
    }
  });

  it("accepts no argument (uses default db_path + default sanitize)", () => {
    const origHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = _tmpRoot;
    try {
      const x = new SessionDB();
      try {
        expect(x.db_path).toContain("state.db");
      } finally {
        x.close();
      }
    } finally {
      if (origHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = origHome;
    }
  });
});

// =========================================================================
// create_session optional defaults — covers ?? branches in _insertSessionRow
// =========================================================================

describe("create_session: optional field defaults", () => {
  it("all optional fields default to null when omitted", () => {
    db.create_session("s-empty", "cli");
    const row = db.get_session("s-empty");
    expect(row?.user_id).toBeNull();
    expect(row?.model).toBeNull();
    expect(row?.model_config).toBeNull();
    expect(row?.system_prompt).toBeNull();
    expect(row?.parent_session_id).toBeNull();
  });

  it("model_config object is JSON-stringified", () => {
    db.create_session("s-mc", "cli", { model_config: { temp: 0.5 } });
    const row = db.get_session("s-mc");
    expect(typeof row?.model_config).toBe("string");
    expect(JSON.parse(row?.model_config as string)).toEqual({ temp: 0.5 });
  });

  it("all optional fields populated round-trip", () => {
    db.create_session("parent", "cli");
    db.create_session("s-full", "cli", {
      user_id: "u1",
      model: "claude-3",
      model_config: { temp: 0.7 },
      system_prompt: "you are helpful",
      parent_session_id: "parent",
    });
    const row = db.get_session("s-full");
    expect(row?.user_id).toBe("u1");
    expect(row?.model).toBe("claude-3");
    expect(row?.system_prompt).toBe("you are helpful");
    expect(row?.parent_session_id).toBe("parent");
  });
});

// =========================================================================
// list_sessions_rich + get_session_rich preview edge cases (L1112, 1191, 1195)
// =========================================================================

describe("preview rendering edge cases", () => {
  it("list_sessions_rich short message renders without ellipsis", () => {
    db.create_session("s", "cli");
    db.append_message("s", "user", { content: "short" });
    const rows = db.list_sessions_rich();
    expect(rows[0]?.preview).toBe("short");
  });

  it("list_sessions_rich session with no messages renders empty preview", () => {
    db.create_session("empty", "cli");
    const rows = db.list_sessions_rich();
    const r = rows.find((x) => x.id === "empty");
    expect(r?.preview).toBe("");
  });

  it("_getSessionRichRow paths via tip-projection (short, long, empty previews)", () => {
    // _getSessionRichRow is private but called from list_sessions_rich during
    // compression-tip projection. Build a parent + compression child with
    // varying message content lengths to traverse all preview branches.
    const ts = Math.floor(Date.now() / 1000);

    // Session 1: short preview
    db.create_session("p1", "cli");
    db.append_message("p1", "user", { content: "short msg" });
    db._conn
      .prepare("UPDATE sessions SET ended_at = ?, end_reason = 'compression' WHERE id = ?")
      .run(ts, "p1");
    db.create_session("t1", "cli", { parent_session_id: "p1" });
    db.append_message("t1", "user", { content: "tip short" });
    db._conn
      .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run(ts + 1, "t1");

    // Session 2: long preview (>60 chars → ellipsis branch)
    db.create_session("p2", "cli");
    db.append_message("p2", "user", { content: "p2 short" });
    db._conn
      .prepare("UPDATE sessions SET ended_at = ?, end_reason = 'compression', started_at = ? WHERE id = ?")
      .run(ts + 2, ts + 2, "p2");
    db.create_session("t2", "cli", { parent_session_id: "p2" });
    db.append_message("t2", "user", { content: "C".repeat(100) });
    db._conn
      .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run(ts + 3, "t2");

    // Session 3: tip has no user messages (empty preview branch).
    db.create_session("p3", "cli");
    db.append_message("p3", "user", { content: "p3 short" });
    db._conn
      .prepare("UPDATE sessions SET ended_at = ?, end_reason = 'compression', started_at = ? WHERE id = ?")
      .run(ts + 4, ts + 4, "p3");
    db.create_session("t3", "cli", { parent_session_id: "p3" });
    db._conn
      .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run(ts + 5, "t3");

    const rows = db.list_sessions_rich({});
    // After tip-projection, parents p1/p2/p3 are merged with their tips.
    // The projected row's `id` field becomes the tip's id; the parent's
    // original id moves to `_lineage_root_id`.
    const p1Proj = rows.find(
      (r) => (r as unknown as Record<string, unknown>)._lineage_root_id === "p1",
    );
    const p2Proj = rows.find(
      (r) => (r as unknown as Record<string, unknown>)._lineage_root_id === "p2",
    );
    const p3Proj = rows.find(
      (r) => (r as unknown as Record<string, unknown>)._lineage_root_id === "p3",
    );
    expect(p1Proj?.preview).toBe("tip short");
    expect(p2Proj?.preview.length).toBe(63);
    expect(p2Proj?.preview.endsWith("...")).toBe(true);
    // p3 tip has no user message → tip preview is empty string.
    expect(p3Proj?.preview).toBe("");
  });
});

// =========================================================================
// _isDuplicateReplayedUserMessage assistant short-circuit (L1678-1679)
// =========================================================================

describe("_isDuplicateReplayedUserMessage: assistant short-circuit", () => {
  it("returns false when the previous assistant message has tool_calls (no content)", () => {
    const messages = [
      { role: "user", content: "ping" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1" }] },
    ];
    expect(
      SessionDB._isDuplicateReplayedUserMessage(messages as never, {
        role: "user",
        content: "ping",
      }),
    ).toBe(false);
  });

  it("returns false when the previous assistant message has content only", () => {
    const messages = [
      { role: "user", content: "ping" },
      { role: "assistant", content: "pong" },
    ];
    expect(
      SessionDB._isDuplicateReplayedUserMessage(messages as never, {
        role: "user",
        content: "ping",
      }),
    ).toBe(false);
  });

  it("returns true on duplicate user message with no intervening assistant", () => {
    const messages = [{ role: "user", content: "ping" }];
    expect(
      SessionDB._isDuplicateReplayedUserMessage(messages as never, {
        role: "user",
        content: "ping",
      }),
    ).toBe(true);
  });

  it("returns false when checked message is not a user role", () => {
    expect(
      SessionDB._isDuplicateReplayedUserMessage([] as never, {
        role: "assistant",
        content: "x",
      }),
    ).toBe(false);
  });

  it("returns false when content is non-string", () => {
    expect(
      SessionDB._isDuplicateReplayedUserMessage([] as never, {
        role: "user",
        content: [{ type: "text", text: "x" }] as never,
      }),
    ).toBe(false);
  });
});

// =========================================================================
// replace_messages with missing role (L1318 default "unknown")
// =========================================================================

describe("replace_messages: optional fields with defaults", () => {
  it("default role becomes 'unknown' when message has no role", () => {
    db.create_session("rep", "cli");
    db.replace_messages("rep", [
      // Intentionally omit role to hit `msg.role ?? "unknown"` default.
      { content: "no role" } as never,
    ]);
    const rows = db._conn
      .prepare("SELECT role FROM messages WHERE session_id = ?")
      .all<{ role: string }>("rep");
    expect(rows[0]?.role).toBe("unknown");
  });
});

// =========================================================================
// get_messages_as_conversation: tool_call_id / tool_name / tool_calls
// preservation branches (L1592-1594)
// =========================================================================

describe("get_messages_as_conversation: optional tool fields", () => {
  it("preserves tool_call_id, tool_name, tool_calls when present", () => {
    db.create_session("tc", "cli");
    db.append_message("tc", "tool", {
      content: "result",
      tool_call_id: "call-1",
      tool_name: "do_thing",
    });
    db.append_message("tc", "assistant", {
      content: "ok",
      tool_calls: [{ id: "call-1", function: { name: "do_thing", arguments: "{}" } }],
    });
    const msgs = db.get_messages_as_conversation("tc");
    const tool = msgs.find((m) => m.role === "tool");
    expect(tool?.tool_call_id).toBe("call-1");
    expect(tool?.tool_name).toBe("do_thing");
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls).toBeTruthy();
  });

  it("omits tool fields when absent (covers the false-branch of `if (row.tool_X)`)", () => {
    db.create_session("notc", "cli");
    db.append_message("notc", "user", { content: "hi" });
    const msgs = db.get_messages_as_conversation("notc");
    const user = msgs.find((m) => m.role === "user");
    expect(user?.tool_call_id).toBeUndefined();
    expect(user?.tool_name).toBeUndefined();
    expect(user?.tool_calls).toBeUndefined();
  });
});

// =========================================================================
// _sessionLineageRootToTip: empty chain fallback (L1665) and dangling
// parent_session_id (L1673)
// =========================================================================

describe("_sessionLineageRootToTip: empty sessionId", () => {
  it("returns [sessionId] when sessionId is empty string", () => {
    db.create_session("s", "cli");
    db.append_message("s", "user", { content: "x" });
    // include_ancestors with empty id exercises the !sessionId guard.
    expect(db.get_messages_as_conversation("", { include_ancestors: true })).toEqual([]);
  });

  it("walk breaks when a parent_session_id points to a deleted ancestor", () => {
    // Build child with parent that does not exist (FK off temporarily).
    db._conn.exec("PRAGMA foreign_keys = OFF");
    try {
      db.create_session("orphan", "cli", { parent_session_id: "ghost-parent" });
      db.append_message("orphan", "user", { content: "msg" });
      // include_ancestors triggers _sessionLineageRootToTip("orphan") which
      // first walks ROOT->TIP: the SELECT parent_session_id query returns
      // {parent_session_id: "ghost-parent"}, current = "ghost-parent"; next
      // iteration the SELECT returns undefined → break (L1673).
      const msgs = db.get_messages_as_conversation("orphan", {
        include_ancestors: true,
      });
      expect(msgs.length).toBeGreaterThan(0);
    } finally {
      db._conn.exec("PRAGMA foreign_keys = ON");
    }
  });
});

// =========================================================================
// Telegram-related defaults (L2156, 2246, 2355, 2374, 2401)
// =========================================================================

describe("telegram defaults", () => {
  it("get_telegram_topic_binding returns null for unknown chat/thread", () => {
    db.apply_telegram_topic_migration();
    expect(
      db.get_telegram_topic_binding({ chat_id: "x", thread_id: "y" }),
    ).toBeNull();
  });

  it("get_telegram_topic_binding_by_session returns null when no binding", () => {
    db.apply_telegram_topic_migration();
    db.create_session("s", "telegram");
    expect(db.get_telegram_topic_binding_by_session({ session_id: "s" })).toBeNull();
  });

  it("is_telegram_topic_mode_enabled returns false for unknown chat", () => {
    db.apply_telegram_topic_migration();
    expect(db.is_telegram_topic_mode_enabled({ chat_id: "nope", user_id: "u" })).toBe(false);
  });

  it("get_telegram_topic_binding swallows underlying DB errors", () => {
    db.apply_telegram_topic_migration();
    const orig = db._conn.prepare.bind(db._conn);
    db._conn.prepare = ((sql: string) => {
      if (sql.includes("FROM telegram_dm_topic_bindings")) {
        throw new Error("simulated");
      }
      return orig(sql);
    }) as typeof db._conn.prepare;
    try {
      expect(db.get_telegram_topic_binding({ chat_id: "x", thread_id: "y" })).toBeNull();
      expect(db.get_telegram_topic_binding_by_session({ session_id: "x" })).toBeNull();
    } finally {
      db._conn.prepare = orig;
    }
  });
});

// =========================================================================
// list_unlinked_telegram_sessions_for_user preview edge cases (L2538-2541)
// =========================================================================

describe("list_unlinked_telegram_sessions_for_user preview branches", () => {
  it("renders preview for short / long / empty user-message content", () => {
    db.apply_telegram_topic_migration();
    // Three unlinked telegram sessions for the same user with varying
    // first-user-message content to traverse the empty / short / long
    // preview branches.
    db.create_session("u-empty", "telegram", { user_id: "u1" });
    db.create_session("u-short", "telegram", { user_id: "u1" });
    db.append_message("u-short", "user", { content: "shorty" });
    db.create_session("u-long", "telegram", { user_id: "u1" });
    db.append_message("u-long", "user", { content: "D".repeat(100) });

    const rows = db.list_unlinked_telegram_sessions_for_user({
      chat_id: "208214988",
      user_id: "u1",
    });
    const empty = rows.find((r) => r.id === "u-empty");
    const short = rows.find((r) => r.id === "u-short");
    const long = rows.find((r) => r.id === "u-long");
    expect(empty?.preview).toBe("");
    expect(short?.preview).toBe("shorty");
    expect((long?.preview as string).length).toBe(63);
    expect((long?.preview as string).endsWith("...")).toBe(true);
  });
});
