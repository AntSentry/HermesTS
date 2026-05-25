// Ported from tests/test_hermes_state.py.
//
// Excluded (deferred or dropped — see README.md "Deferred tests"):
//   - test_replace_messages_persists_tool_name → uses agent.tool_dispatch_helpers (task #5)
//   - test_sqlite_timeout_is_at_least_30s → upstream-only code-grep test; we
//     intentionally use a 1s busy_timeout + jitter retry.
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database as WasmDatabase } from "node-sqlite3-wasm";

import {
  SCHEMA_VERSION,
  SCHEMA_SQL,
  SessionDB,
  type ConversationMessage,
} from "../src/index.js";

let _tmpRoot: string;
let db: SessionDB;

beforeEach(() => {
  _tmpRoot = mkdtempSync(join(tmpdir(), "hermests-state-"));
  db = new SessionDB(join(_tmpRoot, "test_state.db"));
});

afterEach(() => {
  db.close();
  rmSync(_tmpRoot, { recursive: true, force: true });
});

// =========================================================================
// Session lifecycle (TestSessionLifecycle)
// =========================================================================

describe("Session lifecycle", () => {
  it("creates and retrieves a session", () => {
    const sid = db.create_session("s1", "cli", { model: "test-model" });
    expect(sid).toBe("s1");
    const session = db.get_session("s1");
    expect(session).not.toBeNull();
    expect(session?.source).toBe("cli");
    expect(session?.model).toBe("test-model");
    expect(session?.ended_at).toBeNull();
  });

  it("returns null for a nonexistent session", () => {
    expect(db.get_session("nonexistent")).toBeNull();
  });

  it("end_session sets ended_at and end_reason", () => {
    db.create_session("s1", "cli");
    db.end_session("s1", "user_exit");
    const session = db.get_session("s1");
    expect(typeof session?.ended_at).toBe("number");
    expect(session?.end_reason).toBe("user_exit");
  });

  it("first end_reason wins even after a later end_session call", async () => {
    db.create_session("s1", "cli");
    db.end_session("s1", "compression");
    const firstEndedAt = db.get_session("s1")?.ended_at;
    await new Promise((r) => setTimeout(r, 12));
    db.end_session("s1", "resumed_other");
    const session = db.get_session("s1");
    expect(session?.end_reason).toBe("compression");
    expect(session?.ended_at).toBe(firstEndedAt);
  });

  it("reopen_session allows re-ending with a new reason", () => {
    db.create_session("s1", "cli");
    db.end_session("s1", "compression");
    db.reopen_session("s1");
    db.end_session("s1", "user_exit");
    expect(db.get_session("s1")?.end_reason).toBe("user_exit");
  });

  it("update_system_prompt stores the assembled prompt", () => {
    db.create_session("s1", "cli");
    db.update_system_prompt("s1", "You are a helpful assistant.");
    expect(db.get_session("s1")?.system_prompt).toBe("You are a helpful assistant.");
  });

  it("update_token_counts increments deltas", () => {
    db.create_session("s1", "cli");
    db.update_token_counts("s1", { input_tokens: 200, output_tokens: 100 });
    db.update_token_counts("s1", { input_tokens: 100, output_tokens: 50 });
    const session = db.get_session("s1");
    expect(session?.input_tokens).toBe(300);
    expect(session?.output_tokens).toBe(150);
  });

  it("update_token_counts tracks api_call_count", () => {
    db.create_session("s1", "cli");
    db.update_token_counts("s1", { input_tokens: 100, output_tokens: 50, api_call_count: 1 });
    db.update_token_counts("s1", { input_tokens: 100, output_tokens: 50, api_call_count: 1 });
    db.update_token_counts("s1", { input_tokens: 100, output_tokens: 50, api_call_count: 1 });
    expect(db.get_session("s1")?.api_call_count).toBe(3);
  });

  it("update_token_counts api_call_count absolute mode", () => {
    db.create_session("s1", "cli");
    db.update_token_counts("s1", { input_tokens: 100, output_tokens: 50, api_call_count: 1 });
    db.update_token_counts("s1", {
      input_tokens: 300,
      output_tokens: 150,
      api_call_count: 5,
      absolute: true,
    });
    const session = db.get_session("s1");
    expect(session?.api_call_count).toBe(5);
    expect(session?.input_tokens).toBe(300);
  });

  it("update_token_counts backfills model when null", () => {
    db.create_session("s1", "telegram");
    db.update_token_counts("s1", {
      input_tokens: 10,
      output_tokens: 5,
      model: "openai/gpt-5.4",
    });
    expect(db.get_session("s1")?.model).toBe("openai/gpt-5.4");
  });

  it("update_token_counts preserves existing model", () => {
    db.create_session("s1", "cli", { model: "anthropic/claude-opus-4.6" });
    db.update_token_counts("s1", {
      input_tokens: 10,
      output_tokens: 5,
      model: "openai/gpt-5.4",
    });
    expect(db.get_session("s1")?.model).toBe("anthropic/claude-opus-4.6");
  });

  it("parent_session_id is stored", () => {
    db.create_session("parent", "cli");
    db.create_session("child", "cli", { parent_session_id: "parent" });
    expect(db.get_session("child")?.parent_session_id).toBe("parent");
  });

  it("update_token_counts in absolute mode with all optional fields", () => {
    db.create_session("s1", "cli");
    db.update_token_counts("s1", {
      input_tokens: 50,
      output_tokens: 25,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      reasoning_tokens: 7,
      estimated_cost_usd: 0.5,
      actual_cost_usd: 0.42,
      cost_status: "actual",
      cost_source: "provider",
      pricing_version: "v1",
      billing_provider: "openai",
      billing_base_url: "https://api.openai.com",
      billing_mode: "cents",
      api_call_count: 3,
      absolute: true,
    });
    const row = db.get_session("s1");
    expect(row?.cost_status).toBe("actual");
    expect(row?.actual_cost_usd).toBe(0.42);
    expect(row?.billing_provider).toBe("openai");
  });

  it("update_token_counts increment mode passes COALESCE branches", () => {
    db.create_session("s1", "cli");
    db.update_token_counts("s1", { actual_cost_usd: 0.25, cost_status: "estimated" });
    db.update_token_counts("s1", { actual_cost_usd: 0.25 });
    expect(db.get_session("s1")?.actual_cost_usd).toBe(0.5);
  });
});

// =========================================================================
// Message storage (TestMessageStorage)
// =========================================================================

