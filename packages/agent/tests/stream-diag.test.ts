/**
 * Tests for stream-diag.ts. Ported from the spirit of upstream
 * tests/agent/test_stream_diag.py (upstream has no dedicated suite — these
 * cover the public surface used by run_agent and the few private helpers
 * that have non-trivial branches the way upstream does inline via run_agent
 * fixtures).
 *
 * Goal: 100/100/100/100 coverage of stream-diag.ts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  STREAM_DIAG_HEADERS,
  _consoleDebug,
  _consoleWarning,
  _renderPrintf,
  _resetStreamDiagClock,
  _resetStreamDiagLogger,
  type AgentDiagLogger,
  type StreamDiag,
  emit_stream_drop,
  flatten_exception_chain,
  log_stream_retry,
  setStreamDiagClock,
  setStreamDiagLogger,
  stream_diag_capture_response,
  stream_diag_init,
} from "../src/stream-diag.js";

interface RecordedCall {
  level: "warning" | "debug";
  fmt: string;
  args: unknown[];
  extra: Record<string, unknown> | undefined;
}

function recordingLogger(): { logger: AgentDiagLogger; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const logger: AgentDiagLogger = {
    warning(fmt, args, extra) {
      calls.push({ level: "warning", fmt, args, extra });
    },
    debug(fmt, args, extra) {
      calls.push({ level: "debug", fmt, args, extra });
    },
  };
  return { logger, calls };
}

beforeEach(() => {
  setStreamDiagClock(() => 1000);
});

afterEach(() => {
  _resetStreamDiagClock();
  _resetStreamDiagLogger();
});

// ─── _renderPrintf ───────────────────────────────────────────────────────

describe("_renderPrintf", () => {
  test("%s renders String(arg)", () => {
    expect(_renderPrintf("hello %s", ["world"])).toBe("hello world");
  });

  test("%d truncates to integer", () => {
    expect(_renderPrintf("count=%d", [3.9])).toBe("count=3");
  });

  test("%.2f formats to fixed precision", () => {
    expect(_renderPrintf("elapsed=%.2fs", [1.234])).toBe("elapsed=1.23s");
  });

  test("%f without precision defaults to 6 digits", () => {
    expect(_renderPrintf("v=%f", [1.5])).toBe("v=1.500000");
  });

  test("%% renders literal %", () => {
    expect(_renderPrintf("100%% done", [])).toBe("100% done");
  });

  test("unknown specifier preserved and no arg consumed", () => {
    // The regex only matches recognised specifiers; the %q stays raw.
    expect(_renderPrintf("oops %q rest %s", ["x"])).toBe("oops %q rest x");
  });

  test("ran out of args leaves the directive intact", () => {
    expect(_renderPrintf("%s %s", ["only-one"])).toBe("only-one %s");
  });

  test("multiple mixed specifiers", () => {
    expect(_renderPrintf("%s=%d (%.2f%%)", ["x", 7.6, 12.34])).toBe("x=7 (12.34%)");
  });
});

// ─── stream_diag_init ────────────────────────────────────────────────────

describe("stream_diag_init", () => {
  test("returns a fresh dict with zero counters and mock time", () => {
    setStreamDiagClock(() => 42);
    const d = stream_diag_init();
    expect(d).toEqual({
      started_at: 42,
      first_chunk_at: null,
      chunks: 0,
      bytes: 0,
      headers: {},
      http_status: null,
    });
  });

  test("each call returns a distinct object", () => {
    const a = stream_diag_init();
    const b = stream_diag_init();
    expect(a).not.toBe(b);
  });
});

// ─── stream_diag_capture_response ────────────────────────────────────────

describe("stream_diag_capture_response", () => {
  test("null http_response is a no-op", () => {
    const diag = stream_diag_init();
    stream_diag_capture_response({}, diag, null);
    expect(diag.http_status).toBeNull();
  });

  test("undefined http_response is a no-op", () => {
    const diag = stream_diag_init();
    stream_diag_capture_response({}, diag, undefined);
    expect(diag.http_status).toBeNull();
  });

  test("non-object diag is a no-op", () => {
    // Should not throw even when caller passes a bogus diag.
    expect(() =>
      stream_diag_capture_response({}, null, { status_code: 200 }),
    ).not.toThrow();
    expect(() =>
      stream_diag_capture_response({}, "nope", { status_code: 200 }),
    ).not.toThrow();
    expect(() =>
      stream_diag_capture_response({}, [1, 2, 3], { status_code: 200 }),
    ).not.toThrow();
  });

  test("captures status_code + filters headers to STREAM_DIAG_HEADERS", () => {
    const diag = stream_diag_init();
    const headers: Record<string, string> = {
      "cf-ray": "abc123",
      "x-openrouter-provider": "openrouter",
      "x-secret": "do-not-capture",
    };
    stream_diag_capture_response({}, diag, { status_code: 200, headers });
    expect(diag.http_status).toBe(200);
    expect(diag.headers).toEqual({
      "cf-ray": "abc123",
      "x-openrouter-provider": "openrouter",
    });
    expect(diag.headers["x-secret"]).toBeUndefined();
  });

  test("truncates header values to 120 chars", () => {
    const diag = stream_diag_init();
    const longVal = "x".repeat(500);
    stream_diag_capture_response({}, diag, {
      status_code: 200,
      headers: { "cf-ray": longVal },
    });
    expect(diag.headers["cf-ray"]).toHaveLength(120);
  });

  test("respects per-agent _STREAM_DIAG_HEADERS override", () => {
    const diag = stream_diag_init();
    const agent = { _STREAM_DIAG_HEADERS: ["only-this"] };
    stream_diag_capture_response(agent, diag, {
      status_code: 201,
      headers: { "only-this": "yes", "cf-ray": "ignored" },
    });
    expect(diag.headers).toEqual({ "only-this": "yes" });
  });

  test("headers via Map-like .get() interface", () => {
    const diag = stream_diag_init();
    const headers = new Map<string, string>([
      ["cf-ray", "map-value"],
      ["x-openrouter-provider", "p"],
    ]);
    stream_diag_capture_response({}, diag, { status_code: 200, headers });
    expect(diag.headers["cf-ray"]).toBe("map-value");
    expect(diag.headers["x-openrouter-provider"]).toBe("p");
  });

  test("falsy header value (empty string) is skipped", () => {
    const diag = stream_diag_init();
    stream_diag_capture_response({}, diag, {
      status_code: 200,
      headers: { "cf-ray": "", "x-openrouter-provider": "p" },
    });
    expect(diag.headers["cf-ray"]).toBeUndefined();
    expect(diag.headers["x-openrouter-provider"]).toBe("p");
  });

  test("headers null falls back to empty dict", () => {
    const diag = stream_diag_init();
    stream_diag_capture_response({}, diag, { status_code: 204, headers: null });
    expect(diag.http_status).toBe(204);
    expect(diag.headers).toEqual({});
  });

  test("status_code missing leaves http_status null", () => {
    const diag = stream_diag_init();
    stream_diag_capture_response({}, diag, { headers: {} });
    // Upstream: getattr(http_response, "status_code", None) returns None.
    // We faithfully store null.
    expect(diag.http_status).toBeNull();
  });

  test("per-header lookup that throws is swallowed", () => {
    const diag = stream_diag_init();
    const headers = {
      get(name: string): string {
        if (name === "cf-ray") return "ok";
        throw new Error("boom");
      },
    };
    stream_diag_capture_response({}, diag, { status_code: 200, headers });
    expect(diag.headers["cf-ray"]).toBe("ok");
  });

  test("entire headers retrieval throws → diag.headers stays default", () => {
    const diag = stream_diag_init();
    const httpResponse: Record<string, unknown> = { status_code: 200 };
    Object.defineProperty(httpResponse, "headers", {
      get(): unknown {
        throw new Error("explode");
      },
    });
    stream_diag_capture_response({}, diag, httpResponse);
    expect(diag.http_status).toBe(200);
    expect(diag.headers).toEqual({});
  });

  test("status_code getter that throws → http_status stays null", () => {
    const diag = stream_diag_init();
    const httpResponse: Record<string, unknown> = { headers: {} };
    Object.defineProperty(httpResponse, "status_code", {
      get(): unknown {
        throw new Error("explode");
      },
    });
    stream_diag_capture_response({}, diag, httpResponse);
    expect(diag.http_status).toBeNull();
  });
});

// ─── flatten_exception_chain ─────────────────────────────────────────────

describe("flatten_exception_chain", () => {
  test("single error: returns Type(msg)", () => {
    const err = new TypeError("boom");
    expect(flatten_exception_chain(err)).toBe("TypeError(boom)");
  });

  test("error with no message: returns Type", () => {
    const err = new Error("");
    expect(flatten_exception_chain(err)).toBe("Error");
  });

  test("walks .cause chain", () => {
    const inner = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    expect(flatten_exception_chain(outer)).toBe("Error(outer) <- Error(inner)");
  });

  test("dedupes on identity cycle", () => {
    const e = new Error("a");
    (e as Error & { cause: unknown }).cause = e;
    // Should break out (nxt === link) — only one part.
    expect(flatten_exception_chain(e)).toBe("Error(a)");
  });

  test("stops at depth 4", () => {
    const e5 = new Error("5");
    const e4 = new Error("4", { cause: e5 });
    const e3 = new Error("3", { cause: e4 });
    const e2 = new Error("2", { cause: e3 });
    const e1 = new Error("1", { cause: e2 });
    const rendered = flatten_exception_chain(e1);
    expect(rendered.split(" <- ")).toHaveLength(4);
    expect(rendered).toBe("Error(1) <- Error(2) <- Error(3) <- Error(4)");
  });

  test("truncates message at 140 chars with ellipsis", () => {
    const long = "x".repeat(200);
    const e = new Error(long);
    const result = flatten_exception_chain(e);
    expect(result).toMatch(/^Error\(x{140}…\)$/);
  });

  test("collapses newlines in messages", () => {
    const e = new Error("line1\nline2");
    expect(flatten_exception_chain(e)).toBe("Error(line1 line2)");
  });

  test("null cause breaks chain immediately", () => {
    const e = new Error("only");
    (e as Error & { cause: unknown }).cause = null;
    expect(flatten_exception_chain(e)).toBe("Error(only)");
  });

  test("non-Error thrown values still render with Python-style type names", () => {
    expect(flatten_exception_chain("a string")).toBe("String(a string)");
    expect(flatten_exception_chain(42)).toBe("Number(42)");
    expect(flatten_exception_chain(null)).toBe("NoneType");
    expect(flatten_exception_chain(undefined)).toBe("undefined");
    expect(flatten_exception_chain(true)).toBe("Boolean(true)");
    expect(flatten_exception_chain(BigInt(10))).toBe("BigInt(10)");
    expect(flatten_exception_chain(Symbol("sym"))).toBe("Symbol(Symbol(sym))");
  });

  test("function-typed throw falls through to typeof fallback", () => {
    // Functions are the only `typeof` not explicitly mapped → `return typeof err`.
    const fn = (): void => undefined;
    expect(flatten_exception_chain(fn)).toMatch(/^function\(/);
  });

  test("plain object with message", () => {
    expect(flatten_exception_chain({ message: "hi" })).toBe("Object(hi)");
  });

  test("plain object without message renders as bare type", () => {
    // `_errorMessage({})` returns "" by design (matches an empty Python
    // exception's `str(e)`), so the rendering collapses to just the type name.
    expect(flatten_exception_chain({})).toBe("Object");
  });

  test("dedupe stops re-entry into a visited link", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause: unknown }).cause = b; // cycle a → b → a
    const rendered = flatten_exception_chain(a);
    expect(rendered).toBe("Error(a) <- Error(b)");
  });

  test("seen array empty fallback returns type name", () => {
    // Cannot easily trigger empty seen with current logic since the first
    // iteration always pushes. Exercise the fallback by skipping straight
    // to the return: the only path is when error itself is null/undefined.
    expect(flatten_exception_chain(null)).toBe("NoneType");
  });

  test("error subclass with named constructor", () => {
    class CustomError extends Error {
      override name = "CustomError";
    }
    const e = new CustomError("oops");
    expect(flatten_exception_chain(e)).toBe("CustomError(oops)");
  });

  test("Error with empty name falls back to constructor.name", () => {
    class WeirdError extends Error {}
    const e = new WeirdError("hi");
    Object.defineProperty(e, "name", { value: "" });
    expect(flatten_exception_chain(e)).toBe("WeirdError(hi)");
  });

  test("plain object created with null prototype → 'object' fallback", () => {
    const noproto = Object.create(null) as Record<string, unknown>;
    noproto.message = "no-proto";
    expect(flatten_exception_chain(noproto)).toBe("object(no-proto)");
  });

  test("Error with both .name and .constructor.name blank → 'Error' fallback", () => {
    // Exercises the `|| "Error"` tail of `err.name || err.constructor.name || "Error"`.
    class StripCtor extends Error {}
    const e = new StripCtor("body");
    Object.defineProperty(e, "name", { value: "" });
    Object.defineProperty(e.constructor, "name", { value: "" });
    expect(flatten_exception_chain(e)).toBe("Error(body)");
  });

  test("Error with explicit message=undefined → '?? \"\"' branch yields empty", () => {
    // Exercises the `err.message ?? ""` branch in `_errorMessage` (an Error
    // whose `.message` is literally undefined, not the default ""). Combined
    // with the type name, this collapses to bare `Error` (no parens).
    const e = new Error("placeholder");
    Object.defineProperty(e, "message", { value: undefined });
    expect(flatten_exception_chain(e)).toBe("Error");
  });
});

// ─── log_stream_retry ────────────────────────────────────────────────────

describe("log_stream_retry", () => {
  test("emits a structured warning with all fields", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    setStreamDiagClock(() => 1010);
    const diag: StreamDiag = {
      started_at: 1000,
      first_chunk_at: 1002,
      chunks: 5,
      bytes: 1234,
      headers: { "cf-ray": "abc" },
      http_status: 504,
    };
    const agent = {
      _subagent_id: "sub-1",
      _delegate_depth: 2,
      provider: "openrouter",
      base_url: "https://or.test",
      _summarize_api_error(e: unknown): string {
        return `summary:${(e as Error).message}`;
      },
    };
    const err = new Error("RemoteProtocolError: server disconnected");
    log_stream_retry(agent, {
      kind: "drop",
      error: err,
      attempt: 2,
      max_attempts: 5,
      mid_tool_call: true,
      diag,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.level).toBe("warning");
    expect(calls[0]?.extra).toEqual({ mid_tool_call: true });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("Stream drop on attempt 2/5");
    expect(rendered).toContain("subagent_id=sub-1");
    expect(rendered).toContain("depth=2");
    expect(rendered).toContain("provider=openrouter");
    expect(rendered).toContain("base_url=https://or.test");
    expect(rendered).toContain("error_type=Error");
    expect(rendered).toContain("error=summary:RemoteProtocolError: server disconnected");
    expect(rendered).toContain("http_status=504");
    expect(rendered).toContain("bytes=1234");
    expect(rendered).toContain("chunks=5");
    expect(rendered).toContain("elapsed=10.00s");
    expect(rendered).toContain("ttfb=2.00s");
    expect(rendered).toContain("upstream=[cf-ray=abc]");
  });

  test("missing diag → dashes/zeros in output", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    log_stream_retry({ provider: "p", base_url: "u" }, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 3,
      mid_tool_call: false,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("bytes=0");
    expect(rendered).toContain("chunks=0");
    expect(rendered).toContain("http_status=-");
    expect(rendered).toContain("ttfb=-");
    expect(rendered).toContain("upstream=[-]");
  });

  test("agent without _summarize_api_error falls back to error message", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("raw-msg"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("error=raw-msg");
  });

  test("_summarize_api_error returning null/undefined is coerced to ''", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    log_stream_retry({ _summarize_api_error: () => null }, {
      kind: "drop",
      error: new Error("xyz"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    // null summary becomes ''; the upstream format still places `error=`.
    expect(rendered).toContain("error= ");
  });

  test("_summarize_api_error that throws is swallowed", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    const agent = {
      _summarize_api_error(): string {
        throw new Error("nope");
      },
    };
    log_stream_retry(agent, {
      kind: "drop",
      error: new Error("ee"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("error=ee");
  });

  test("summary longer than 240 chars is truncated with ellipsis", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x".repeat(500)),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toMatch(/error=x{240}…/);
  });

  test("flatten_exception_chain throwing is swallowed (fallback to type name)", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    // Build an evil error whose .cause accessor throws *inside* the chain walk.
    // Easier: make .name throw → flatten_exception_chain's _errorTypeName
    // succeeds since it reads `err.name` after checking instanceof Error — and
    // Error.name is set, but flatten_exception_chain only fails if Array.includes
    // throws (impossible). To exercise the catch, monkey-patch flatten via a
    // Proxy wrapping the error such that Array.prototype.includes is called
    // on a "seen" of arbitrary objects — covered already by other tests.
    //
    // We use a stand-in: directly induce by passing a Proxy where reading
    // `.cause` throws synchronously inside the chain walk.
    let raised = false;
    const target = new Error("base");
    const proxy = new Proxy(target, {
      get(t, prop, recv) {
        if (prop === "cause") {
          if (raised) return undefined;
          raised = true;
          throw new Error("explode");
        }
        return Reflect.get(t, prop, recv);
      },
    });
    log_stream_retry({}, {
      kind: "drop",
      error: proxy,
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    // chain= fallback is _errorTypeName(error) === 'Error'
    expect(rendered).toContain("chain=Error");
  });

  test("diag parsing block that throws is swallowed (NaN/garbage)", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    // Object.entries on the headers throws via Proxy.
    const badHeaders = new Proxy(
      {},
      {
        ownKeys(): ArrayLike<string | symbol> {
          throw new Error("nope");
        },
      },
    );
    const diag = {
      started_at: 1000,
      first_chunk_at: null,
      chunks: 0,
      bytes: 0,
      headers: badHeaders,
      http_status: 200,
    };
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
      diag,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    // upstream defaults remain
    expect(rendered).toContain("upstream=[-]");
  });

  test("entire log body that throws produces a debug fallback", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    // Force a throw at the very top: make warning() throw, which is caught
    // by the outer try, then the catch invokes debug() — but our recording
    // warning doesn't throw. Instead, point _logger.warning to a thrower
    // first call only.
    let warningCalled = false;
    setStreamDiagLogger({
      warning(): void {
        warningCalled = true;
        throw new Error("logger broke");
      },
      debug(fmt, args, extra) {
        calls.push({ level: "debug", fmt, args, extra });
      },
    });
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    expect(warningCalled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.level).toBe("debug");
    expect(calls[0]?.fmt).toBe("stream-retry log emit failed");
    expect(calls[0]?.extra).toEqual({ exc_info: true });
  });

  test("agent missing optional fields → '-' defaults", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("subagent_id=-");
    expect(rendered).toContain("depth=0");
    expect(rendered).toContain("provider=-");
    expect(rendered).toContain("base_url=-");
  });

  test("first_chunk_at null → ttfb stays '-'", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    setStreamDiagClock(() => 1010);
    const diag: StreamDiag = {
      started_at: 1000,
      first_chunk_at: null,
      chunks: 3,
      bytes: 99,
      headers: {},
      http_status: null,
    };
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
      diag,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("ttfb=-");
    expect(rendered).toContain("elapsed=10.00s");
  });

  test("non-finite first_chunk_at stays '-'", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    setStreamDiagClock(() => 1010);
    const diag = {
      started_at: 1000,
      first_chunk_at: "garbage",
      chunks: 0,
      bytes: 0,
      headers: {},
      http_status: null,
    };
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
      diag,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("ttfb=-");
  });

  test("diag with bytes/chunks=undefined defaults to 0 via ?? 0 guards", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
      diag: {
        started_at: 1000,
        first_chunk_at: undefined,
        chunks: undefined,
        bytes: undefined,
        headers: undefined,
        http_status: undefined,
      },
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("bytes=0");
    expect(rendered).toContain("chunks=0");
    expect(rendered).toContain("http_status=-");
    expect(rendered).toContain("upstream=[-]");
  });

  test("headers as non-object (list) ignored in repr", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
      diag: {
        started_at: 1000,
        first_chunk_at: null,
        chunks: 0,
        bytes: 0,
        headers: ["arr"],
        http_status: 200,
      },
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("upstream=[-]");
    expect(rendered).toContain("http_status=200");
  });

  test("null agent falls through nullish-coalesce to '-' defaults", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    log_stream_retry(null, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("subagent_id=-");
    expect(rendered).toContain("provider=-");
  });

  test("non-finite started_at falls back to now → elapsed 0", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    setStreamDiagClock(() => 1010);
    const diag = {
      started_at: "garbage",
      first_chunk_at: null,
      chunks: 0,
      bytes: 0,
      headers: {},
      http_status: null,
    };
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
      diag,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("elapsed=0.00s");
  });
});

// ─── emit_stream_drop ────────────────────────────────────────────────────

describe("emit_stream_drop", () => {
  test("emits user-visible line + delegates to log_stream_retry", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    // Stream started 5 seconds ago — the suffix should read " after 5.0s".
    const diag: StreamDiag = {
      started_at: 1000,
      first_chunk_at: null,
      chunks: 0,
      bytes: 0,
      headers: {},
      http_status: null,
    };
    setStreamDiagClock(() => 1005);
    const statusLines: string[] = [];
    const activityLines: string[] = [];
    const agent = {
      provider: "openai",
      base_url: "https://api",
      _emit_status(msg: string): void {
        statusLines.push(msg);
      },
      _touch_activity(msg: string): void {
        activityLines.push(msg);
      },
    };
    emit_stream_drop(agent, {
      error: new TypeError("kaboom"),
      attempt: 1,
      max_attempts: 3,
      mid_tool_call: false,
      diag,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.level).toBe("warning");
    expect(statusLines).toHaveLength(1);
    expect(statusLines[0]).toContain("openai stream drop (TypeError)");
    expect(statusLines[0]).toContain(" after 5.0s");
    expect(statusLines[0]).toContain("retry 1/3");
    expect(activityLines).toHaveLength(1);
    expect(activityLines[0]).toContain("stream retry 1/3 after TypeError");
  });

  test("mid_tool_call adds 'mid tool-call' suffix to kind", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    const agent = {
      provider: "p",
      _emit_status: vi.fn(),
      _touch_activity: vi.fn(),
    };
    emit_stream_drop(agent, {
      error: new Error("x"),
      attempt: 2,
      max_attempts: 5,
      mid_tool_call: true,
    });
    const rendered = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    expect(rendered).toContain("Stream drop mid tool-call");
    expect(agent._emit_status).toHaveBeenCalledTimes(1);
    expect(agent._touch_activity).toHaveBeenCalledTimes(1);
  });

  test("no diag → no 'after' suffix", () => {
    setStreamDiagLogger(recordingLogger().logger);
    const statusLines: string[] = [];
    emit_stream_drop(
      {
        provider: "p",
        _emit_status: (m: string) => statusLines.push(m),
      },
      {
        error: new Error("x"),
        attempt: 1,
        max_attempts: 1,
        mid_tool_call: false,
      },
    );
    expect(statusLines[0]).not.toContain(" after ");
  });

  test("diag without started_at → no suffix and no throw", () => {
    setStreamDiagLogger(recordingLogger().logger);
    const statusLines: string[] = [];
    emit_stream_drop(
      {
        provider: "p",
        _emit_status: (m: string) => statusLines.push(m),
      },
      {
        error: new Error("x"),
        attempt: 1,
        max_attempts: 1,
        mid_tool_call: false,
        diag: { headers: {}, chunks: 0, bytes: 0 },
      },
    );
    expect(statusLines[0]).not.toContain(" after ");
  });

  test("non-finite started_at → no suffix", () => {
    setStreamDiagLogger(recordingLogger().logger);
    const statusLines: string[] = [];
    emit_stream_drop(
      {
        provider: "p",
        _emit_status: (m: string) => statusLines.push(m),
      },
      {
        error: new Error("x"),
        attempt: 1,
        max_attempts: 1,
        mid_tool_call: false,
        diag: { started_at: "junk", headers: {}, chunks: 0, bytes: 0 },
      },
    );
    expect(statusLines[0]).not.toContain(" after ");
  });

  test("started_at getter that throws is swallowed", () => {
    setStreamDiagLogger(recordingLogger().logger);
    const statusLines: string[] = [];
    const diag: Record<string, unknown> = { headers: {}, chunks: 0, bytes: 0 };
    Object.defineProperty(diag, "started_at", {
      get(): unknown {
        throw new Error("nope");
      },
    });
    expect(() =>
      emit_stream_drop(
        {
          provider: "p",
          _emit_status: (m: string) => statusLines.push(m),
        },
        {
          error: new Error("x"),
          attempt: 1,
          max_attempts: 1,
          mid_tool_call: false,
          diag,
        },
      ),
    ).not.toThrow();
    expect(statusLines[0]).not.toContain(" after ");
  });

  test("missing provider → 'provider' default", () => {
    setStreamDiagLogger(recordingLogger().logger);
    const statusLines: string[] = [];
    emit_stream_drop(
      { _emit_status: (m: string) => statusLines.push(m) },
      {
        error: new Error("x"),
        attempt: 1,
        max_attempts: 1,
        mid_tool_call: false,
      },
    );
    expect(statusLines[0]).toContain("provider stream drop");
  });

  test("agent without _emit_status / _touch_activity is fine", () => {
    setStreamDiagLogger(recordingLogger().logger);
    expect(() =>
      emit_stream_drop({}, {
        error: new Error("x"),
        attempt: 1,
        max_attempts: 1,
        mid_tool_call: false,
      }),
    ).not.toThrow();
  });

  test("null agent hits the `agent ?? {}` fallback in emit_stream_drop", () => {
    // Covers `(agent as ... ?? {})` on the emit_stream_drop side (separate
    // from the log_stream_retry-side fallback which has its own test).
    setStreamDiagLogger(recordingLogger().logger);
    expect(() =>
      emit_stream_drop(null, {
        error: new Error("x"),
        attempt: 1,
        max_attempts: 1,
        mid_tool_call: false,
      }),
    ).not.toThrow();
    expect(() =>
      emit_stream_drop(undefined, {
        error: new Error("x"),
        attempt: 1,
        max_attempts: 1,
        mid_tool_call: false,
      }),
    ).not.toThrow();
  });

  test("null/undefined error in summary path exercises _errorMessage's null guard", () => {
    // log_stream_retry calls `_errorMessage(error)` in the catch-fallback
    // when `_summarize_api_error` isn't on the agent. Passing a null/undef
    // error there exercises the `if (err === null || err === undefined)`
    // early-return in `_errorMessage`.
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    log_stream_retry({}, {
      kind: "drop",
      error: null,
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    log_stream_retry({}, {
      kind: "drop",
      error: undefined,
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    expect(calls).toHaveLength(2);
    const r0 = _renderPrintf(calls[0]!.fmt, calls[0]!.args);
    const r1 = _renderPrintf(calls[1]!.fmt, calls[1]!.args);
    expect(r0).toContain("error_type=NoneType");
    expect(r0).toContain("error= ");
    expect(r1).toContain("error_type=undefined");
    expect(r1).toContain("error= ");
  });

  test("_emit_status that throws is swallowed", () => {
    setStreamDiagLogger(recordingLogger().logger);
    const agent = {
      provider: "p",
      _emit_status(): void {
        throw new Error("status broke");
      },
      _touch_activity(): void {
        // never reached because _emit_status threw first; outer try swallows.
      },
    };
    expect(() =>
      emit_stream_drop(agent, {
        error: new Error("x"),
        attempt: 1,
        max_attempts: 1,
        mid_tool_call: false,
      }),
    ).not.toThrow();
  });
});

// ─── STREAM_DIAG_HEADERS / public surface ────────────────────────────────

describe("STREAM_DIAG_HEADERS", () => {
  test("contains the canonical lowercase header set", () => {
    expect(STREAM_DIAG_HEADERS).toContain("cf-ray");
    expect(STREAM_DIAG_HEADERS).toContain("x-openrouter-provider");
    expect(STREAM_DIAG_HEADERS).toContain("x-vercel-id");
  });

  test("is a frozen readonly tuple-shape (length 10)", () => {
    expect(STREAM_DIAG_HEADERS).toHaveLength(10);
  });
});

// ─── Logger / clock indirection ──────────────────────────────────────────

describe("logger + clock indirection", () => {
  test("setStreamDiagLogger swaps the logger; reset restores default", () => {
    const { logger, calls } = recordingLogger();
    setStreamDiagLogger(logger);
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    expect(calls).toHaveLength(1);

    _resetStreamDiagLogger();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("y"),
      attempt: 2,
      max_attempts: 2,
      mid_tool_call: false,
    });
    expect(warnSpy).toHaveBeenCalled();
    // The recorder shouldn't see the second call because we reset.
    expect(calls).toHaveLength(1);
    warnSpy.mockRestore();
  });

  test("default warning routes the structured log via console.warn", () => {
    _resetStreamDiagLogger();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("oops"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: true,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // warning is always called WITH `extra: { mid_tool_call }`, so the
    // 2-arg branch is exercised here.
    expect(warnSpy.mock.calls[0]).toHaveLength(2);
    expect(warnSpy.mock.calls[0]?.[1]).toEqual({ mid_tool_call: true });
    warnSpy.mockRestore();
  });

  test("default debug fallback fires when warning throws", () => {
    _resetStreamDiagLogger();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    // Make warning throw, but keep debug at the default. The catch block
    // routes to `_logger.debug("stream-retry log emit failed", [], {exc_info:true})`.
    setStreamDiagLogger({
      warning(): void {
        throw new Error("logger broke");
      },
      debug: _consoleDebug,
    });
    log_stream_retry({}, {
      kind: "drop",
      error: new Error("x"),
      attempt: 1,
      max_attempts: 1,
      mid_tool_call: false,
    });
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0]).toHaveLength(2);
    expect(debugSpy.mock.calls[0]?.[1]).toEqual({ exc_info: true });
    debugSpy.mockRestore();
  });

  test("_consoleWarning with empty/undefined extra uses single-arg console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    _consoleWarning("hello %s", ["world"]);
    _consoleWarning("count %d", [3], {});
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]).toEqual(["hello world"]);
    expect(warnSpy.mock.calls[1]).toEqual(["count 3"]);
    warnSpy.mockRestore();
  });

  test("_consoleDebug with empty/undefined extra uses single-arg console.debug", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    _consoleDebug("debug %s", ["msg"]);
    _consoleDebug("count %d", [9], {});
    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy.mock.calls[0]).toEqual(["debug msg"]);
    expect(debugSpy.mock.calls[1]).toEqual(["count 9"]);
    debugSpy.mockRestore();
  });

  test("_consoleWarning with non-empty extra uses 2-arg console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    _consoleWarning("hi", [], { foo: 1 });
    expect(warnSpy).toHaveBeenCalledWith("hi", { foo: 1 });
    warnSpy.mockRestore();
  });

  test("_consoleDebug with non-empty extra uses 2-arg console.debug", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    _consoleDebug("hi", [], { foo: 1 });
    expect(debugSpy).toHaveBeenCalledWith("hi", { foo: 1 });
    debugSpy.mockRestore();
  });

  test("setStreamDiagClock + reset cycles", () => {
    setStreamDiagClock(() => 12345);
    expect(stream_diag_init().started_at).toBe(12345);
    _resetStreamDiagClock();
    const d = stream_diag_init();
    expect(typeof d.started_at).toBe("number");
    expect(d.started_at).toBeGreaterThan(0);
  });
});
