// Ported from tests/hermes_state/test_get_messages_around.py.
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionDB } from "../src/index.js";

let _tmpRoot: string;
let db: SessionDB;

beforeEach(() => {
  _tmpRoot = mkdtempSync(join(tmpdir(), "hermests-mra-"));
  db = new SessionDB(join(_tmpRoot, "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(_tmpRoot, { recursive: true, force: true });
});

function seed(sid = "s1", n = 10): number[] {
  db.create_session(sid, "cli");
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    ids.push(db.append_message(sid, role, { content: `msg ${i}` }));
  }
  return ids;
}

describe("Basic window", () => {
  it("returns window around anchor", () => {
    const ids = seed("s1", 10);
    const anchor = ids[5]!;
    const view = db.get_messages_around("s1", anchor, { window: 2 });
    expect(view.window.length).toBe(5);
    expect(view.window.map((m) => m.id)).toEqual([ids[3], ids[4], ids[5], ids[6], ids[7]]);
    expect(view.messages_before).toBe(2);
    expect(view.messages_after).toBe(2);
  });

  it("window=0 returns only anchor", () => {
    const ids = seed("s1", 5);
    const view = db.get_messages_around("s1", ids[2]!, { window: 0 });
    expect(view.window.length).toBe(1);
    expect(view.window[0]?.id).toBe(ids[2]);
    expect(view.messages_before).toBe(0);
    expect(view.messages_after).toBe(0);
  });

  it("negative window clamps to 0", () => {
    const ids = seed("s1", 5);
    const view = db.get_messages_around("s1", ids[2]!, { window: -3 });
    expect(view.window.length).toBe(1);
  });
});

describe("Boundary detection", () => {
  it("session start short before-count", () => {
    const ids = seed("s1", 10);
    const view = db.get_messages_around("s1", ids[0]!, { window: 5 });
    expect(view.messages_before).toBe(0);
    expect(view.messages_after).toBe(5);
    expect(view.window.length).toBe(6);
  });

  it("session end short after-count", () => {
    const ids = seed("s1", 10);
    const view = db.get_messages_around("s1", ids[ids.length - 1]!, { window: 5 });
    expect(view.messages_before).toBe(5);
    expect(view.messages_after).toBe(0);
    expect(view.window.length).toBe(6);
  });

  it("window larger than session returns all messages", () => {
    const ids = seed("s1", 3);
    const view = db.get_messages_around("s1", ids[1]!, { window: 50 });
    expect(view.window.length).toBe(3);
    expect(view.messages_before).toBe(1);
    expect(view.messages_after).toBe(1);
  });
});

describe("Anchor validation", () => {
  it("missing anchor returns empty view", () => {
    seed("s1", 5);
    const view = db.get_messages_around("s1", 99999, { window: 5 });
    expect(view.window).toEqual([]);
    expect(view.messages_before).toBe(0);
    expect(view.messages_after).toBe(0);
  });

  it("anchor in different session returns empty", () => {
    const ids1 = seed("s1", 5);
    seed("s2", 5);
    const view = db.get_messages_around("s2", ids1[2]!, { window: 2 });
    expect(view.window).toEqual([]);
  });
});

describe("Scroll pattern", () => {
  it("forward re-anchored on last id overlaps", () => {
    const ids = seed("s1", 20);
    const v1 = db.get_messages_around("s1", ids[5]!, { window: 3 });
    const lastId = v1.window[v1.window.length - 1]!.id;
    const v2 = db.get_messages_around("s1", lastId, { window: 3 });
    expect(v1.window.map((m) => m.id)).toContain(lastId);
    expect(v2.window.map((m) => m.id)).toContain(lastId);
    expect(Math.max(...v2.window.map((m) => m.id))).toBeGreaterThan(
      Math.max(...v1.window.map((m) => m.id)),
    );
  });

  it("backward re-anchored on first id overlaps", () => {
    const ids = seed("s1", 20);
    const v1 = db.get_messages_around("s1", ids[10]!, { window: 3 });
    const firstId = v1.window[0]!.id;
    const v2 = db.get_messages_around("s1", firstId, { window: 3 });
    expect(v1.window.map((m) => m.id)).toContain(firstId);
    expect(v2.window.map((m) => m.id)).toContain(firstId);
    expect(Math.min(...v2.window.map((m) => m.id))).toBeLessThan(
      Math.min(...v1.window.map((m) => m.id)),
    );
  });
});

describe("Content hydration", () => {
  it("content is decoded as a string", () => {
    const ids = seed("s1", 3);
    const view = db.get_messages_around("s1", ids[1]!, { window: 1 });
    for (const m of view.window) {
      expect(typeof m.content).toBe("string");
      expect((m.content as string).startsWith("msg ")).toBe(true);
    }
  });

  it("tool_calls is hydrated to a list", () => {
    db.create_session("s1", "cli");
    const tc = [{ id: "t1", function: { name: "x", arguments: "{}" } }];
    db.append_message("s1", "assistant", { content: "", tool_calls: tc });
    const mid = db.append_message("s1", "tool", { content: "result", tool_name: "x" });
    const view = db.get_messages_around("s1", mid, { window: 2 });
    const asst = view.window.find((m) => m.role === "assistant")!;
    expect(Array.isArray(asst.tool_calls)).toBe(true);
  });
});