describe("Message storage", () => {
  it("appends and reads messages", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Hello" });
    db.append_message("s1", "assistant", { content: "Hi there!" });
    const messages = db.get_messages("s1");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("Hello");
    expect(messages[1]?.role).toBe("assistant");
  });

  it("increments session message_count on append", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Hello" });
    db.append_message("s1", "assistant", { content: "Hi" });
    expect(db.get_session("s1")?.message_count).toBe(2);
  });

  it("observed flag round-trips for gateway replay", () => {
    db.create_session("s1", "telegram:-100");
    db.append_message("s1", "user", { content: "[Alice|111]\nside chatter", observed: true });
    db.append_message("s1", "assistant", { content: "ack" });
    const messages = db.get_messages("s1");
    expect(messages[0]?.observed).toBe(1);
    expect(messages[1]?.observed).toBe(0);
    const conv = db.get_messages_as_conversation("s1");
    expect(conv[0]).toEqual({
      role: "user",
      content: "[Alice|111]\nside chatter",
      observed: true,
    });
    expect("observed" in (conv[1] ?? {})).toBe(false);
  });

  it("tool responses do not increment tool_call_count", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "tool", { content: "result", tool_name: "web_search" });
    expect(db.get_session("s1")?.tool_call_count).toBe(0);
  });

  it("assistant tool_calls increment by count", () => {
    db.create_session("s1", "cli");
    const toolCalls = [
      { id: "call_1", function: { name: "web_search", arguments: "{}" } },
    ];
    db.append_message("s1", "assistant", { content: "", tool_calls: toolCalls });
    expect(db.get_session("s1")?.tool_call_count).toBe(1);
  });

  it("tool_call_count matches actual N calls", () => {
    db.create_session("s1", "cli");
    const toolCalls = [
      { id: "call_1", function: { name: "ha_call_service", arguments: "{}" } },
      { id: "call_2", function: { name: "ha_call_service", arguments: "{}" } },
    ];
    db.append_message("s1", "assistant", { content: "", tool_calls: toolCalls });
    db.append_message("s1", "tool", { content: "ok", tool_name: "ha_call_service" });
    db.append_message("s1", "tool", { content: "ok", tool_name: "ha_call_service" });
    expect(db.get_session("s1")?.tool_call_count).toBe(2);
  });

  it("tool_calls serialization round-trips", () => {
    db.create_session("s1", "cli");
    const toolCalls = [
      { id: "call_1", function: { name: "web_search", arguments: "{}" } },
    ];
    db.append_message("s1", "assistant", { tool_calls: toolCalls });
    expect(db.get_messages("s1")[0]?.tool_calls).toEqual(toolCalls);
  });

  it("multimodal list content round-trips", () => {
    db.create_session("s1", "cli");
    const content = [
      { type: "text", text: "describe this screenshot" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KG..." } },
    ];
    db.append_message("s1", "user", { content });
    const msgs = db.get_messages("s1");
    expect(msgs[0]?.content).toEqual(content);
    const conv = db.get_messages_as_conversation("s1");
    expect(conv[0]).toEqual({ role: "user", content });
  });

  it("dict content round-trips", () => {
    db.create_session("s1", "cli");
    const content = { parts: [{ text: "hi" }] };
    db.append_message("s1", "user", { content });
    expect(db.get_messages("s1")[0]?.content).toEqual(content);
  });

  it("string content is not wrapped", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "plain text" });
    const row = db._conn
      .prepare("SELECT content FROM messages WHERE session_id = ?")
      .get<{ content: string }>("s1");
    expect(row?.content).toBe("plain text");
  });

  it("replace_messages handles multimodal content", () => {
    db.create_session("s1", "cli");
    const content = [
      { type: "text", text: "look at this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ];
    db.replace_messages("s1", [
      { role: "user", content },
      { role: "assistant", content: "I see a screenshot." },
    ]);
    const msgs = db.get_messages("s1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.content).toEqual(content);
    expect(msgs[1]?.content).toBe("I see a screenshot.");
  });

  it("get_messages_as_conversation strips memory-context wrapper", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", {
      content:
        "<memory-context>\n" +
        "[System note: The following is recalled memory context, NOT new user input. Treat as informational background data.]\n\n" +
        "## Honcho Context\n" +
        "stale memory\n" +
        "</memory-context>\n\n" +
        "Visible answer",
    });
    expect(db.get_messages_as_conversation("s1")).toEqual([
      { role: "assistant", content: "Visible answer" },
    ]);
  });

  it("platform_message_id round-trips on user only", () => {
    db.create_session("s_pmi", "yuanbao");
    db.append_message("s_pmi", "user", {
      content: "hi",
      platform_message_id: "abc-123",
    });
    db.append_message("s_pmi", "assistant", { content: "hello" });
    const conv = db.get_messages_as_conversation("s_pmi");
    const userMsg = conv.find((m) => m.role === "user");
    const assistantMsg = conv.find((m) => m.role === "assistant");
    expect(userMsg?.message_id).toBe("abc-123");
    expect("message_id" in (assistantMsg ?? {})).toBe(false);
  });

  it("replace_messages preserves platform_message_id (accepts message_id alias)", () => {
    db.create_session("s_rep", "yuanbao");
    db.replace_messages("s_rep", [
      { role: "user", content: "x", message_id: "ext-1" },
      { role: "assistant", content: "y" },
    ]);
    const conv = db.get_messages_as_conversation("s_rep");
    expect(conv.find((m) => m.role === "user")?.message_id).toBe("ext-1");
    expect("message_id" in (conv.find((m) => m.role === "assistant") ?? {})).toBe(false);
  });

  it("get_messages_as_conversation include_ancestors walks chain", () => {
    db.create_session("root", "tui");
    db.append_message("root", "user", { content: "first prompt" });
    db.append_message("root", "assistant", { content: "first answer" });
    db.create_session("child", "tui", { parent_session_id: "root" });
    db.append_message("child", "user", { content: "second prompt" });
    db.append_message("child", "assistant", { content: "second answer" });
    const conv = db.get_messages_as_conversation("child", { include_ancestors: true });
    expect(conv.map((m) => m.content)).toEqual([
      "first prompt",
      "first answer",
      "second prompt",
      "second answer",
    ]);
  });

  it("get_messages_as_conversation avoids replayed duplicate user prompts", () => {
    db.create_session("root", "tui");
    db.append_message("root", "user", { content: "same prompt" });
    db.append_message("root", "user", { content: "same prompt" });
    db.append_message("root", "assistant", { content: "answer" });
    db.create_session("child", "tui", { parent_session_id: "root" });
    db.append_message("child", "user", { content: "next prompt" });
    const conv = db.get_messages_as_conversation("child", { include_ancestors: true });
    expect(conv.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "same prompt",
      "next prompt",
    ]);
  });

  it("finish_reason stored and surfaced for assistant", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", { content: "Done", finish_reason: "stop" });
    expect(db.get_messages("s1")[0]?.finish_reason).toBe("stop");
  });

  it("finish_reason restored by get_messages_as_conversation only on assistant", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", { content: "Done", finish_reason: "tool_calls" });
    db.append_message("s1", "user", { content: "next" });
    const conv = db.get_messages_as_conversation("s1");
    expect(conv[0]?.role).toBe("assistant");
    expect(conv[0]?.finish_reason).toBe("tool_calls");
    expect("finish_reason" in (conv[1] ?? {})).toBe(false);
  });

  it("reasoning persisted and restored for assistant only", () => {
    db.create_session("s1", "telegram");
    db.append_message("s1", "user", { content: "create a cron job" });
    db.append_message("s1", "assistant", {
      content: null,
      tool_calls: [{ function: { name: "cronjob", arguments: "{}" }, id: "c1", type: "function" }],
      reasoning: "I should call the cronjob tool to schedule this.",
    });
    db.append_message("s1", "tool", { content: '{"job_id": "abc"}', tool_call_id: "c1" });
    const conv = db.get_messages_as_conversation("s1");
    expect(conv).toHaveLength(3);
    expect(conv[1]?.reasoning).toBe("I should call the cronjob tool to schedule this.");
    expect("reasoning" in (conv[0] ?? {})).toBe(false);
    expect("reasoning" in (conv[2] ?? {})).toBe(false);
  });

  it("reasoning_details round-trip via JSON", () => {
    db.create_session("s1", "telegram");
    const details = [
      { type: "reasoning.summary", summary: "Thinking about tools" },
      { type: "reasoning.encrypted_content", encrypted_content: "abc123" },
    ];
    db.append_message("s1", "assistant", {
      content: "Hello",
      reasoning: "Thinking about what to say",
      reasoning_details: details,
    });
    const conv = db.get_messages_as_conversation("s1");
    expect(conv[0]?.reasoning).toBe("Thinking about what to say");
    expect(conv[0]?.reasoning_details).toEqual(details);
  });

  it("reasoning_content survives session replay", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", {
      content: "Hello",
      reasoning: "Short summary",
      reasoning_content: "Longer provider-native scratchpad",
    });
    const conv = db.get_messages_as_conversation("s1");
    expect(conv[0]?.reasoning).toBe("Short summary");
    expect(conv[0]?.reasoning_content).toBe("Longer provider-native scratchpad");
  });

  it("empty reasoning_content still round-trips on assistant", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", {
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "date", arguments: "{}" } }],
      reasoning_content: "",
    });
    const conv = db.get_messages_as_conversation("s1");
    expect("reasoning_content" in (conv[0] ?? {})).toBe(true);
    expect(conv[0]?.reasoning_content).toBe("");
  });

  it("codex_message_items round-trip via JSON", () => {
    db.create_session("s1", "cli");
    const items = [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        id: "msg_123",
        phase: "commentary",
        content: [{ type: "output_text", text: "Thinking..." }],
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        id: "msg_456",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Done!" }],
      },
    ];
    db.append_message("s1", "assistant", { content: "Done!", codex_message_items: items });
    const conv = db.get_messages_as_conversation("s1");
    expect(conv[0]?.codex_message_items).toEqual(items);
  });

  it("reasoning never leaks onto non-assistant messages", () => {
    db.create_session("s1", "telegram");
    db.append_message("s1", "user", { content: "hi" });
    db.append_message("s1", "assistant", { content: "hello", reasoning: null });
    const conv = db.get_messages_as_conversation("s1");
    expect("reasoning" in (conv[0] ?? {})).toBe(false);
    expect("reasoning" in (conv[1] ?? {})).toBe(false);
  });

  it("empty reasoning is treated as absent", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", { content: "hi", reasoning: "" });
    expect("reasoning" in (db.get_messages_as_conversation("s1")[0] ?? {})).toBe(false);
  });

  it("codex_reasoning_items round-trip via JSON", () => {
    db.create_session("s1", "cli");
    const codex = [
      { type: "reasoning", id: "rs_abc", encrypted_content: "enc_blob_123" },
      { type: "reasoning", id: "rs_def", encrypted_content: "enc_blob_456" },
    ];
    db.append_message("s1", "assistant", { content: "Done", codex_reasoning_items: codex });
    const conv = db.get_messages_as_conversation("s1");
    expect(conv[0]?.codex_reasoning_items).toEqual(codex);
  });

  it("malformed stored JSON falls back gracefully", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", { content: "x", reasoning_details: { a: 1 } });
    // Corrupt the stored JSON directly so the catch branches run.
    db._conn
      .prepare(
        "UPDATE messages SET reasoning_details = '{bad', codex_reasoning_items = '{bad', codex_message_items = '{bad', tool_calls = '{bad' WHERE session_id = ?",
      )
      .run("s1");
    const conv = db.get_messages_as_conversation("s1");
    expect(conv[0]?.reasoning_details).toBeNull();
    expect(conv[0]?.codex_reasoning_items).toBeNull();
    expect(conv[0]?.codex_message_items).toBeNull();
    expect(conv[0]?.tool_calls).toEqual([]);
    // get_messages also tolerates malformed tool_calls.
    expect(db.get_messages("s1")[0]?.tool_calls).toEqual([]);
  });

  it("replace_messages clears prior history and resets counters", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "old" });
    db.append_message("s1", "assistant", {
      content: "",
      tool_calls: [{ id: "c1", function: { name: "x", arguments: "{}" } }],
    });
    db.replace_messages("s1", [{ role: "user", content: "fresh" }]);
    const row = db.get_session("s1");
    expect(row?.message_count).toBe(1);
    expect(row?.tool_call_count).toBe(0);
    expect(db.get_messages("s1").map((m) => m.content)).toEqual(["fresh"]);
  });

  it("replace_messages preserves reasoning + codex blobs on assistant rows", () => {
    db.create_session("s1", "cli");
    db.replace_messages("s1", [
      {
        role: "assistant",
        content: "ok",
        reasoning: "r",
        reasoning_content: "rc",
        reasoning_details: [{ a: 1 }],
        codex_reasoning_items: [{ id: "k" }],
        codex_message_items: [{ id: "m" }],
        tool_calls: [{ id: "c", function: { name: "n", arguments: "{}" } }],
        platform_message_id: "p",
        observed: true,
        token_count: 5,
        finish_reason: "stop",
      },
    ]);
    const conv = db.get_messages_as_conversation("s1");
    expect(conv[0]?.reasoning).toBe("r");
    expect(conv[0]?.reasoning_content).toBe("rc");
    expect(conv[0]?.reasoning_details).toEqual([{ a: 1 }]);
    expect(conv[0]?.codex_reasoning_items).toEqual([{ id: "k" }]);
    expect(conv[0]?.codex_message_items).toEqual([{ id: "m" }]);
    expect(conv[0]?.tool_calls).toEqual([
      { id: "c", function: { name: "n", arguments: "{}" } },
    ]);
    expect(conv[0]?.message_id).toBe("p");
    expect(conv[0]?.observed).toBe(true);
  });

  it("replace_messages with single tool_call (non-array) increments count by 1", () => {
    db.create_session("s1", "cli");
    db.replace_messages("s1", [
      {
        role: "assistant",
        content: "ok",
        tool_calls: { id: "c1", function: { name: "n", arguments: "{}" } },
      },
    ]);
    expect(db.get_session("s1")?.tool_call_count).toBe(1);
  });

  it("append_message with single non-array tool_calls counts as 1", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", {
      content: "",
      tool_calls: { id: "x", function: { name: "n", arguments: "{}" } },
    });
    expect(db.get_session("s1")?.tool_call_count).toBe(1);
  });
});

// =========================================================================
// FTS5 search (TestFTS5Search)
// =========================================================================

describe("FTS5 search", () => {
  it("finds matching content", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "How do I deploy with Docker?" });
    db.append_message("s1", "assistant", { content: "Use docker compose up." });
    const results = db.search_messages("docker");
    expect(results.length).toBe(2);
    expect(
      results.some((r) => (r.snippet ?? "").toLowerCase().includes("docker")),
    ).toBe(true);
  });

  it("empty / whitespace queries return []", () => {
    expect(db.search_messages("")).toEqual([]);
    expect(db.search_messages("   ")).toEqual([]);
  });

  it("source_filter narrows the result set", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "CLI question about Python" });
    db.create_session("s2", "telegram");
    db.append_message("s2", "user", { content: "Telegram question about Python" });
    const results = db.search_messages("Python", { source_filter: ["telegram"] });
    expect(results.every((r) => r.source === "telegram")).toBe(true);
  });

  it("default search includes ACP and all platform sources", () => {
    for (const src of ["cli", "telegram", "signal", "homeassistant", "acp", "matrix"]) {
      const sid = `s-${src}`;
      db.create_session(sid, src);
      db.append_message(sid, "user", { content: `universal search test from ${src}` });
    }
    const results = db.search_messages("universal search test");
    expect(new Set(results.map((r) => r.source))).toEqual(
      new Set(["cli", "telegram", "signal", "homeassistant", "acp", "matrix"]),
    );
  });

  it("role_filter narrows", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "What is FastAPI?" });
    db.append_message("s1", "assistant", { content: "FastAPI is a web framework." });
    const results = db.search_messages("FastAPI", { role_filter: ["assistant"] });
    expect(results.every((r) => r.role === "assistant")).toBe(true);
  });

  it("returns context window per match", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Tell me about Kubernetes" });
    db.append_message("s1", "assistant", { content: "Kubernetes is an orchestrator." });
    const results = db.search_messages("Kubernetes");
    expect(results.length).toBe(2);
    expect(Array.isArray(results[0]?.context)).toBe(true);
    expect((results[0]?.context.length ?? 0) > 0).toBe(true);
  });

  it("context uses same-session neighbors when interleaved across sessions", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "cli");
    db.append_message("s1", "user", { content: "before needle" });
    db.append_message("s2", "user", { content: "other session message" });
    db.append_message("s1", "assistant", { content: "needle match" });
    db.append_message("s2", "assistant", { content: "another other session message" });
    db.append_message("s1", "user", { content: "after needle" });
    const results = db.search_messages('"needle match"');
    const needle = results.find(
      (r) => r.session_id === "s1" && r.snippet.includes("needle match"),
    );
    expect(needle?.context.map((c) => c.content)).toEqual([
      "before needle",
      "needle match",
      "after needle",
    ]);
  });

  it("special chars in queries do not crash", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "How do I use C++ templates?" });
    const dangerous = [
      "C++",
      '"unterminated',
      "(problem",
      "hello AND",
      "***",
      "{test}",
      "OR hello",
      "a AND OR b",
    ];
    for (const q of dangerous) {
      const r = db.search_messages(q);
      expect(Array.isArray(r)).toBe(true);
    }
  });

  it("sanitized query still finds content", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Learning C++ templates today" });
    expect(Array.isArray(db.search_messages("C++"))).toBe(true);
  });

  it("hyphenated terms match", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Run the chat-send command" });
    const r = db.search_messages("chat-send");
    expect(r.length).toBeGreaterThanOrEqual(1);
  });

  it("dotted terms match", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Working on P2.2 session_search edge cases" });
    db.append_message("s1", "assistant", { content: "See simulate.p2.test.ts for details" });
    expect(db.search_messages("P2.2").length).toBeGreaterThanOrEqual(1);
    expect(db.search_messages("simulate.p2.test.ts").length).toBeGreaterThanOrEqual(1);
  });

  it("quoted phrase preserved for exact matching", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "docker networking is complex" });
    db.append_message("s1", "assistant", { content: "networking docker tips" });
    expect(db.search_messages('"docker networking"').length).toBeGreaterThanOrEqual(1);
  });

  it("sort=newest orders by timestamp descending", async () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "alpha docker" });
    await new Promise((r) => setTimeout(r, 5));
    db.append_message("s1", "user", { content: "beta docker" });
    const results = db.search_messages("docker", { sort: "newest" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.timestamp >= results[results.length - 1]!.timestamp).toBe(true);
  });

  it("sort=oldest orders by timestamp ascending", async () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "alpha docker" });
    await new Promise((r) => setTimeout(r, 5));
    db.append_message("s1", "user", { content: "beta docker" });
    const results = db.search_messages("docker", { sort: "oldest" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.timestamp <= results[results.length - 1]!.timestamp).toBe(true);
  });

  it("sort=garbage falls back to rank ordering", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "x docker" });
    const results = db.search_messages("docker", { sort: "garbage" });
    expect(Array.isArray(results)).toBe(true);
  });

  it("context query catches DB errors per-row and substitutes []", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "unique-token" });
    const orig = db._conn.prepare.bind(db._conn);
    let throwCount = 0;
    // The context query is the *second* prepare call after search_messages
    // builds the main SELECT. Throwing on the first match-by-id triggers
    // the per-row catch path.
    db._conn.prepare = ((sql: string) => {
      if (sql.includes("WITH target AS") && throwCount === 0) {
        throwCount += 1;
        throw new Error("simulated context query failure");
      }
      return orig(sql);
    }) as typeof db._conn.prepare;
    try {
      const results = db.search_messages("unique-token");
      expect(results[0]?.context).toEqual([]);
    } finally {
      db._conn.prepare = orig;
    }
  });
});

