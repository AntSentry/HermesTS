// Ported from upstream test_hermes_state.py (`test_sanitize_fts5_*` cases).
import { describe, expect, it } from "vitest";
import { _sanitizeFts5Query } from "../src/fts5.js";
import { SessionDB } from "../src/session-db.js";

describe("_sanitizeFts5Query", () => {
  it("strips FTS5-dangerous chars", () => {
    expect(_sanitizeFts5Query("hello world")).toBe("hello world");
    expect(_sanitizeFts5Query("C++")).not.toContain("+");
    expect(_sanitizeFts5Query('"unterminated')).not.toContain('"');
    expect(_sanitizeFts5Query("(problem")).not.toContain("(");
    expect(_sanitizeFts5Query("{test}")).not.toContain("{");
  });

  it("removes dangling boolean operators", () => {
    expect(_sanitizeFts5Query("hello AND")).toBe("hello");
    expect(_sanitizeFts5Query("OR world")).toBe("world");
  });

  it("removes leading bare wildcard", () => {
    expect(_sanitizeFts5Query("***")).toBe("");
  });

  it("preserves trailing prefix wildcard", () => {
    expect(_sanitizeFts5Query("deploy*")).toBe("deploy*");
  });

  it("preserves balanced quoted phrases", () => {
    expect(_sanitizeFts5Query('"exact phrase"')).toBe('"exact phrase"');
    expect(_sanitizeFts5Query('"docker networking" setup')).toContain(
      '"docker networking"',
    );
    const multi = _sanitizeFts5Query('"hello world" OR "foo bar"');
    expect(multi).toContain('"hello world"');
    expect(multi).toContain('"foo bar"');
  });

  it("quotes hyphenated terms", () => {
    expect(_sanitizeFts5Query("chat-send")).toBe('"chat-send"');
    expect(_sanitizeFts5Query("docker-compose-up")).toBe('"docker-compose-up"');
    const r = _sanitizeFts5Query("fix chat-send bug");
    expect(r).toContain('"chat-send"');
    expect(r).toContain("fix");
    expect(r).toContain("bug");
    const r2 = _sanitizeFts5Query("chat-send OR deploy-prod");
    expect(r2).toContain('"chat-send"');
    expect(r2).toContain('"deploy-prod"');
    // already quoted — no double quoting
    expect(_sanitizeFts5Query('"chat-send"')).toBe('"chat-send"');
    // inside quoted phrase
    expect(_sanitizeFts5Query('"my chat-send thing"')).toBe(
      '"my chat-send thing"',
    );
  });

  it("quotes dotted terms", () => {
    expect(_sanitizeFts5Query("P2.2")).toBe('"P2.2"');
    expect(_sanitizeFts5Query("simulate.p2")).toBe('"simulate.p2"');
    expect(_sanitizeFts5Query("simulate.p2.test.ts")).toBe('"simulate.p2.test.ts"');
    expect(_sanitizeFts5Query('"P2.2"')).toBe('"P2.2"');
    const r = _sanitizeFts5Query("P2.2 OR simulate.p2");
    expect(r).toContain('"P2.2"');
    expect(r).toContain('"simulate.p2"');
    // Mixed dots and hyphens — single pass avoids double-quoting
    expect(_sanitizeFts5Query("my-app.config")).toBe('"my-app.config"');
    expect(_sanitizeFts5Query("my-app.config.ts")).toBe('"my-app.config.ts"');
  });

  it("quotes underscored terms", () => {
    expect(_sanitizeFts5Query("sp_new")).toBe('"sp_new"');
    expect(_sanitizeFts5Query("a_b_c")).toBe('"a_b_c"');
    expect(_sanitizeFts5Query("sp_new1")).toBe('"sp_new1"');
    expect(_sanitizeFts5Query("docker-compose_up")).toBe('"docker-compose_up"');
    expect(_sanitizeFts5Query("my.app_config.ts")).toBe('"my.app_config.ts"');
    expect(_sanitizeFts5Query('"sp_new"')).toBe('"sp_new"');
    const r = _sanitizeFts5Query("sp_new and 血管瘤");
    expect(r).toContain('"sp_new"');
    expect(r).toContain("血管瘤");
  });

  it("is exposed as a static SessionDB helper for upstream parity", () => {
    expect(SessionDB._sanitize_fts5_query("hello world")).toBe("hello world");
  });
});
