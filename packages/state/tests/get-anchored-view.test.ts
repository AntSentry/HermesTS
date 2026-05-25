// Ported from tests/hermes_state/test_get_anchored_view.py.
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionDB } from "../src/index.js";

let _tmpRoot: string;
let db: SessionDB;

beforeEach(() => {
  _tmpRoot = mkdtempSync(join(tmpdir(), "hermests-av-"));
  db = new SessionDB(join(_tmpRoot, "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(_tmpRoot, { recursive: true, force: true });
});

function seedLong(sid = "s1", n = 30): number[] {
  db.create_session(sid, "cli");
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    ids.push(db.append_message(sid, role, { content: `prose msg ${i}` }));
  }
  return ids;
}

describe("Window + bookend shape", () => {
  it("returns window with bookend_start and bookend_end", () => {
    const ids = seedLong("s1", 30);
    const anchor = ids[15]!;
    const view = db.get_anchored_view("s1", anchor, { window: 3, bookend: 3 });
    expect(view.window.length).toBe(7);
    expect(view.bookend_start.length).toBe(3);
    expect(view.bookend_end.length).toBe(3);
    expect(view.bookend_start.map((m) => m.id)).toEqual(ids.slice(0, 3));
    expect(view.bookend_end.map((m) => m.id)).toEqual(ids.slice(-3));
  });

  it("anchor preserved in window", () => {
    const ids = seedLong("s1", 20);
    const anchor = ids[10]!;
    const view = db.get_anchored_view("s1", anchor, { window: 2, bookend: 3 });
    expect(view.window.filter((m) => m.id === anchor).length).toBe(1);
  });
});

describe("Bookend overlap rules", () => {
  it("bookend_start empty when window covers session head", () => {
    const ids = seedLong("s1", 10);
    const anchor = ids[1]!;
    const view = db.get_anchored_view("s1", anchor, { window: 3, bookend: 3 });
    expect(view.bookend_start).toEqual([]);
    expect(view.bookend_end.length).toBeGreaterThan(0);
  });

  it("bookend_end empty when window covers tail", () => {
    const ids = seedLong("s1", 10);
    const anchor = ids[ids.length - 2]!;
    const view = db.get_anchored_view("s1", anchor, { window: 3, bookend: 3 });
    expect(view.bookend_end).toEqual([]);
    expect(view.bookend_start.length).toBeGreaterThan(0);
  });

  it("short session both bookends empty", () => {
    const ids = seedLong("s1", 5);
    const view = db.get_anchored_view("s1", ids[2]!, { window: 10, bookend: 3 });
    expect(view.bookend_start).toEqual([]);
    expect(view.bookend_end).toEqual([]);
    expect(view.window.length).toBe(5);
  });
});

describe("Role filtering", () => {
  it("tool role filtered from window by default", () => {
    db.create_session("s1", "cli");
    const userIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      userIds.push(db.append_message("s1", "user", { content: `u${i}` }));
      db.append_message("s1", "tool", { content: `tool ${i}`, tool_name: "x" });
    }
    const view = db.get_anchored_view("s1", userIds[2]!, { window: 5, bookend: 0 });
    expect(view.window.some((m) => m.role === "tool")).toBe(false);
  });

  it("anchor preserved even when its role is filtered", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "ask" });
    const toolId = db.append_message("s1", "tool", { content: "tool output", tool_name: "x" });
    db.append_message("s1", "user", { content: "follow-up" });
    const view = db.get_anchored_view("s1", toolId, { window: 5, bookend: 0 });
    expect(view.window.map((m) => m.id)).toContain(toolId);
  });

  it("keep_roles=null disables filter", () => {
    db.create_session("s1", "cli");
    const aid = db.append_message("s1", "user", { content: "ask" });
    db.append_message("s1", "tool", { content: "output", tool_name: "x" });
    const view = db.get_anchored_view("s1", aid, { window: 5, bookend: 0, keep_roles: null });
    expect(view.window.some((m) => m.role === "tool")).toBe(true);
  });
});

describe("Empty content filter on bookends", () => {
  it("empty content messages excluded from bookends", () => {
    db.create_session("s1", "cli");
    const opener = db.append_message("s1", "user", { content: "Let's start the work" });
    db.append_message("s1", "assistant", {
      content: "",
      tool_calls: [{ id: "t1", function: { name: "x", arguments: "{}" } }],
    });
    for (let i = 0; i < 20; i++) {
      db.append_message("s1", i % 2 === 0 ? "user" : "assistant", { content: `prose ${i}` });
    }
    db.append_message("s1", "assistant", {
      content: "",
      tool_calls: [{ id: "t2", function: { name: "y", arguments: "{}" } }],
    });
    const closer = db.append_message("s1", "assistant", {
      content: "Final decision: ship it.",
    });
    const view = db.get_anchored_view("s1", opener + 15, { window: 2, bookend: 3 });
    for (const m of view.bookend_start) {
      expect((m.content as string | null) || "").not.toBe("");
    }
    const endContents = view.bookend_end.map((m) => (m.content as string | null) ?? "");
    expect(endContents.some((c) => c.includes("Final decision"))).toBe(true);
    void closer;
  });
});

describe("Anchor validation", () => {
  it("missing anchor returns empty view", () => {
    seedLong("s1", 10);
    const view = db.get_anchored_view("s1", 999999, { window: 5, bookend: 3 });
    expect(view.window).toEqual([]);
    expect(view.bookend_start).toEqual([]);
    expect(view.bookend_end).toEqual([]);
    expect(view.messages_before).toBe(0);
    expect(view.messages_after).toBe(0);
  });
});

describe("Session isolation", () => {
  it("bookends do not cross session boundaries", () => {
    const ids1 = seedLong("s1", 20);
    seedLong("s2", 20);
    const view = db.get_anchored_view("s1", ids1[10]!, { window: 2, bookend: 3 });
    for (const m of [...view.bookend_start, ...view.bookend_end]) {
      expect(m.session_id).toBe("s1");
    }
  });
});

describe("Negative bookend clamps", () => {
  it("bookend < 0 clamps to 0", () => {
    const ids = seedLong("s1", 10);
    const view = db.get_anchored_view("s1", ids[5]!, { window: 1, bookend: -2 });
    expect(view.bookend_start).toEqual([]);
    expect(view.bookend_end).toEqual([]);
  });
});