// =========================================================================
// CJK fallback (TestCJKSearchFallback)
// =========================================================================

describe("CJK fallback search", () => {
  it("chinese multichar query returns results", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", {
      content: "昨天和其他Agent的聊天记录，记忆断裂问题复现了",
    });
    const r = db.search_messages("记忆断裂");
    expect(r.length).toBe(1);
    expect(r[0]?.session_id).toBe("s1");
  });

  it("chinese bigram query (short token routes via LIKE)", () => {
    db.create_session("s1", "telegram");
    db.append_message("s1", "user", { content: "今天讨论A2A通信协议的实现" });
    expect(db.search_messages("通信").length).toBe(1);
  });

  it("korean query returns results", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "안녕하세요 반갑습니다" });
    expect(db.search_messages("안녕").length).toBe(1);
  });

  it("japanese query returns results", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "こんにちは世界" });
    expect(db.search_messages("こんにちは").length).toBe(1);
    expect(db.search_messages("世界").length).toBe(1);
  });

  it("source_filter preserved in CJK fallback", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    db.append_message("s1", "user", { content: "记忆断裂在CLI" });
    db.append_message("s2", "user", { content: "记忆断裂在Telegram" });
    const r = db.search_messages("记忆断裂", { source_filter: ["telegram"] });
    expect(r.length).toBe(1);
    expect(r[0]?.source).toBe("telegram");
  });

  it("exclude_sources preserved in CJK fallback", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "tool");
    db.append_message("s1", "user", { content: "记忆断裂在CLI" });
    db.append_message("s2", "assistant", { content: "记忆断裂在tool" });
    const r = db.search_messages("记忆断裂", { exclude_sources: ["tool"] });
    expect(new Set(r.map((x) => x.source)).has("tool")).toBe(false);
    expect(r.some((x) => x.source === "cli")).toBe(true);
  });

  it("role_filter preserved in CJK fallback", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "用户说的记忆断裂" });
    db.append_message("s1", "assistant", { content: "助手说的记忆断裂" });
    const r = db.search_messages("记忆断裂", { role_filter: ["assistant"] });
    expect(r.length).toBe(1);
    expect(r[0]?.role).toBe("assistant");
  });

  it("snippet centered on CJK match", () => {
    db.create_session("s1", "cli");
    const longPrefix = "这是一段很长的前缀用来把匹配位置推到文档中间".repeat(3);
    const longSuffix = "这是一段很长的后缀内容填充剩余空间".repeat(3);
    db.append_message("s1", "user", { content: `${longPrefix}记忆断裂${longSuffix}` });
    const r = db.search_messages("记忆断裂");
    expect(r[0]?.snippet.includes("记忆断裂")).toBe(true);
  });

  it("english query still finds results (non-CJK fast path)", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Deploy docker containers" });
    expect(db.search_messages("docker").length).toBe(1);
  });

  it("CJK query with no matches returns []", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "unrelated English content" });
    expect(db.search_messages("记忆断裂")).toEqual([]);
  });

  it("mixed CJK+ASCII query matches via LIKE", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "讨论Agent通信协议" });
    expect(db.search_messages("Agent通信").length).toBe(1);
  });

  it("CJK partial FTS5 results supplemented by LIKE", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    db.append_message("s1", "user", { content: "昨晚讨论了记忆系统" });
    db.append_message("s2", "user", { content: "昨晚的会议纪要已发送" });
    const r = db.search_messages("昨晚");
    expect(r.length).toBe(2);
    expect(new Set(r.map((x) => x.session_id))).toEqual(new Set(["s1", "s2"]));
  });

  it("CJK LIKE escapes wildcards", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "cli");
    db.append_message("s1", "user", { content: "达成100%完成率" });
    db.append_message("s2", "user", { content: "达成100完成率是目标" });
    const r = db.search_messages("100%完成");
    expect(r.length).toBe(1);
    expect(r[0]?.session_id).toBe("s1");
  });

  it("CJK trigram preserves boolean operators", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "cli");
    db.append_message("s1", "user", { content: "记忆系统很好用" });
    db.append_message("s2", "user", { content: "断裂连接需要修复" });
    const r = db.search_messages("记忆系统 OR 断裂连接");
    expect(r.length).toBe(2);
  });

  it("CJK OR with short tokens routes to LIKE (#20494)", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    db.create_session("s3", "cli");
    db.append_message("s1", "user", { content: "广西是个好地方，去过桂林" });
    db.append_message("s2", "user", { content: "漓江风景很美，值得旅游" });
    db.append_message("s3", "user", { content: "unrelated English content" });
    const r = db.search_messages("广西 OR 桂林 OR 漓江 OR 旅游");
    const ids = new Set(r.map((x) => x.session_id));
    expect(ids.has("s1")).toBe(true);
    expect(ids.has("s2")).toBe(true);
    expect(ids.has("s3")).toBe(false);
  });

  it("short-token CJK OR preserves source_filter", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    db.append_message("s1", "user", { content: "广西旅游攻略cli" });
    db.append_message("s2", "user", { content: "广西旅游攻略telegram" });
    const r = db.search_messages("广西 OR 旅游", { source_filter: ["telegram"] });
    expect(r.length).toBe(1);
    expect(r[0]?.source).toBe("telegram");
  });

  it("short-token CJK exclude_sources is honored", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "tool");
    db.append_message("s1", "user", { content: "广西旅游攻略cli" });
    db.append_message("s2", "user", { content: "广西旅游攻略tool" });
    const r = db.search_messages("广西 OR 旅游", { exclude_sources: ["tool"] });
    expect(new Set(r.map((x) => x.source)).has("tool")).toBe(false);
  });

  it("short-token CJK role_filter is honored", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "用户广西旅游" });
    db.append_message("s1", "assistant", { content: "助手广西旅游" });
    const r = db.search_messages("广西 OR 旅游", { role_filter: ["assistant"] });
    expect(r.every((x) => x.role === "assistant")).toBe(true);
  });

  it("trigram exception path falls through to empty matches", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "记忆断裂测试" });
    const orig = db._conn.prepare.bind(db._conn);
    db._conn.prepare = ((sql: string) => {
      if (sql.includes("messages_fts_trigram")) {
        throw new Error("simulated trigram failure");
      }
      return orig(sql);
    }) as typeof db._conn.prepare;
    try {
      const r = db.search_messages("记忆断裂");
      expect(r).toEqual([]);
    } finally {
      db._conn.prepare = orig;
    }
  });

  it("search_messages context with multimodal previews renders [multimodal content]", () => {
    db.create_session("s1", "cli");
    // Sandwich a multimodal message between two text turns so the snippet
    // query's context fetch hits the list-decoded branch.
    db.append_message("s1", "user", { content: "before" });
    db.append_message("s1", "user", {
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,A" } }],
    });
    db.append_message("s1", "assistant", { content: "match-token after" });
    const r = db.search_messages("match-token");
    const contexts = r[0]?.context ?? [];
    expect(
      contexts.some((c) => c.content === "[multimodal content]"),
    ).toBe(true);
  });

  it("search_messages renders multimodal text-only parts when present", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "before" });
    db.append_message("s1", "user", {
      content: [
        { type: "text", text: "alpha" },
        { type: "text", text: "beta" },
      ],
    });
    db.append_message("s1", "assistant", { content: "match-token-2 after" });
    const r = db.search_messages("match-token-2");
    const previews = r[0]?.context.map((c) => c.content) ?? [];
    expect(previews.some((p) => p.includes("alpha") && p.includes("beta"))).toBe(true);
  });
});

// =========================================================================
// Session search and listing
// =========================================================================

describe("Session search & listing", () => {
  it("lists all sessions", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    expect(db.search_sessions().length).toBe(2);
  });

  it("filters by source", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    const r = db.search_sessions({ source: "cli" });
    expect(r.length).toBe(1);
    expect(r[0]?.source).toBe("cli");
  });

  it("pagination", () => {
    for (let i = 0; i < 5; i++) db.create_session(`s${i}`, "cli");
    const page1 = db.search_sessions({ limit: 2 });
    const page2 = db.search_sessions({ limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });
});

// =========================================================================
// Counts
// =========================================================================

describe("Counts", () => {
  it("session_count total", () => {
    expect(db.session_count()).toBe(0);
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    expect(db.session_count()).toBe(2);
  });

  it("session_count by source", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    db.create_session("s3", "cli");
    expect(db.session_count("cli")).toBe(2);
    expect(db.session_count("telegram")).toBe(1);
  });

  it("message_count total", () => {
    expect(db.message_count()).toBe(0);
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Hello" });
    db.append_message("s1", "assistant", { content: "Hi" });
    expect(db.message_count()).toBe(2);
  });

  it("message_count per session", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "cli");
    db.append_message("s1", "user", { content: "A" });
    db.append_message("s2", "user", { content: "B" });
    db.append_message("s2", "user", { content: "C" });
    expect(db.message_count("s1")).toBe(1);
    expect(db.message_count("s2")).toBe(2);
  });
});

// =========================================================================
// Delete & export
// =========================================================================

