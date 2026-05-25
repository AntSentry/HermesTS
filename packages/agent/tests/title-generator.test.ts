/**
 * Tests for `@hermests/agent/title-generator`.
 *
 * Ports upstream `tests/agent/test_title_generator.py` 1:1, adapted
 * for the TS extension-registry seam.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  _setSchedulerForTests,
  autoTitleSession,
  generateTitle,
  maybeAutoTitle,
  resetExtensions,
  setAuxiliaryLlmHooks,
  type AuxiliaryLlmResponse,
  type SessionDb,
} from "../src/index.js";

beforeEach(() => {
  resetExtensions();
  _setSchedulerForTests(null);
});

afterEach(() => {
  resetExtensions();
  _setSchedulerForTests(null);
});

function installLlm(content: string | null): { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  setAuxiliaryLlmHooks({
    callLlm: (options): AuxiliaryLlmResponse => {
      calls.push(options as unknown as Record<string, unknown>);
      return { choices: [{ message: { content } }] };
    },
  });
  return { calls };
}

function installLlmError(err: Error): void {
  setAuxiliaryLlmHooks({
    callLlm: () => {
      throw err;
    },
  });
}

describe("generateTitle", () => {
  test("returns title on success", () => {
    installLlm("Debugging Python Import Errors");
    const title = generateTitle("help me fix this import", "Sure, let me check…");
    expect(title).toBe("Debugging Python Import Errors");
  });

  test("strips wrapping quotes", () => {
    installLlm('"Setting Up Docker Environment"');
    expect(generateTitle("q", "a")).toBe("Setting Up Docker Environment");
  });

  test("strips 'Title:' prefix", () => {
    installLlm("Title: Kubernetes Pod Debugging");
    expect(generateTitle("q", "a")).toBe("Kubernetes Pod Debugging");
  });

  test("truncates long titles to 80 chars (77 + ellipsis)", () => {
    installLlm("A".repeat(100));
    const title = generateTitle("q", "a");
    expect(title?.length).toBe(80);
    expect(title?.endsWith("...")).toBe(true);
  });

  test("returns null on empty content", () => {
    installLlm("");
    expect(generateTitle("q", "a")).toBeNull();
  });

  test("returns null on null content", () => {
    installLlm(null);
    expect(generateTitle("q", "a")).toBeNull();
  });

  test("returns null when callLlm throws", () => {
    installLlmError(new Error("no provider"));
    expect(generateTitle("q", "a")).toBeNull();
  });

  test("returns null when no LLM hook is installed and fires the failure callback", () => {
    const captured: Array<[string, unknown]> = [];
    const cb = (task: string, exc: unknown): void => {
      captured.push([task, exc]);
    };
    const result = generateTitle("q", "a", { failureCallback: cb });
    expect(result).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0]![0]).toBe("title generation");
    expect((captured[0]![1] as Error).message).toBe("auxiliary LLM not configured");
  });

  test("invokes failure_callback on exception", () => {
    const captured: Array<[string, unknown]> = [];
    const cb = (task: string, exc: unknown): void => {
      captured.push([task, exc]);
    };
    const exc = new Error("openrouter 402: credits exhausted");
    installLlmError(exc);
    const result = generateTitle("q", "a", { failureCallback: cb });
    expect(result).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0]![0]).toBe("title generation");
    expect(captured[0]![1]).toBe(exc);
  });

  test("a broken failure_callback does not crash generation", () => {
    installLlmError(new Error("nope"));
    const cb = (): void => {
      throw new Error("callback bug");
    };
    expect(generateTitle("q", "a", { failureCallback: cb })).toBeNull();
  });

  test("missing failure_callback matches legacy silent-null behavior", () => {
    installLlmError(new Error("nope"));
    expect(generateTitle("q", "a")).toBeNull();
  });

  test("a broken failure_callback in the no-hook path does not crash", () => {
    const cb = (): void => {
      throw new Error("callback bug");
    };
    expect(generateTitle("q", "a", { failureCallback: cb })).toBeNull();
  });

  test("truncates long user/assistant messages to 500 chars each", () => {
    const { calls } = installLlm("Short Title");
    generateTitle("x".repeat(1000), "y".repeat(1000));
    const userContent = String(
      (calls[0]?.["messages"] as Array<{ role: string; content: string }>)[1]?.content ?? "",
    );
    // Expected: "User: " + 500x + "\n\nAssistant: " + 500y = 1018 chars (< 1100).
    expect(userContent.length).toBeLessThan(1100);
    expect(userContent.length).toBeGreaterThan(900);
  });

  test("passes through main_runtime when provided", () => {
    const { calls } = installLlm("Hello");
    const main = { provider: "openrouter" };
    generateTitle("q", "a", { mainRuntime: main });
    expect(calls[0]?.["main_runtime"]).toBe(main);
  });

  test("empty user/assistant messages render as empty snippets", () => {
    const { calls } = installLlm("Title");
    generateTitle("", "");
    const userContent = String(
      (calls[0]?.["messages"] as Array<{ role: string; content: string }>)[1]?.content ?? "",
    );
    expect(userContent).toBe("User: \n\nAssistant: ");
  });
});

describe("autoTitleSession", () => {
  function fakeDb(initialTitle: string | null = null): SessionDb & {
    titles: Map<string, string>;
    setCalls: Array<[string, string]>;
  } {
    const titles = new Map<string, string>();
    if (initialTitle) titles.set("sess-1", initialTitle);
    const setCalls: Array<[string, string]> = [];
    return {
      titles,
      setCalls,
      get_session_title(id: string) {
        return titles.get(id) ?? null;
      },
      set_session_title(id: string, title: string) {
        titles.set(id, title);
        setCalls.push([id, title]);
      },
    };
  }

  test("skips when sessionDb is null", () => {
    expect(() => autoTitleSession(null, "sess", "hi", "hello")).not.toThrow();
  });

  test("skips when sessionId is empty", () => {
    const db = fakeDb();
    autoTitleSession(db, "", "hi", "hello");
    expect(db.setCalls).toHaveLength(0);
  });

  test("skips when title already exists", () => {
    const db = fakeDb("Existing Title");
    installLlm("New Title");
    autoTitleSession(db, "sess-1", "hi", "hello");
    expect(db.setCalls).toHaveLength(0);
  });

  test("generates and sets the title", () => {
    const db = fakeDb();
    installLlm("New Title");
    autoTitleSession(db, "sess-1", "hi", "hello");
    expect(db.setCalls).toEqual([["sess-1", "New Title"]]);
  });

  test("invokes title_callback after setting the title", () => {
    const db = fakeDb();
    installLlm("Readable Session");
    const seen: string[] = [];
    autoTitleSession(db, "sess-1", "hi", "hello", { titleCallback: seen.push.bind(seen) });
    expect(db.setCalls).toEqual([["sess-1", "Readable Session"]]);
    expect(seen).toEqual(["Readable Session"]);
  });

  test("title_callback errors are swallowed", () => {
    const db = fakeDb();
    installLlm("Title");
    autoTitleSession(db, "sess-1", "hi", "hello", {
      titleCallback: () => {
        throw new Error("cb fail");
      },
    });
    expect(db.setCalls).toEqual([["sess-1", "Title"]]);
  });

  test("skips when generation returns null", () => {
    const db = fakeDb();
    installLlm("");
    autoTitleSession(db, "sess-1", "hi", "hello");
    expect(db.setCalls).toHaveLength(0);
  });

  test("returns silently when get_session_title throws", () => {
    const db: SessionDb = {
      get_session_title() {
        throw new Error("db down");
      },
      set_session_title: vi.fn(),
    };
    installLlm("Title");
    autoTitleSession(db, "sess-1", "hi", "hello");
    expect((db.set_session_title as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test("returns silently when set_session_title throws", () => {
    const db: SessionDb = {
      get_session_title: () => null,
      set_session_title: () => {
        throw new Error("io error");
      },
    };
    installLlm("Title");
    expect(() => autoTitleSession(db, "sess-1", "hi", "hello")).not.toThrow();
  });
});

describe("maybeAutoTitle", () => {
  test("skips when not first exchange (> 2 user messages)", () => {
    const db: SessionDb = { get_session_title: vi.fn(), set_session_title: vi.fn() };
    let invocations = 0;
    _setSchedulerForTests(() => {
      invocations += 1;
    });
    const history = [
      { role: "user", content: "first" },
      { role: "assistant", content: "response 1" },
      { role: "user", content: "second" },
      { role: "assistant", content: "response 2" },
      { role: "user", content: "third" },
      { role: "assistant", content: "response 3" },
    ];
    maybeAutoTitle(db, "sess-1", "third", "response 3", history);
    expect(invocations).toBe(0);
  });

  test("fires on first exchange — schedules background task", () => {
    const db: SessionDb = { get_session_title: () => null, set_session_title: vi.fn() };
    let invocations = 0;
    _setSchedulerForTests(() => {
      invocations += 1;
    });
    maybeAutoTitle(db, "sess-1", "hello", "hi there", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(invocations).toBe(1);
  });

  test("forwards failure_callback and main_runtime to the worker", () => {
    const captured: Array<{ task: string; err: unknown }> = [];
    const db: SessionDb = { get_session_title: () => null, set_session_title: vi.fn() };

    // Force the LLM to throw so the failure callback fires.
    installLlmError(new Error("router 402"));

    // Run the scheduled callback synchronously to drive the test forward.
    _setSchedulerForTests((fn) => fn());

    maybeAutoTitle(db, "sess-1", "hello", "hi", [{ role: "user", content: "hello" }], {
      failureCallback: (task, err) => captured.push({ task, err }),
      mainRuntime: { x: 1 },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.task).toBe("title generation");
  });

  test("skips when assistant response is empty", () => {
    const db: SessionDb = { get_session_title: vi.fn(), set_session_title: vi.fn() };
    let invocations = 0;
    _setSchedulerForTests(() => {
      invocations += 1;
    });
    maybeAutoTitle(db, "sess-1", "hello", "", []);
    expect(invocations).toBe(0);
  });

  test("skips when sessionDb is null", () => {
    let invocations = 0;
    _setSchedulerForTests(() => {
      invocations += 1;
    });
    maybeAutoTitle(null, "sess-1", "hello", "response", []);
    expect(invocations).toBe(0);
  });

  test("skips when user message is empty", () => {
    const db: SessionDb = { get_session_title: vi.fn(), set_session_title: vi.fn() };
    let invocations = 0;
    _setSchedulerForTests(() => {
      invocations += 1;
    });
    maybeAutoTitle(db, "sess-1", "", "response", []);
    expect(invocations).toBe(0);
  });

  test("skips when sessionId is empty", () => {
    const db: SessionDb = { get_session_title: vi.fn(), set_session_title: vi.fn() };
    let invocations = 0;
    _setSchedulerForTests(() => {
      invocations += 1;
    });
    maybeAutoTitle(db, "", "hello", "response", []);
    expect(invocations).toBe(0);
  });

  test("default scheduler runs the task on the microtask queue", async () => {
    const db: SessionDb & { invoked: boolean } = {
      invoked: false,
      get_session_title() {
        this.invoked = true;
        return null;
      },
      set_session_title() {
        // ignore — generation returns null with no LLM installed
      },
    };
    maybeAutoTitle(db, "sess-1", "hello", "hi", [{ role: "user", content: "hello" }]);
    // Flush microtasks
    await Promise.resolve();
    expect(db.invoked).toBe(true);
  });

  test("history entry without an object form is ignored", () => {
    const db: SessionDb = { get_session_title: vi.fn(), set_session_title: vi.fn() };
    let invocations = 0;
    _setSchedulerForTests(() => {
      invocations += 1;
    });
    maybeAutoTitle(db, "sess-1", "hello", "hi", [
      null as unknown as Record<string, unknown>,
      { role: "user", content: "hello" },
    ]);
    expect(invocations).toBe(1);
  });

  test("null conversationHistory falls back to []", () => {
    const db: SessionDb = { get_session_title: vi.fn(), set_session_title: vi.fn() };
    let invocations = 0;
    _setSchedulerForTests(() => {
      invocations += 1;
    });
    maybeAutoTitle(
      db,
      "sess-1",
      "hello",
      "hi",
      null as unknown as Array<Record<string, unknown>>,
    );
    expect(invocations).toBe(1);
  });
});