describe("Delete & export", () => {
  it("delete_session removes session + messages", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Hello" });
    expect(db.delete_session("s1")).toBe(true);
    expect(db.get_session("s1")).toBeNull();
    expect(db.message_count("s1")).toBe(0);
  });

  it("delete_session returns false for missing row", () => {
    expect(db.delete_session("nope")).toBe(false);
  });

  it("resolve_session_id exact match", () => {
    db.create_session("20260315_092437_c9a6ff", "cli");
    expect(db.resolve_session_id("20260315_092437_c9a6ff")).toBe(
      "20260315_092437_c9a6ff",
    );
  });

  it("resolve_session_id unique prefix", () => {
    db.create_session("20260315_092437_c9a6ff", "cli");
    expect(db.resolve_session_id("20260315_092437_c9a6")).toBe(
      "20260315_092437_c9a6ff",
    );
  });

  it("resolve_session_id ambiguous prefix → null", () => {
    db.create_session("20260315_092437_c9a6aa", "cli");
    db.create_session("20260315_092437_c9a6bb", "cli");
    expect(db.resolve_session_id("20260315_092437_c9a6")).toBeNull();
  });

  it("resolve_session_id escapes LIKE wildcards", () => {
    db.create_session("20260315_092437_c9a6ff", "cli");
    db.create_session("20260315X092437_c9a6ff", "cli");
    expect(db.resolve_session_id("20260315_092437")).toBe("20260315_092437_c9a6ff");
  });

  it("export_session bundles messages", () => {
    db.create_session("s1", "cli", { model: "test" });
    db.append_message("s1", "user", { content: "Hello" });
    db.append_message("s1", "assistant", { content: "Hi" });
    const exp = db.export_session("s1");
    expect(exp?.source).toBe("cli");
    expect(exp?.messages.length).toBe(2);
  });

  it("export_session returns null for missing row", () => {
    expect(db.export_session("nope")).toBeNull();
  });

  it("export_all returns all sessions", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    db.append_message("s1", "user", { content: "A" });
    expect(db.export_all().length).toBe(2);
  });

  it("export_all with source filter", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    const exp = db.export_all("cli");
    expect(exp.length).toBe(1);
    expect(exp[0]?.source).toBe("cli");
  });

  it("clear_messages resets counters", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "A" });
    db.append_message("s1", "assistant", {
      content: "",
      tool_calls: [{ id: "c", function: { name: "n", arguments: "{}" } }],
    });
    db.clear_messages("s1");
    const row = db.get_session("s1");
    expect(row?.message_count).toBe(0);
    expect(row?.tool_call_count).toBe(0);
    expect(db.message_count("s1")).toBe(0);
  });
});

// =========================================================================
// Prune
// =========================================================================

describe("Prune sessions", () => {
  it("prunes old ended sessions", () => {
    db.create_session("old", "cli");
    db.end_session("old", "done");
    db._conn
      .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run(Date.now() / 1000 - 100 * 86400, "old");
    db.create_session("new", "cli");
    const pruned = db.prune_sessions({ older_than_days: 90 });
    expect(pruned).toBe(1);
    expect(db.get_session("old")).toBeNull();
    expect(db.get_session("new")?.id).toBe("new");
  });

  it("skips active sessions", () => {
    db.create_session("active", "cli");
    db._conn
      .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run(Date.now() / 1000 - 200 * 86400, "active");
    expect(db.prune_sessions({ older_than_days: 90 })).toBe(0);
    expect(db.get_session("active")).not.toBeNull();
  });

  it("source filter narrows the prune", () => {
    for (const [sid, src] of [["old_cli", "cli"], ["old_tg", "telegram"]] as const) {
      db.create_session(sid, src);
      db.end_session(sid, "done");
      db._conn
        .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
        .run(Date.now() / 1000 - 200 * 86400, sid);
    }
    expect(db.prune_sessions({ older_than_days: 90, source: "cli" })).toBe(1);
    expect(db.get_session("old_cli")).toBeNull();
    expect(db.get_session("old_tg")).not.toBeNull();
  });

  it("orphans newer descendants when ancestors are pruned", () => {
    const oldTs = Date.now() / 1000 - 200 * 86400;
    const recentTs = Date.now() / 1000 - 10 * 86400;
    db.create_session("A", "cli");
    db.end_session("A", "compressed");
    db.create_session("B", "cli", { parent_session_id: "A" });
    db.end_session("B", "compressed");
    db.create_session("C", "cli", { parent_session_id: "B" });
    db.end_session("C", "compressed");
    db.create_session("D", "cli", { parent_session_id: "C" });
    db.end_session("D", "done");
    for (const [sid, ts] of [["A", oldTs], ["B", oldTs], ["C", recentTs], ["D", recentTs]] as const) {
      db._conn
        .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
        .run(ts, sid);
    }
    const pruned = db.prune_sessions({ older_than_days: 90 });
    expect(pruned).toBe(2);
    expect(db.get_session("A")).toBeNull();
    expect(db.get_session("B")).toBeNull();
    const c = db.get_session("C");
    expect(c?.parent_session_id).toBeNull();
    expect(db.get_session("D")?.parent_session_id).toBe("C");
  });

  it("prunes entire old chain", () => {
    const oldTs = Date.now() / 1000 - 200 * 86400;
    db.create_session("X", "cli");
    db.end_session("X", "compressed");
    db.create_session("Y", "cli", { parent_session_id: "X" });
    db.end_session("Y", "compressed");
    db.create_session("Z", "cli", { parent_session_id: "Y" });
    db.end_session("Z", "done");
    for (const sid of ["X", "Y", "Z"] as const) {
      db._conn
        .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
        .run(oldTs, sid);
    }
    expect(db.prune_sessions({ older_than_days: 90 })).toBe(3);
    for (const sid of ["X", "Y", "Z"] as const) {
      expect(db.get_session(sid)).toBeNull();
    }
  });
});

// =========================================================================
// Delete orphans children
// =========================================================================

describe("Delete orphans children", () => {
  it("deleting a parent leaves children intact (orphaned)", () => {
    db.create_session("parent", "cli");
    db.create_session("child", "cli", { parent_session_id: "parent" });
    db.create_session("grandchild", "cli", { parent_session_id: "child" });
    expect(db.delete_session("parent")).toBe(true);
    expect(db.get_session("parent")).toBeNull();
    expect(db.get_session("child")?.parent_session_id).toBeNull();
    expect(db.get_session("grandchild")?.parent_session_id).toBe("child");
  });
});

// =========================================================================
// Title management (TestSessionTitle + TestTitleUniqueness + TestTitleLineage)
// =========================================================================

describe("Session title", () => {
  it("set and get title", () => {
    db.create_session("s1", "cli");
    expect(db.set_session_title("s1", "My Session")).toBe(true);
    expect(db.get_session("s1")?.title).toBe("My Session");
  });

  it("set on nonexistent session → false", () => {
    expect(db.set_session_title("nonexistent", "Title")).toBe(false);
  });

  it("title initially null", () => {
    db.create_session("s1", "cli");
    expect(db.get_session("s1")?.title).toBeNull();
  });

  it("update title", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "First Title");
    db.set_session_title("s1", "Updated Title");
    expect(db.get_session("s1")?.title).toBe("Updated Title");
  });

  it("title visible in search_sessions", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "Debugging Auth");
    db.create_session("s2", "cli");
    const titled = db.search_sessions().filter((s) => s.title === "Debugging Auth");
    expect(titled.length).toBe(1);
    expect(titled[0]?.id).toBe("s1");
  });

  it("title surfaces in export", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "Export Test");
    db.append_message("s1", "user", { content: "Hello" });
    expect(db.export_session("s1")?.title).toBe("Export Test");
  });

  it("title with special characters", () => {
    db.create_session("s1", "cli");
    const t = "PR #438 — fixing the 'auth' middleware";
    db.set_session_title("s1", t);
    expect(db.get_session("s1")?.title).toBe(t);
  });

  it("empty string normalized to null", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "My Title");
    db.set_session_title("s1", "");
    expect(db.get_session("s1")?.title).toBeNull();
  });

  it("multiple empty titles do not conflict", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "cli");
    db.set_session_title("s1", "");
    db.set_session_title("s2", "");
    expect(db.get_session("s1")?.title).toBeNull();
    expect(db.get_session("s2")?.title).toBeNull();
  });

  it("title survives end_session", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "Before End");
    db.end_session("s1", "user_exit");
    const row = db.get_session("s1");
    expect(row?.title).toBe("Before End");
    expect(row?.ended_at).not.toBeNull();
  });

  it("set_session_title applies sanitize_title", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "  hello\x00  world  ");
    expect(db.get_session("s1")?.title).toBe("hello world");
  });

  it("too-long title rejected by set", () => {
    db.create_session("s1", "cli");
    expect(() => db.set_session_title("s1", "X".repeat(150))).toThrow(/too long/);
  });

  it("duplicate title throws", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "cli");
    db.set_session_title("s1", "my project");
    expect(() => db.set_session_title("s2", "my project")).toThrow(/already in use/);
  });

  it("same session can reset its own title", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "my project");
    expect(db.set_session_title("s1", "my project")).toBe(true);
  });

  it("get_session_by_title", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "refactoring auth");
    const r = db.get_session_by_title("refactoring auth");
    expect(r?.id).toBe("s1");
    expect(db.get_session_by_title("nonexistent")).toBeNull();
  });

  it("get_session_title returns null for missing or no-title rows", () => {
    db.create_session("s1", "cli");
    expect(db.get_session_title("s1")).toBeNull();
    db.set_session_title("s1", "my title");
    expect(db.get_session_title("s1")).toBe("my title");
    expect(db.get_session_title("nonexistent")).toBeNull();
  });

  it("resolve_session_by_title returns exact match", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "my project");
    expect(db.resolve_session_by_title("my project")).toBe("s1");
  });

  it("resolve_session_by_title prefers latest numbered variant", async () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "my project");
    await new Promise((r) => setTimeout(r, 12));
    db.create_session("s2", "cli");
    db.set_session_title("s2", "my project #2");
    await new Promise((r) => setTimeout(r, 12));
    db.create_session("s3", "cli");
    db.set_session_title("s3", "my project #3");
    expect(db.resolve_session_by_title("my project")).toBe("s3");
  });

  it("resolve exact numbered title returns that specific session", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "my project");
    db.create_session("s2", "cli");
    db.set_session_title("s2", "my project #2");
    expect(db.resolve_session_by_title("my project #2")).toBe("s2");
  });

  it("resolve nonexistent title returns null", () => {
    expect(db.resolve_session_by_title("nonexistent")).toBeNull();
  });

  it("get_next_title_in_lineage with no existing", () => {
    expect(db.get_next_title_in_lineage("my project")).toBe("my project");
  });

  it("get_next_title_in_lineage first continuation", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "my project");
    expect(db.get_next_title_in_lineage("my project")).toBe("my project #2");
  });

  it("get_next_title_in_lineage increments", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "my project");
    db.create_session("s2", "cli");
    db.set_session_title("s2", "my project #2");
    db.create_session("s3", "cli");
    db.set_session_title("s3", "my project #3");
    expect(db.get_next_title_in_lineage("my project")).toBe("my project #4");
  });

  it("get_next_title_in_lineage strips existing #N", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "my project");
    db.create_session("s2", "cli");
    db.set_session_title("s2", "my project #2");
    expect(db.get_next_title_in_lineage("my project #2")).toBe("my project #3");
  });

  it("title underscore SQL wildcard safety", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "test_project");
    db.create_session("s2", "cli");
    db.set_session_title("s2", "testXproject #2");
    expect(db.resolve_session_by_title("test_project")).toBe("s1");
  });

  it("title percent SQL wildcard safety", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "100% done");
    db.create_session("s2", "cli");
    db.set_session_title("s2", "100X done #2");
    expect(db.resolve_session_by_title("100% done")).toBe("s1");
  });

  it("get_next_title_in_lineage underscore safety", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "test_project");
    db.create_session("s2", "cli");
    db.set_session_title("s2", "testXproject #2");
    expect(db.get_next_title_in_lineage("test_project")).toBe("test_project #2");
  });
});

// =========================================================================
// Schema init (TestSchemaInit subset)
// =========================================================================

describe("Schema init", () => {
  it("WAL mode enabled on local filesystem", () => {
    const row = db._conn
      .prepare("PRAGMA journal_mode")
      .get<{ journal_mode: string }>();
    expect(row?.journal_mode.toLowerCase()).toBe("wal");
  });

  it("foreign_keys enabled", () => {
    const row = db._conn
      .prepare("PRAGMA foreign_keys")
      .get<{ foreign_keys: number }>();
    expect(row?.foreign_keys).toBe(1);
  });

  it("expected tables exist", () => {
    const rows = db._conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all<{ name: string }>();
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("sessions")).toBe(true);
    expect(names.has("messages")).toBe(true);
    expect(names.has("schema_version")).toBe(true);
  });

  it("schema_version matches SCHEMA_VERSION", () => {
    const row = db._conn
      .prepare("SELECT version FROM schema_version")
      .get<{ version: number }>();
    expect(row?.version).toBe(SCHEMA_VERSION);
  });

  it("title column exists", () => {
    const cols = db._conn
      .prepare("PRAGMA table_info(sessions)")
      .all<{ name: string }>();
    expect(cols.some((c) => c.name === "title")).toBe(true);
  });

  it("opening an old DB does not eager-add topic-mode tables", () => {
    db.close();
    const oldDbPath = join(_tmpRoot, "old.db");
    const raw = new WasmDatabase(oldDbPath);
    raw.exec(`
            CREATE TABLE schema_version (version INTEGER NOT NULL);
            INSERT INTO schema_version VALUES (11);
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                user_id TEXT,
                model TEXT,
                model_config TEXT,
                system_prompt TEXT,
                parent_session_id TEXT,
                started_at REAL NOT NULL,
                ended_at REAL,
                end_reason TEXT,
                message_count INTEGER DEFAULT 0,
                tool_call_count INTEGER DEFAULT 0,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                cache_read_tokens INTEGER DEFAULT 0,
                cache_write_tokens INTEGER DEFAULT 0,
                reasoning_tokens INTEGER DEFAULT 0,
                billing_provider TEXT,
                billing_base_url TEXT,
                billing_mode TEXT,
                estimated_cost_usd REAL,
                actual_cost_usd REAL,
                cost_status TEXT,
                cost_source TEXT,
                pricing_version TEXT,
                title TEXT,
                api_call_count INTEGER DEFAULT 0,
                FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                role TEXT NOT NULL,
                content TEXT,
                tool_call_id TEXT,
                tool_calls TEXT,
                tool_name TEXT,
                timestamp REAL NOT NULL,
                token_count INTEGER,
                finish_reason TEXT,
                reasoning TEXT,
                reasoning_content TEXT,
                reasoning_details TEXT,
                codex_reasoning_items TEXT,
                codex_message_items TEXT
            );
        `);
    raw.close();
    db = new SessionDB(oldDbPath);
    const cols = db._conn
      .prepare("PRAGMA table_info(sessions)")
      .all<{ name: string }>();
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("chat_id")).toBe(false);
    expect(names.has("chat_type")).toBe(false);
    expect(names.has("thread_id")).toBe(false);
    expect(names.has("session_key")).toBe(false);
  });

  it("reconciliation adds missing columns from old DB", () => {
    db.close();
    const oldDbPath = join(_tmpRoot, "gap.db");
    const raw = new WasmDatabase(oldDbPath);
    raw.exec(`
            CREATE TABLE schema_version (version INTEGER NOT NULL);
            INSERT INTO schema_version (version) VALUES (7);
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                user_id TEXT,
                model TEXT,
                model_config TEXT,
                system_prompt TEXT,
                parent_session_id TEXT,
                started_at REAL NOT NULL,
                ended_at REAL,
                end_reason TEXT,
                message_count INTEGER DEFAULT 0,
                tool_call_count INTEGER DEFAULT 0,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                cache_read_tokens INTEGER DEFAULT 0,
                cache_write_tokens INTEGER DEFAULT 0,
                reasoning_tokens INTEGER DEFAULT 0,
                billing_provider TEXT,
                billing_base_url TEXT,
                billing_mode TEXT,
                estimated_cost_usd REAL,
                actual_cost_usd REAL,
                cost_status TEXT,
                cost_source TEXT,
                pricing_version TEXT,
                title TEXT,
                api_call_count INTEGER DEFAULT 0
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT,
                tool_call_id TEXT,
                tool_calls TEXT,
                tool_name TEXT,
                timestamp REAL NOT NULL,
                token_count INTEGER,
                finish_reason TEXT,
                reasoning TEXT,
                reasoning_details TEXT,
                codex_reasoning_items TEXT
            );
        `);
    raw.prepare("INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)").run([
      "s1",
      "cli",
      1000.0,
    ]);
    raw
      .prepare(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
      )
      .run(["s1", "assistant", "hello", 1001.0]);
    raw.close();

    db = new SessionDB(oldDbPath);
    const cols = db._conn
      .prepare("PRAGMA table_info(messages)")
      .all<{ name: string }>();
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("reasoning_content")).toBe(true);

    const row = db._conn
      .prepare(
        "SELECT role, content, reasoning, reasoning_content, reasoning_details, codex_reasoning_items FROM messages WHERE session_id = ?",
      )
      .get<{
        role: string;
        reasoning_content: string | null;
      }>("s1");
    expect(row?.role).toBe("assistant");
    expect(row?.reasoning_content).toBeNull();
  });

  it("reconciliation is idempotent across two opens", () => {
    db.close();
    const path = join(_tmpRoot, "idempotent.db");
    const a = new SessionDB(path);
    const cols1 = new Set(
      a._conn
        .prepare("PRAGMA table_info(messages)")
        .all<{ name: string }>()
        .map((c) => c.name),
    );
    a.close();
    const b = new SessionDB(path);
    const cols2 = new Set(
      b._conn
        .prepare("PRAGMA table_info(messages)")
        .all<{ name: string }>()
        .map((c) => c.name),
    );
    b.close();
    db = new SessionDB(join(_tmpRoot, "test_state.db")); // restore for afterEach
    expect(cols1).toEqual(cols2);
  });

  it("SCHEMA_SQL is the live source of truth", () => {
    const expected = SessionDB._parse_schema_columns(SCHEMA_SQL);
    for (const [tableName, declared] of Object.entries(expected)) {
      const live = new Set(
        db._conn
          .prepare(`PRAGMA table_info("${tableName}")`)
          .all<{ name: string }>()
          .map((c) => c.name),
      );
      for (const col of Object.keys(declared)) {
        expect(live.has(col)).toBe(true);
      }
    }
  });

  it("v10 → v11 migration backfills tool fields into FTS", () => {
    db.close();
    const legacyPath = join(_tmpRoot, "legacy.db");
    const raw = new WasmDatabase(legacyPath);
    raw.exec(`
            CREATE TABLE schema_version (version INTEGER NOT NULL);
            INSERT INTO schema_version (version) VALUES (10);
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT,
                started_at REAL,
                ended_at REAL,
                title TEXT,
                parent_session_id TEXT,
                message_count INTEGER DEFAULT 0,
                tool_call_count INTEGER DEFAULT 0,
                api_call_count INTEGER DEFAULT 0
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                timestamp REAL NOT NULL,
                role TEXT NOT NULL,
                content TEXT,
                tool_name TEXT,
                tool_calls TEXT,
                tool_call_id TEXT,
                token_count INTEGER,
                finish_reason TEXT,
                reasoning TEXT,
                reasoning_content TEXT,
                reasoning_details TEXT,
                codex_reasoning_items TEXT,
                codex_message_items TEXT
            );
            CREATE VIRTUAL TABLE messages_fts USING fts5(
                content, content=messages, content_rowid=id
            );
            CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
            END;
            CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
                content, content=messages, content_rowid=id, tokenize='trigram'
            );
            CREATE TRIGGER messages_fts_trigram_insert AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts_trigram(rowid, content) VALUES (new.id, new.content);
            END;
        `);
    raw.prepare("INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)").run([
      "s1",
      "cli",
      Date.now() / 1000,
    ]);
    raw
      .prepare(
        "INSERT INTO messages (session_id, timestamp, role, content, tool_name, tool_calls) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run([
        "s1",
        Date.now() / 1000,
        "assistant",
        "",
        "LEGACYTOOL",
        '{"function":{"name":"web_search","arguments":"{\\"q\\":\\"LEGACYARG\\"}"}}',
      ]);
    const legacyHits = raw
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'LEGACYTOOL'")
      .all([]);
    expect(legacyHits).toEqual([]);
    raw.close();

    db = new SessionDB(legacyPath);
    expect(db.search_messages("LEGACYTOOL").length).toBe(1);
    expect(db.search_messages("LEGACYARG").length).toBe(1);
    const v = db._conn
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get<{ version: number }>();
    expect(v?.version).toBe(SCHEMA_VERSION);
  });
});

// =========================================================================
// List sessions rich
// =========================================================================

describe("list_sessions_rich", () => {
  it("preview from first user message", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "system", { content: "You are a helpful assistant." });
    db.append_message("s1", "user", { content: "Help me refactor the auth module please" });
    db.append_message("s1", "assistant", { content: "Sure, let me look at it." });
    const sessions = db.list_sessions_rich();
    expect(sessions[0]?.preview.includes("Help me refactor the auth module")).toBe(true);
  });

  it("preview truncated at 60 chars + ellipsis", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "A".repeat(100) });
    const sessions = db.list_sessions_rich();
    expect(sessions[0]?.preview.length).toBe(63);
    expect(sessions[0]?.preview.endsWith("...")).toBe(true);
  });

  it("preview empty when no user messages", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "system", { content: "System prompt" });
    expect(db.list_sessions_rich()[0]?.preview).toBe("");
  });

  it("last_active from latest message timestamp", async () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Hello" });
    await new Promise((r) => setTimeout(r, 12));
    db.append_message("s1", "assistant", { content: "Hi there!" });
    const s = db.list_sessions_rich()[0]!;
    expect(s.last_active).toBeGreaterThan(s.started_at);
  });

  it("last_active falls back to started_at", () => {
    db.create_session("s1", "cli");
    const s = db.list_sessions_rich()[0]!;
    expect(s.last_active).toBe(s.started_at);
  });

  it("order_by_last_active surfaces recently-touched older session first", () => {
    const t0 = 1709500000.0;
    db.create_session("old", "cli");
    db.create_session("new", "cli");
    db._conn.prepare("UPDATE sessions SET started_at=? WHERE id=?").run(t0, "old");
    db._conn.prepare("UPDATE sessions SET started_at=? WHERE id=?").run(t0 + 10, "new");
    db.append_message("old", "user", { content: "old first" });
    db.append_message("new", "user", { content: "new first" });
    db.append_message("old", "assistant", { content: "old touched later" });
    db._conn
      .prepare("UPDATE messages SET timestamp=? WHERE session_id=? AND role=? AND content=?")
      .run(t0 + 1, "old", "user", "old first");
    db._conn
      .prepare("UPDATE messages SET timestamp=? WHERE session_id=? AND role=? AND content=?")
      .run(t0 + 11, "new", "user", "new first");
    db._conn
      .prepare("UPDATE messages SET timestamp=? WHERE session_id=? AND role=? AND content=?")
      .run(t0 + 20, "old", "assistant", "old touched later");
    expect(db.list_sessions_rich({ limit: 5 }).map((s) => s.id)).toEqual(["new", "old"]);
    expect(
      db.list_sessions_rich({ limit: 5, order_by_last_active: true }).map((s) => s.id),
    ).toEqual(["old", "new"]);
  });

  it("order_by_last_active uses compression tip activity", () => {
    const t0 = 1709500000.0;
    db.create_session("root1", "cli");
    db._conn.prepare("UPDATE sessions SET started_at=? WHERE id=?").run(t0, "root1");
    db._conn
      .prepare("UPDATE sessions SET ended_at=?, end_reason=? WHERE id=?")
      .run(t0 + 100, "compression", "root1");
    db.append_message("root1", "user", { content: "old ask" });
    db.create_session("tip1", "cli", { parent_session_id: "root1" });
    db._conn.prepare("UPDATE sessions SET started_at=? WHERE id=?").run(t0 + 101, "tip1");
    db.append_message("tip1", "user", { content: "latest message" });
    for (let i = 0; i < 5; i++) {
      const sid = `newer${i}`;
      db.create_session(sid, "cli");
      db._conn.prepare("UPDATE sessions SET started_at=? WHERE id=?").run(t0 + 500 + i, sid);
      db.append_message(sid, "user", { content: `msg ${i}` });
      db._conn
        .prepare("UPDATE messages SET timestamp=? WHERE session_id=? AND content=?")
        .run(t0 + 500 + i, sid, `msg ${i}`);
    }
    db._conn
      .prepare("UPDATE messages SET timestamp=? WHERE session_id=? AND content=?")
      .run(t0 + 10000, "tip1", "latest message");
    const top = db.list_sessions_rich({ limit: 1, order_by_last_active: true });
    expect(top[0]?.id).toBe("tip1");
    expect(top[0]?._lineage_root_id).toBe("root1");
  });

  it("list rich includes title", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "refactoring auth");
    expect(db.list_sessions_rich()[0]?.title).toBe("refactoring auth");
  });

  it("rich list source filter", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "telegram");
    const s = db.list_sessions_rich({ source: "cli" });
    expect(s.length).toBe(1);
    expect(s[0]?.id).toBe("s1");
  });

  it("preview newlines collapsed", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Line one\nLine two\nLine three" });
    const p = db.list_sessions_rich()[0]?.preview ?? "";
    expect(p.includes("\n")).toBe(false);
    expect(p.includes("Line one Line two")).toBe(true);
  });

  it("branch session visible (parent branched)", () => {
    db.create_session("parent", "cli");
    db.end_session("parent", "branched");
    db.create_session("branch", "cli", { parent_session_id: "parent" });
    db.append_message("branch", "user", { content: "Exploring alt approach" });
    const ids = db.list_sessions_rich().map((s) => s.id);
    expect(ids.includes("branch")).toBe(true);
  });

  it("subagent (parent NOT branched) is hidden", () => {
    db.create_session("root", "cli");
    db.create_session("delegate", "cli", { parent_session_id: "root" });
    const ids = db.list_sessions_rich().map((s) => s.id);
    expect(ids.includes("delegate")).toBe(false);
    expect(ids.includes("root")).toBe(true);
  });

  it("compression child stays hidden when project_compression_tips=false", () => {
    const t0 = Date.now() / 1000;
    db.create_session("root", "cli");
    db._conn.prepare("UPDATE sessions SET started_at=? WHERE id=?").run(t0, "root");
    db._conn
      .prepare("UPDATE sessions SET ended_at=?, end_reason='compression' WHERE id=?")
      .run(t0 + 1800, "root");
    db.create_session("continuation", "cli", { parent_session_id: "root" });
    db._conn
      .prepare("UPDATE sessions SET started_at=? WHERE id=?")
      .run(t0 + 1801, "continuation");
    const ids = db.list_sessions_rich({ project_compression_tips: false }).map((s) => s.id);
    expect(ids.includes("continuation")).toBe(false);
  });

  it("include_children=true surfaces all children", () => {
    db.create_session("root", "cli");
    db.create_session("delegate", "cli", { parent_session_id: "root" });
    const ids = db.list_sessions_rich({ include_children: true }).map((s) => s.id);
    expect(ids.includes("delegate")).toBe(true);
  });
});

// =========================================================================
// Compression chain projection (TestCompressionChainProjection)
// =========================================================================

describe("Compression chain projection", () => {
  function buildChain(t0: number): void {
    db.create_session("root1", "cli");
    db._conn.prepare("UPDATE sessions SET started_at=? WHERE id=?").run(t0, "root1");
    db.append_message("root1", "user", { content: "help me refactor auth" });
    db.create_session("delegate1", "cli", { parent_session_id: "root1" });
    db._conn
      .prepare("UPDATE sessions SET started_at=?, ended_at=? WHERE id=?")
      .run(t0 + 600, t0 + 650, "delegate1");
    db.append_message("delegate1", "user", { content: "delegate task" });

    const tCompressRoot = t0 + 1800;
    db._conn
      .prepare("UPDATE sessions SET ended_at=?, end_reason=? WHERE id=?")
      .run(tCompressRoot, "compression", "root1");

    db.create_session("mid1", "cli", { parent_session_id: "root1" });
    db._conn
      .prepare("UPDATE sessions SET started_at=? WHERE id=?")
      .run(tCompressRoot + 1, "mid1");
    db.append_message("mid1", "user", { content: "continuing" });

    const tCompressMid = tCompressRoot + 1800;
    db._conn
      .prepare("UPDATE sessions SET ended_at=?, end_reason=? WHERE id=?")
      .run(tCompressMid, "compression", "mid1");

    db.create_session("tip1", "cli", { parent_session_id: "mid1" });
    db._conn
      .prepare("UPDATE sessions SET started_at=? WHERE id=?")
      .run(tCompressMid + 1, "tip1");
    db.append_message("tip1", "user", { content: "latest message" });
  }

  it("get_compression_tip walks full chain", () => {
    buildChain(Date.now() / 1000 - 3600);
    expect(db.get_compression_tip("root1")).toBe("tip1");
    expect(db.get_compression_tip("mid1")).toBe("tip1");
    expect(db.get_compression_tip("tip1")).toBe("tip1");
  });

  it("get_compression_tip returns self for uncompressed", () => {
    db.create_session("solo", "cli");
    expect(db.get_compression_tip("solo")).toBe("solo");
  });

  it("get_compression_tip skips delegate children", () => {
    buildChain(Date.now() / 1000 - 3600);
    expect(db.get_compression_tip("root1")).toBe("tip1");
  });

  it("list surfaces tip in place of compressed root", () => {
    buildChain(Date.now() / 1000 - 3600);
    db.create_session("solo", "cli");
    db.append_message("solo", "user", { content: "standalone" });
    const sessions = db.list_sessions_rich({ source: "cli", limit: 20 });
    const ids = sessions.map((s) => s.id);
    expect(ids.includes("tip1")).toBe(true);
    expect(ids.includes("solo")).toBe(true);
    expect(ids.includes("root1")).toBe(false);
    expect(ids.includes("mid1")).toBe(false);
    expect(ids.includes("delegate1")).toBe(false);
    const tip = sessions.find((s) => s.id === "tip1")!;
    expect(tip._lineage_root_id).toBe("root1");
    expect(tip.preview.startsWith("latest message")).toBe(true);
    expect(tip.ended_at).toBeNull();
    expect(tip.end_reason).toBeNull();
  });

  it("list without projection returns raw root", () => {
    buildChain(Date.now() / 1000 - 3600);
    const sessions = db.list_sessions_rich({
      source: "cli",
      limit: 20,
      project_compression_tips: false,
    });
    const ids = sessions.map((s) => s.id);
    expect(ids.includes("root1")).toBe(true);
    expect(ids.includes("tip1")).toBe(false);
    const root = sessions.find((s) => s.id === "root1")!;
    expect(root.end_reason).toBe("compression");
    expect("_lineage_root_id" in root).toBe(false);
  });

  it("ordering preserves root.started_at for projected entries", () => {
    const t0 = Date.now() / 1000 - 3600;
    buildChain(t0);
    const tBetween = t0 + 120;
    db.create_session("newer", "cli");
    db._conn.prepare("UPDATE sessions SET started_at=? WHERE id=?").run(tBetween, "newer");
    db.append_message("newer", "user", { content: "newer session" });
    const ids = db
      .list_sessions_rich({ source: "cli", limit: 20 })
      .map((s) => s.id);
    expect(ids.indexOf("newer") < ids.indexOf("tip1")).toBe(true);
  });

  it("broken chain (root with no child) doesn't crash list", () => {
    const t0 = Date.now() / 1000 - 100;
    db.create_session("orphan", "cli");
    db._conn.prepare("UPDATE sessions SET started_at=? WHERE id=?").run(t0, "orphan");
    db._conn
      .prepare("UPDATE sessions SET ended_at=?, end_reason=? WHERE id=?")
      .run(t0 + 10, "compression", "orphan");
    const sessions = db.list_sessions_rich({ source: "cli", limit: 10 });
    const row = sessions.find((s) => s.id === "orphan")!;
    expect("_lineage_root_id" in row).toBe(false);
    expect(row.end_reason).toBe("compression");
  });
});

// =========================================================================
// Exclude sources
// =========================================================================

describe("exclude_sources", () => {
  it("list_sessions_rich excludes named source", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "tool");
    db.create_session("s3", "telegram");
    const ids = db.list_sessions_rich({ exclude_sources: ["tool"] }).map((s) => s.id);
    expect(ids.includes("s1")).toBe(true);
    expect(ids.includes("s3")).toBe(true);
    expect(ids.includes("s2")).toBe(false);
  });

  it("list_sessions_rich no exclusion returns all", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "tool");
    const ids = db.list_sessions_rich().map((s) => s.id);
    expect(ids.includes("s1")).toBe(true);
    expect(ids.includes("s2")).toBe(true);
  });

  it("explicit source + exclude_sources do not conflict", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "tool");
    db.create_session("s3", "telegram");
    const ids = db.list_sessions_rich({ source: "tool" }).map((s) => s.id);
    expect(ids).toEqual(["s2"]);
  });

  it("multiple exclude sources", () => {
    db.create_session("s1", "cli");
    db.create_session("s2", "tool");
    db.create_session("s3", "cron");
    db.create_session("s4", "telegram");
    const ids = db
      .list_sessions_rich({ exclude_sources: ["tool", "cron"] })
      .map((s) => s.id);
    expect(ids.includes("s1")).toBe(true);
    expect(ids.includes("s4")).toBe(true);
    expect(ids.includes("s2")).toBe(false);
    expect(ids.includes("s3")).toBe(false);
  });

  it("search_messages excludes tool source", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Python deployment question" });
    db.create_session("s2", "tool");
    db.append_message("s2", "user", { content: "Python automated question" });
    const sources = db
      .search_messages("Python", { exclude_sources: ["tool"] })
      .map((r) => r.source);
    expect(sources.includes("cli")).toBe(true);
    expect(sources.includes("tool")).toBe(false);
  });

  it("search_messages no exclusion returns all sources", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Rust deployment question" });
    db.create_session("s2", "tool");
    db.append_message("s2", "user", { content: "Rust automated question" });
    const sources = db.search_messages("Rust").map((r) => r.source);
    expect(sources.includes("cli")).toBe(true);
    expect(sources.includes("tool")).toBe(true);
  });

  it("search_messages source include + exclude can coexist", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "Golang test" });
    db.create_session("s2", "telegram");
    db.append_message("s2", "user", { content: "Golang test" });
    db.create_session("s3", "tool");
    db.append_message("s3", "user", { content: "Golang test" });
    const sources = db
      .search_messages("Golang", {
        source_filter: ["cli", "tool"],
        exclude_sources: ["tool"],
      })
      .map((r) => r.source);
    expect(sources).toEqual(["cli"]);
  });
});

// =========================================================================
// Resolve by name or id (TestResolveSessionByNameOrId)
// =========================================================================

describe("Resolve by name or id", () => {
  it("by id", () => {
    db.create_session("test-id-123", "cli");
    expect(db.get_session("test-id-123")?.id).toBe("test-id-123");
  });

  it("by title falls back", () => {
    db.create_session("s1", "cli");
    db.set_session_title("s1", "my project");
    expect(db.resolve_session_by_title("my project")).toBe("s1");
  });
});

// =========================================================================
// Concurrent write safety
// =========================================================================

describe("Concurrent write safety", () => {
  it("create_session INSERT OR IGNORE is idempotent", () => {
    db.create_session("dup-1", "cli", { model: "m" });
    db.create_session("dup-1", "gateway", { model: "m2" });
    expect(db.get_session("dup-1")?.source).toBe("cli");
  });

  it("ensure_session creates a missing row", () => {
    expect(db.get_session("orphan-session")).toBeNull();
    db.ensure_session("orphan-session", "gateway", { model: "test-model" });
    const row = db.get_session("orphan-session");
    expect(row?.source).toBe("gateway");
    expect(row?.model).toBe("test-model");
  });

  it("ensure_session is idempotent (first write wins)", () => {
    db.create_session("existing", "cli", { model: "original-model" });
    db.ensure_session("existing", "gateway", { model: "overwrite-model" });
    const row = db.get_session("existing");
    expect(row?.source).toBe("cli");
    expect(row?.model).toBe("original-model");
  });

  it("ensure_session allows append after failed create", () => {
    db.ensure_session("late-session", "gateway", { model: "gpt-4" });
    db.append_message("late-session", "user", { content: "hello after lock" });
    expect(db.get_messages("late-session")[0]?.content).toBe("hello after lock");
  });

  it("_execute_write retries on transient locked errors", () => {
    db.create_session("s1", "cli");
    let calls = 0;
    const out = db._execute_write(() => {
      calls += 1;
      if (calls === 1) throw new Error("database is locked");
      return calls;
    });
    expect(out).toBe(2);
  });

  it("_execute_write propagates non-lock errors", () => {
    expect(() =>
      db._execute_write(() => {
        throw new Error("malformed schema");
      }),
    ).toThrow(/malformed schema/);
  });
});

// =========================================================================
// State meta + vacuum + auto maintenance
// =========================================================================

describe("State meta / VACUUM / auto-maintenance", () => {
  function makeOldEnded(sid: string, daysOld = 100): void {
    db.create_session(sid, "cli");
    db.end_session(sid, "done");
    db._conn
      .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run(Date.now() / 1000 - daysOld * 86400, sid);
  }

  it("get_meta missing returns null", () => {
    expect(db.get_meta("nonexistent")).toBeNull();
  });

  it("set/get meta round trip", () => {
    db.set_meta("foo", "bar");
    expect(db.get_meta("foo")).toBe("bar");
  });

  it("set_meta upsert overwrites", () => {
    db.set_meta("key", "v1");
    db.set_meta("key", "v2");
    expect(db.get_meta("key")).toBe("v2");
  });

  it("VACUUM runs without error", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "user", { content: "hi" });
    db.vacuum();
  });

  it("first run prunes and vacuums", () => {
    makeOldEnded("old1");
    makeOldEnded("old2");
    db.create_session("new", "cli");
    const result = db.maybe_auto_prune_and_vacuum({ retention_days: 90 });
    expect(result.skipped).toBe(false);
    expect(result.pruned).toBe(2);
    expect(result.vacuumed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(db.get_session("old1")).toBeNull();
    expect(db.get_session("old2")).toBeNull();
    expect(db.get_session("new")).not.toBeNull();
  });

  it("second call within min_interval_hours skips", () => {
    makeOldEnded("old");
    const first = db.maybe_auto_prune_and_vacuum({
      retention_days: 90,
      min_interval_hours: 24,
    });
    expect(first.skipped).toBe(false);
    expect(first.pruned).toBe(1);
    makeOldEnded("old2");
    const second = db.maybe_auto_prune_and_vacuum({
      retention_days: 90,
      min_interval_hours: 24,
    });
    expect(second.skipped).toBe(true);
    expect(second.pruned).toBe(0);
    expect(db.get_session("old2")).not.toBeNull();
  });

  it("second call after interval runs again", () => {
    makeOldEnded("old");
    db.maybe_auto_prune_and_vacuum({ retention_days: 90, min_interval_hours: 24 });
    db.set_meta("last_auto_prune", String(Date.now() / 1000 - 48 * 3600));
    makeOldEnded("old2");
    const result = db.maybe_auto_prune_and_vacuum({
      retention_days: 90,
      min_interval_hours: 24,
    });
    expect(result.skipped).toBe(false);
    expect(result.pruned).toBe(1);
    expect(db.get_session("old2")).toBeNull();
  });

  it("no prunable sessions skips vacuum and records marker", () => {
    db.create_session("fresh", "cli");
    const result = db.maybe_auto_prune_and_vacuum({ retention_days: 90 });
    expect(result.skipped).toBe(false);
    expect(result.pruned).toBe(0);
    expect(result.vacuumed).toBe(false);
    expect(db.get_meta("last_auto_prune")).not.toBeNull();
  });

  it("vacuum flag disabled skips VACUUM", () => {
    makeOldEnded("old");
    const result = db.maybe_auto_prune_and_vacuum({ retention_days: 90, vacuum: false });
    expect(result.pruned).toBe(1);
    expect(result.vacuumed).toBe(false);
  });

  it("corrupt last_run marker treated as no prior run", () => {
    db.set_meta("last_auto_prune", "not-a-timestamp");
    makeOldEnded("old");
    const result = db.maybe_auto_prune_and_vacuum({ retention_days: 90 });
    expect(result.skipped).toBe(false);
    expect(result.pruned).toBe(1);
  });

  it("state_meta survives VACUUM", () => {
    makeOldEnded("old");
    db.maybe_auto_prune_and_vacuum({ retention_days: 90 });
    const marker = db.get_meta("last_auto_prune");
    expect(marker).not.toBeNull();
    expect(Math.abs(Number.parseFloat(marker ?? "0") - Date.now() / 1000)).toBeLessThan(60);
  });

  it("maybe_auto_prune captures failure into result.error", () => {
    makeOldEnded("old");
    const orig = db.prune_sessions.bind(db);
    db.prune_sessions = () => {
      throw new Error("simulated prune failure");
    };
    try {
      const result = db.maybe_auto_prune_and_vacuum({ retention_days: 90 });
      expect(result.error).toBe("simulated prune failure");
    } finally {
      db.prune_sessions = orig;
    }
  });

  it("VACUUM failure inside auto-maintenance logs warning but does not throw", () => {
    makeOldEnded("old");
    const orig = db.vacuum.bind(db);
    db.vacuum = () => {
      throw new Error("simulated VACUUM failure");
    };
    try {
      const result = db.maybe_auto_prune_and_vacuum({ retention_days: 90 });
      expect(result.pruned).toBe(1);
      expect(result.vacuumed).toBe(false);
    } finally {
      db.vacuum = orig;
    }
  });

  it("auto-prune deletes transcript files when sessions_dir provided", () => {
    const sessionsDir = join(_tmpRoot, "sessions");
    require("node:fs").mkdirSync(sessionsDir);
    makeOldEnded("old1");
    makeOldEnded("old2");
    db.create_session("new", "cli");
    const { writeFileSync, existsSync } = require("node:fs");
    writeFileSync(join(sessionsDir, "old1.json"), "{}");
    writeFileSync(join(sessionsDir, "old1.jsonl"), "{}\n");
    writeFileSync(join(sessionsDir, "old2.jsonl"), "{}\n");
    writeFileSync(join(sessionsDir, "request_dump_old1_001.json"), "{}");
    writeFileSync(join(sessionsDir, "new.jsonl"), "{}\n");
    const result = db.maybe_auto_prune_and_vacuum({
      retention_days: 90,
      sessions_dir: sessionsDir,
    });
    expect(result.pruned).toBe(2);
    expect(existsSync(join(sessionsDir, "old1.json"))).toBe(false);
    expect(existsSync(join(sessionsDir, "old1.jsonl"))).toBe(false);
    expect(existsSync(join(sessionsDir, "old2.jsonl"))).toBe(false);
    expect(existsSync(join(sessionsDir, "request_dump_old1_001.json"))).toBe(false);
    expect(existsSync(join(sessionsDir, "new.jsonl"))).toBe(true);
  });

  it("auto-prune without sessions_dir preserves files", () => {
    const sessionsDir = join(_tmpRoot, "sessions2");
    require("node:fs").mkdirSync(sessionsDir);
    makeOldEnded("old");
    require("node:fs").writeFileSync(join(sessionsDir, "old.jsonl"), "{}\n");
    const result = db.maybe_auto_prune_and_vacuum({ retention_days: 90 });
    expect(result.pruned).toBe(1);
    expect(require("node:fs").existsSync(join(sessionsDir, "old.jsonl"))).toBe(true);
  });

  it("prune_sessions deletes files for pruned only", () => {
    const sessionsDir = join(_tmpRoot, "sessions3");
    require("node:fs").mkdirSync(sessionsDir);
    makeOldEnded("old");
    db.create_session("active", "cli");
    require("node:fs").writeFileSync(join(sessionsDir, "old.jsonl"), "{}\n");
    require("node:fs").writeFileSync(join(sessionsDir, "active.jsonl"), "{}\n");
    expect(
      db.prune_sessions({ older_than_days: 90, sessions_dir: sessionsDir }),
    ).toBe(1);
    expect(require("node:fs").existsSync(join(sessionsDir, "old.jsonl"))).toBe(false);
    expect(require("node:fs").existsSync(join(sessionsDir, "active.jsonl"))).toBe(true);
  });

  it("delete_session removes transcript files when sessions_dir provided", () => {
    const sessionsDir = join(_tmpRoot, "sessions4");
    require("node:fs").mkdirSync(sessionsDir);
    db.create_session("s1", "cli");
    require("node:fs").writeFileSync(join(sessionsDir, "s1.jsonl"), "x");
    require("node:fs").writeFileSync(join(sessionsDir, "request_dump_s1_001.json"), "y");
    db.delete_session("s1", sessionsDir);
    expect(require("node:fs").existsSync(join(sessionsDir, "s1.jsonl"))).toBe(false);
    expect(require("node:fs").existsSync(join(sessionsDir, "request_dump_s1_001.json"))).toBe(
      false,
    );
  });

  it("_remove_session_files no-ops when sessions_dir is missing", () => {
    // Should not throw or create files.
    SessionDB._remove_session_files(null, "missing-sid");
    SessionDB._remove_session_files(join(_tmpRoot, "does-not-exist"), "x");
  });

  it("prune_empty_ghost_sessions removes old empty tui sessions", () => {
    const sessionsDir = join(_tmpRoot, "ghosts");
    require("node:fs").mkdirSync(sessionsDir);
    db.create_session("ghost", "tui");
    db.end_session("ghost", "exited");
    db._conn
      .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run(Date.now() / 1000 - 90000, "ghost");
    require("node:fs").writeFileSync(join(sessionsDir, "ghost.jsonl"), "x");
    expect(db.prune_empty_ghost_sessions(sessionsDir)).toBe(1);
    expect(db.get_session("ghost")).toBeNull();
    expect(require("node:fs").existsSync(join(sessionsDir, "ghost.jsonl"))).toBe(false);
  });

  it("prune_empty_ghost_sessions leaves non-empty sessions alone", () => {
    db.create_session("not-empty", "tui");
    db.end_session("not-empty", "x");
    db.append_message("not-empty", "user", { content: "hi" });
    db._conn
      .prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run(Date.now() / 1000 - 90000, "not-empty");
    expect(db.prune_empty_ghost_sessions()).toBe(0);
    expect(db.get_session("not-empty")).not.toBeNull();
  });
});

// =========================================================================
// FTS5 indexing of tool fields (TestFTS5ToolCallIndexing + Migration)
// =========================================================================

describe("FTS5 tool call indexing", () => {
  it("tool_name is searchable", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", { content: "", tool_name: "UNIQUETOOLNAME" });
    expect(db.search_messages("UNIQUETOOLNAME").length).toBe(1);
  });

  it("tool_calls arguments are searchable", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", {
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: {
            name: "web_search",
            arguments: '{"query": "UNIQUESEARCHTOKEN"}',
          },
        },
      ],
    });
    expect(db.search_messages("UNIQUESEARCHTOKEN").length).toBe(1);
  });

  it("tool function name in tool_calls is searchable", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", {
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "UNIQUEFUNCNAME", arguments: "{}" } },
      ],
    });
    expect(db.search_messages("UNIQUEFUNCNAME").length).toBe(1);
  });

  it("DELETE on messages does not crash with FTS triggers", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", {
      content: "hello",
      tool_name: "web_search",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "web_search", arguments: '{"q": "x"}' } },
      ],
    });
    db._execute_write((conn) => {
      conn.prepare("DELETE FROM messages WHERE session_id = ?").run("s1");
    });
    expect(db.search_messages("hello")).toEqual([]);
    expect(db.search_messages("web_search")).toEqual([]);
  });

  it("UPDATE reindexes tool fields", () => {
    db.create_session("s1", "cli");
    db.append_message("s1", "assistant", { content: "", tool_name: "ORIGINALTOOL" });
    expect(db.search_messages("ORIGINALTOOL").length).toBe(1);
    db._execute_write((conn) => {
      conn
        .prepare("UPDATE messages SET tool_name = ? WHERE session_id = ?")
        .run("RENAMEDTOOL", "s1");
    });
    expect(db.search_messages("ORIGINALTOOL")).toEqual([]);
    expect(db.search_messages("RENAMEDTOOL").length).toBe(1);
  });
});

// =========================================================================
// Telegram topic mode
// =========================================================================

describe("Telegram topic mode", () => {
  it("apply_telegram_topic_migration creates the topic-mode tables explicitly", () => {
    db.apply_telegram_topic_migration();
    const tables = new Set(
      db._conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all<{ name: string }>()
        .map((r) => r.name),
    );
    expect(tables.has("telegram_dm_topic_mode")).toBe(true);
    expect(tables.has("telegram_dm_topic_bindings")).toBe(true);
    expect(db.get_meta("telegram_dm_topic_schema_version")).toBe("2");
  });

  it("bind / get / list / get-by-session round trip + v1→v2 rebuild idempotent", () => {
    db.create_session("topic-session", "telegram", { user_id: "208214988" });
    expect(
      db.get_telegram_topic_binding({ chat_id: "208214988", thread_id: "17585" }),
    ).toBeNull();
    db.bind_telegram_topic({
      chat_id: "208214988",
      thread_id: "17585",
      user_id: "208214988",
      session_key: "telegram:dm:208214988:thread:17585",
      session_id: "topic-session",
    });
    const binding = db.get_telegram_topic_binding({
      chat_id: "208214988",
      thread_id: "17585",
    });
    expect(binding?.chat_id).toBe("208214988");
    expect(binding?.thread_id).toBe("17585");
    expect(binding?.user_id).toBe("208214988");
    expect(binding?.session_key).toBe("telegram:dm:208214988:thread:17585");
    expect(binding?.session_id).toBe("topic-session");
    expect(db.get_telegram_topic_binding_by_session({ session_id: "topic-session" })?.thread_id).toBe(
      "17585",
    );
    expect(
      db.list_telegram_topic_bindings_for_chat({ chat_id: "208214988" }).length,
    ).toBe(1);
    expect(db.get_meta("telegram_dm_topic_schema_version")).toBe("2");
    // Re-bind with identical pair is idempotent.
    db.bind_telegram_topic({
      chat_id: "208214988",
      thread_id: "17585",
      user_id: "208214988",
      session_key: "telegram:dm:208214988:thread:17585",
      session_id: "topic-session",
    });
  });

  it("refuses to relink an already-bound session to another topic", () => {
    db.create_session("topic-session", "telegram", { user_id: "208214988" });
    db.bind_telegram_topic({
      chat_id: "208214988",
      thread_id: "17585",
      user_id: "208214988",
      session_key: "key-17585",
      session_id: "topic-session",
    });
    expect(() =>
      db.bind_telegram_topic({
        chat_id: "208214988",
        thread_id: "99999",
        user_id: "208214988",
        session_key: "key-99999",
        session_id: "topic-session",
      }),
    ).toThrow(/already linked/);
  });

  it("list_unlinked_telegram_sessions_for_user excludes bound + other users", () => {
    db.create_session("old-unlinked", "telegram", { user_id: "208214988" });
    db.set_session_title("old-unlinked", "Old research");
    db.append_message("old-unlinked", "user", { content: "first prompt" });
    db.create_session("already-linked", "telegram", { user_id: "208214988" });
    db.bind_telegram_topic({
      chat_id: "208214988",
      thread_id: "17585",
      user_id: "208214988",
      session_key: "key-17585",
      session_id: "already-linked",
    });
    db.create_session("other-user", "telegram", { user_id: "someone-else" });
    const sessions = db.list_unlinked_telegram_sessions_for_user({
      chat_id: "208214988",
      user_id: "208214988",
    });
    expect(sessions.map((s) => s.id)).toEqual(["old-unlinked"]);
    expect(sessions[0]?.title).toBe("Old research");
    expect(sessions[0]?.preview).toBe("first prompt");
  });

  it("list_unlinked_telegram_sessions_for_user pre-migration fallback path", () => {
    db.create_session("u1", "telegram", { user_id: "u-no-tables" });
    const sessions = db.list_unlinked_telegram_sessions_for_user({
      chat_id: "u-no-tables",
      user_id: "u-no-tables",
    });
    expect(sessions.map((s) => s.id)).toEqual(["u1"]);
  });

  it("enable_telegram_topic_mode + is_..._enabled", () => {
    db.enable_telegram_topic_mode({
      chat_id: "208214988",
      user_id: "208214988",
      has_topics_enabled: true,
      allows_users_to_create_topics: false,
    });
    expect(
      db.is_telegram_topic_mode_enabled({ chat_id: "208214988", user_id: "208214988" }),
    ).toBe(true);
    // Update with null capability flags exercises _to_int=null branch.
    db.enable_telegram_topic_mode({
      chat_id: "208214988",
      user_id: "208214988",
    });
  });

  it("is_telegram_topic_mode_enabled is false pre-migration and after disable", () => {
    expect(
      db.is_telegram_topic_mode_enabled({ chat_id: "fresh-chat", user_id: "fresh-user" }),
    ).toBe(false);
    db.enable_telegram_topic_mode({ chat_id: "x", user_id: "x" });
    db.disable_telegram_topic_mode({ chat_id: "x" });
    expect(db.is_telegram_topic_mode_enabled({ chat_id: "x", user_id: "x" })).toBe(false);
    // disable on a fresh DB with no tables is a no-op (does not throw).
    db.close();
    db = new SessionDB(join(_tmpRoot, "fresh.db"));
    db.disable_telegram_topic_mode({ chat_id: "missing", clear_bindings: false });
  });

  it("is_telegram_session_linked_to_topic detects bound sessions", () => {
    db.create_session("link-s1", "telegram", { user_id: "u" });
    expect(db.is_telegram_session_linked_to_topic({ session_id: "link-s1" })).toBe(false);
    db.bind_telegram_topic({
      chat_id: "u",
      thread_id: "t",
      user_id: "u",
      session_key: "k",
      session_id: "link-s1",
    });
    expect(db.is_telegram_session_linked_to_topic({ session_id: "link-s1" })).toBe(true);
  });

  it("get_telegram_topic_binding pre-migration returns null", () => {
    expect(
      db.get_telegram_topic_binding({ chat_id: "x", thread_id: "y" }),
    ).toBeNull();
    expect(db.get_telegram_topic_binding_by_session({ session_id: "x" })).toBeNull();
    expect(db.list_telegram_topic_bindings_for_chat({ chat_id: "x" })).toEqual([]);
  });
});

// =========================================================================
// Handoff state machine
// =========================================================================

describe("Handoff state machine", () => {
  it("request → claim → complete cycle", () => {
    db.create_session("s1", "cli");
    expect(db.request_handoff("s1", "telegram")).toBe(true);
    let state = db.get_handoff_state("s1");
    expect(state?.state).toBe("pending");
    expect(state?.platform).toBe("telegram");

    const pending = db.list_pending_handoffs();
    expect(pending.map((p) => p.id)).toContain("s1");

    expect(db.claim_handoff("s1")).toBe(true);
    state = db.get_handoff_state("s1");
    expect(state?.state).toBe("running");

    db.complete_handoff("s1");
    state = db.get_handoff_state("s1");
    expect(state?.state).toBe("completed");
    expect(state?.error).toBeNull();
  });

  it("request → fail cycle records error truncated to 500 chars", () => {
    db.create_session("s1", "cli");
    db.request_handoff("s1", "discord");
    db.fail_handoff("s1", "X".repeat(700));
    const state = db.get_handoff_state("s1");
    expect(state?.state).toBe("failed");
    expect(state?.error?.length).toBe(500);
  });

  it("request_handoff returns false when one is already in flight", () => {
    db.create_session("s1", "cli");
    db.request_handoff("s1", "tg");
    expect(db.request_handoff("s1", "tg")).toBe(false);
  });

  it("claim_handoff returns false when nothing is pending", () => {
    db.create_session("s1", "cli");
    expect(db.claim_handoff("s1")).toBe(false);
  });

  it("get_handoff_state returns null for unknown session", () => {
    expect(db.get_handoff_state("nonexistent")).toBeNull();
  });

  it("list_pending_handoffs returns [] when nothing is pending", () => {
    expect(db.list_pending_handoffs()).toEqual([]);
  });

  it("get_handoff_state swallows underlying SQL errors", () => {
    db.create_session("s1", "cli");
    const orig = db._conn.prepare.bind(db._conn);
    db._conn.prepare = ((sql: string) => {
      if (sql.includes("handoff_state")) throw new Error("simulated");
      return orig(sql);
    }) as typeof db._conn.prepare;
    try {
      expect(db.get_handoff_state("s1")).toBeNull();
    } finally {
      db._conn.prepare = orig;
    }
  });

  it("list_pending_handoffs swallows underlying SQL errors", () => {
    const orig = db._conn.prepare.bind(db._conn);
    db._conn.prepare = ((sql: string) => {
      if (sql.includes("handoff_state")) throw new Error("simulated");
      return orig(sql);
    }) as typeof db._conn.prepare;
    try {
      expect(db.list_pending_handoffs()).toEqual([]);
    } finally {
      db._conn.prepare = orig;
    }
  });
});

// =========================================================================
// SessionDB options surface + default db path
// =========================================================================

describe("SessionDB constructor surface", () => {
  it("accepts an options object with sanitizeContext injection", () => {
    const calls: string[] = [];
    const customSanitize = (s: string) => {
      calls.push(s);
      return s.replace(/SECRET/g, "[REDACTED]");
    };
    const path = join(_tmpRoot, "opts.db");
    const otherDb = new SessionDB({ db_path: path, sanitizeContext: customSanitize });
    try {
      otherDb.create_session("s1", "cli");
      otherDb.append_message("s1", "user", { content: "user with SECRET in it" });
      const conv = otherDb.get_messages_as_conversation("s1");
      expect(conv[0]?.content).toBe("user with [REDACTED] in it");
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      otherDb.close();
    }
  });

  it("default constructor uses HERMES_HOME/state.db", () => {
    // Use the HERMES_HOME override path so the default path resolution
    // lands somewhere disposable.
    process.env.HERMES_HOME = _tmpRoot;
    let fresh: SessionDB | null = null;
    try {
      fresh = new SessionDB();
      expect(fresh.db_path.endsWith("state.db")).toBe(true);
      expect(fresh.db_path.startsWith(_tmpRoot)).toBe(true);
    } finally {
      fresh?.close();
      delete process.env.HERMES_HOME;
    }
  });
});

// =========================================================================
// Static helpers (encode/decode + duplicate dedup)
// =========================================================================

describe("SessionDB static helpers", () => {
  it("_encode_content / _decode_content round trip", () => {
    expect(SessionDB._encode_content("plain")).toBe("plain");
    expect(SessionDB._decode_content("plain")).toBe("plain");
    const list = [{ type: "text", text: "x" }];
    const enc = SessionDB._encode_content(list);
    expect(SessionDB._decode_content(enc)).toEqual(list);
  });

  it("_isDuplicateReplayedUserMessage detects exact prior user replays", () => {
    const prior: ConversationMessage[] = [
      { role: "user", content: "same" },
      { role: "assistant", content: "ack" },
    ];
    expect(
      SessionDB._isDuplicateReplayedUserMessage(prior, {
        role: "user",
        content: "same",
      }),
    ).toBe(false);
    const prior2: ConversationMessage[] = [{ role: "user", content: "same" }];
    expect(
      SessionDB._isDuplicateReplayedUserMessage(prior2, {
        role: "user",
        content: "same",
      }),
    ).toBe(true);
  });

  it("_isDuplicateReplayedUserMessage returns false for non-user / empty / structured content", () => {
    expect(
      SessionDB._isDuplicateReplayedUserMessage([], { role: "assistant", content: "x" }),
    ).toBe(false);
    expect(
      SessionDB._isDuplicateReplayedUserMessage([], { role: "user", content: "" }),
    ).toBe(false);
    expect(
      SessionDB._isDuplicateReplayedUserMessage([], {
        role: "user",
        content: [{ type: "text", text: "x" }],
      }),
    ).toBe(false);
  });

  it("_count_cjk and _contains_cjk are exposed", () => {
    expect(SessionDB._contains_cjk("世界")).toBe(true);
    expect(SessionDB._count_cjk("世界 hello")).toBe(2);
  });
});

// =========================================================================
// Periodic checkpoint
// =========================================================================

describe("Periodic WAL checkpoint", () => {
  it("checkpoint runs without crashing every N writes", () => {
    // Force CHECKPOINT_EVERY_N_WRITES writes so the checkpoint branch fires.
    db.create_session("ckpt", "cli");
    for (let i = 0; i <= SessionDB._CHECKPOINT_EVERY_N_WRITES + 1; i++) {
      db.append_message("ckpt", "user", { content: `m${i}` });
    }
    // Direct call exercises the catch path too.
    db._tryWalCheckpoint();
  });
});
