/**
 * Stream diagnostics — per-attempt counters, exception chains, retry logging.
 *
 * Port of agent/stream_diag.py.
 *
 * When a streaming chat-completions request dies mid-response we want to know
 * why: which Cloudflare edge served the request, which OpenRouter downstream
 * provider answered, how many bytes/chunks we got before the drop, the HTTP
 * status, the underlying httpx error class. These helpers collect that info
 * and emit it both to `agent.log` (full detail via {@link AgentDiagLogger})
 * and to the user-facing status line (compact).
 *
 * Faithful divergences:
 *   - Python's `logging.getLogger(__name__)` → injected `AgentDiagLogger`
 *     interface so tests can spy on `warning`/`debug` without monkey-patching.
 *     Default emits via `console.warn` / `console.debug`. Matches upstream
 *     contract: WARNING with structured kwargs + extra `mid_tool_call`.
 *   - Python's `BaseException.__cause__` / `__context__` → JS errors expose
 *     `.cause`. There is no `__context__` (implicit chaining). We walk `.cause`
 *     up to 4 deep with dedupe + self-reference break, matching the upstream
 *     algorithm shape one-for-one against `__cause__` (most common case).
 *   - `getattr(obj, attr, default)` → conditional property access on a loose
 *     `Record<string, unknown>` view. We accept `unknown` for the agent
 *     duck-type and probe individual fields the way upstream `getattr` does.
 *   - `time.time()` (seconds float) → `Date.now() / 1000` to preserve the
 *     "elapsed in seconds" shape used downstream by retry/UI code.
 *   - `str(error)[:140] + "…"` (truncation at 140 chars) preserved exactly.
 *   - Header-value truncation at 120 chars preserved exactly.
 */

// ─── Logger surface (matches python `logger.warning(fmt, *args, extra=...)`) ──

/** Minimal logger interface — accepts a printf-style fmt + positional args. */
export interface AgentDiagLogger {
  warning(fmt: string, args: unknown[], extra?: Record<string, unknown>): void;
  debug(fmt: string, args: unknown[], extra?: Record<string, unknown>): void;
}

// Exported so tests can exercise both extra/no-extra branches directly —
// stream-diag's own callers happen to always pass `extra`, so the no-extra
// branch is otherwise unreachable.
export function _consoleWarning(
  fmt: string,
  args: unknown[],
  extra?: Record<string, unknown>,
): void {
  const rendered = _renderPrintf(fmt, args);
  if (extra && Object.keys(extra).length > 0) {
    console.warn(rendered, extra);
  } else {
    console.warn(rendered);
  }
}

export function _consoleDebug(
  fmt: string,
  args: unknown[],
  extra?: Record<string, unknown>,
): void {
  const rendered = _renderPrintf(fmt, args);
  if (extra && Object.keys(extra).length > 0) {
    console.debug(rendered, extra);
  } else {
    console.debug(rendered);
  }
}

const _defaultLogger: AgentDiagLogger = {
  warning: _consoleWarning,
  debug: _consoleDebug,
};

let _logger: AgentDiagLogger = _defaultLogger;

export function setStreamDiagLogger(logger: AgentDiagLogger): void {
  _logger = logger;
}

export function _resetStreamDiagLogger(): void {
  _logger = _defaultLogger;
}

// ─── printf-style format helper (minimal subset used by upstream calls) ───

/**
 * Render a Python-style printf format with the supplied args.
 *
 * Supports the specifiers actually used by callers in this module:
 *   %s   → String(arg)
 *   %d   → Math.trunc(Number(arg))
 *   %.2f → Number(arg).toFixed(2)
 *   %%   → literal '%'
 *
 * Any unknown specifier is preserved verbatim and no arg is consumed.
 */
export function _renderPrintf(fmt: string, args: unknown[]): string {
  let argIdx = 0;
  return fmt.replace(/%(?:(%)|(?:\.(\d+))?([sdf]))/g, (match, pct, prec, kind) => {
    if (pct) return "%";
    if (argIdx >= args.length) return match;
    const value = args[argIdx++];
    if (kind === "s") return String(value);
    if (kind === "d") return String(Math.trunc(Number(value)));
    // kind === "f" — the only remaining branch given the regex's character class.
    const digits = prec === undefined ? 6 : Number(prec);
    return Number(value).toFixed(digits);
  });
}

// ─── Per-attempt stream diagnostic headers ────────────────────────────────

/**
 * Per-attempt stream diagnostic headers (lowercased).
 *
 * httpx returns CIMultiDict so case-insensitive lookups already work; we
 * normalise to lowercase up front because the headers we get from `undici`/
 * native `fetch` are already lower-cased.
 */
export const STREAM_DIAG_HEADERS: readonly string[] = [
  "cf-ray",
  "cf-cache-status",
  "x-openrouter-provider",
  "x-openrouter-model",
  "x-openrouter-id",
  "x-request-id",
  "x-vercel-id",
  "via",
  "server",
  "x-forwarded-for",
] as const;

// ─── stream_diag_init ────────────────────────────────────────────────────

/** Per-attempt diagnostic dictionary, mutated by stream functions. */
export interface StreamDiag {
  started_at: number;
  first_chunk_at: number | null;
  chunks: number;
  bytes: number;
  headers: Record<string, string>;
  http_status: number | null;
}

/**
 * Return a fresh per-attempt diagnostic dict.
 *
 * Mutated in-place by the streaming functions and read from the retry block
 * when a stream dies. Lives on `request_client_holder` so it survives across
 * the closure boundary (callers keep the same reference for the whole attempt).
 */
export function stream_diag_init(): StreamDiag {
  return {
    started_at: _now(),
    first_chunk_at: null,
    chunks: 0,
    bytes: 0,
    headers: {},
    http_status: null,
  };
}

// ─── stream_diag_capture_response ────────────────────────────────────────

/**
 * Type-guard for the loose `dict`-like check upstream uses to gate diag
 * mutation. A `StreamDiag` is a non-null object that exposes the fields we
 * mutate; everything else (None, lists, ints) is rejected.
 */
function _isDiag(value: unknown): value is StreamDiag {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Snapshot interesting headers + HTTP status from the live stream.
 *
 * Called once at stream open (before iterating chunks) so the metadata
 * survives even if the stream dies before any chunk arrives. Failures are
 * swallowed — diag is best-effort.
 */
export function stream_diag_capture_response(
  agent: unknown,
  diag: unknown,
  http_response: unknown,
): void {
  if (http_response === null || http_response === undefined) return;
  if (!_isDiag(diag)) return;
  try {
    const status = (http_response as Record<string, unknown>).status_code;
    diag.http_status = (status as number | null | undefined) ?? null;
  } catch {
    // swallow
  }
  try {
    const rawHeaders = (http_response as Record<string, unknown>).headers;
    const headers =
      rawHeaders === null || rawHeaders === undefined ? {} : (rawHeaders as Record<string, unknown>);
    const captured: Record<string, string> = {};
    // Allow per-agent override of the headers list (back-compat).
    const overrideAttr = (agent as Record<string, unknown> | null | undefined)?._STREAM_DIAG_HEADERS;
    const targetHeaders = (overrideAttr as readonly string[] | undefined) ?? STREAM_DIAG_HEADERS;
    for (const name of targetHeaders) {
      try {
        const val = _headerLookup(headers, name);
        if (val) {
          // Truncate single-value to keep log lines bounded.
          captured[name] = String(val).slice(0, 120);
        }
      } catch {
        // swallow per-header lookup failures; keep iterating
      }
    }
    diag.headers = captured;
  } catch {
    // swallow
  }
}

/**
 * Mimic Python `dict.get(name)` against either a plain object, a `Map`, or any
 * other object that exposes a `.get(name)` method.
 *
 * `headers` is always defaulted to `{}` by the sole caller, so the null/
 * undefined guard upstream Python had via `getattr(..., None) or {}` is
 * handled at the caller, not here.
 */
function _headerLookup(headers: object, name: string): unknown {
  const getter = (headers as { get?: (k: string) => unknown }).get;
  if (typeof getter === "function") {
    return getter.call(headers, name);
  }
  const record = headers as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  return undefined;
}

// ─── flatten_exception_chain ─────────────────────────────────────────────

/**
 * Return a compact `Outer(msg) <- Inner(msg) <- ...` rendering.
 *
 * OpenAI SDK wraps httpx errors as `APIConnectionError` / `APIError` and
 * only the wrapper's class is visible at the catch site — but the
 * underlying `RemoteProtocolError` / `ConnectError` / `ReadError` is what
 * tells us WHY the stream died. Walks `.cause` (Python's `__cause__`, then
 * `__context__` — JS only has `.cause`) up to 4 deep with dedupe + self-
 * reference break.
 */
export function flatten_exception_chain(error: unknown): string {
  const seen: unknown[] = [];
  let link: unknown = error;
  while (link !== null && link !== undefined && seen.length < 4) {
    if (seen.includes(link)) break;
    seen.push(link);
    const nxt = _causeOf(link);
    if (nxt === null || nxt === undefined || nxt === link) break;
    link = nxt;
  }
  const parts: string[] = [];
  for (const e of seen) {
    let msg = String(_errorMessage(e)).trim().replace(/\n/g, " ");
    if (msg.length > 140) msg = `${msg.slice(0, 140)}…`;
    const name = _errorTypeName(e);
    parts.push(msg ? `${name}(${msg})` : name);
  }
  if (parts.length > 0) return parts.join(" <- ");
  return _errorTypeName(error);
}

function _causeOf(err: unknown): unknown {
  if (err !== null && typeof err === "object") {
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) return cause;
  }
  return null;
}

function _errorMessage(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (err instanceof Error) return err.message ?? "";
  if (typeof err === "object") {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
    // Plain object with no message: upstream `str(e)` on a bare object
    // would produce `<...repr>`; we suppress to "" so renderings collapse
    // to just `Type` like an empty Python Exception.
    return "";
  }
  // Primitives: surface their string form (e.g. "a string", "42").
  return String(err);
}

function _errorTypeName(err: unknown): string {
  if (err === null) return "NoneType";
  if (err === undefined) return "undefined";
  if (err instanceof Error) {
    // Match upstream `type(e).__name__` — class name string.
    return err.name || err.constructor.name || "Error";
  }
  if (typeof err === "object") {
    const ctor = (err as { constructor?: { name?: string } }).constructor;
    return ctor?.name ?? "object";
  }
  // Map JS typeof → Python-style constructor names so callers logging an
  // error chain see `String(...)` / `Number(...)` instead of `string(...)`,
  // matching upstream `type(e).__name__` capitalisation.
  if (typeof err === "string") return "String";
  if (typeof err === "number") return "Number";
  if (typeof err === "boolean") return "Boolean";
  if (typeof err === "bigint") return "BigInt";
  if (typeof err === "symbol") return "Symbol";
  return typeof err;
}

// ─── log_stream_retry ────────────────────────────────────────────────────

export interface LogStreamRetryOptions {
  kind: string;
  error: unknown;
  attempt: number;
  max_attempts: number;
  mid_tool_call: boolean;
  diag?: unknown;
}

/**
 * Record a transient stream-drop and retry to `agent.log`.
 *
 * Always logs a structured WARNING so users have a breadcrumb regardless of
 * UI verbosity. Subagents in particular benefit because their retries no
 * longer spam the parent's terminal — but the file log keeps full detail
 * (provider, error class, attempt, base_url, subagent_id).
 *
 * When `diag` is provided (the per-attempt stream-diagnostic dict from
 * {@link stream_diag_init}), the WARNING also captures upstream headers
 * (cf-ray, x-openrouter-provider, x-openrouter-id), HTTP status, bytes
 * streamed before the drop, and elapsed time on the dying attempt.
 */
export function log_stream_retry(agent: unknown, opts: LogStreamRetryOptions): void {
  const { kind, error, attempt, max_attempts, mid_tool_call, diag } = opts;
  try {
    let summary: string;
    try {
      const summarizer = (agent as { _summarize_api_error?: (e: unknown) => unknown } | null | undefined)
        ?._summarize_api_error;
      summary =
        typeof summarizer === "function"
          ? String(summarizer.call(agent, error) ?? "")
          : String(_errorMessage(error));
    } catch {
      summary = String(_errorMessage(error));
    }
    if (summary && summary.length > 240) summary = `${summary.slice(0, 240)}…`;

    // Inner-cause chain (httpx errors hide under openai.APIError).
    let chain: string;
    try {
      chain = flatten_exception_chain(error);
    } catch {
      chain = _errorTypeName(error);
    }

    // Per-attempt counters and upstream headers.
    const now = _now();
    let bytesCount = 0;
    let chunks = 0;
    let elapsed = 0.0;
    let ttfb: number | null = null;
    let headersRepr = "-";
    let httpStatus = "-";
    if (_isDiag(diag)) {
      try {
        bytesCount = Math.trunc(Number(diag.bytes ?? 0) || 0);
        chunks = Math.trunc(Number(diag.chunks ?? 0) || 0);
        const startedRaw = diag.started_at;
        const started = Number(startedRaw ?? now);
        const startedFloat = Number.isFinite(started) ? started : now;
        elapsed = Math.max(0.0, now - startedFloat);
        const first = diag.first_chunk_at;
        if (first !== null && first !== undefined) {
          const firstFloat = Number(first);
          if (Number.isFinite(firstFloat)) {
            ttfb = Math.max(0.0, firstFloat - startedFloat);
          }
        }
        const headers = (diag.headers ?? {}) as Record<string, unknown> | unknown;
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          const entries = Object.entries(headers as Record<string, unknown>);
          if (entries.length > 0) {
            headersRepr = entries.map(([k, v]) => `${k}=${String(v)}`).join(" ");
          }
        }
        if (diag.http_status !== null && diag.http_status !== undefined) {
          httpStatus = String(diag.http_status);
        }
      } catch {
        // swallow — leave defaults in place
      }
    }

    const agentRec = (agent as Record<string, unknown> | null | undefined) ?? {};
    const subagentId = (agentRec._subagent_id as unknown) || "-";
    const delegateDepth = (agentRec._delegate_depth as unknown) ?? 0;
    const provider = (agentRec.provider as unknown) || "-";
    const baseUrl = (agentRec.base_url as unknown) || "-";

    _logger.warning(
      "Stream %s on attempt %s/%s — retrying. " +
        "subagent_id=%s depth=%s provider=%s base_url=%s " +
        "error_type=%s error=%s " +
        "chain=%s " +
        "http_status=%s bytes=%d chunks=%d elapsed=%.2fs ttfb=%s " +
        "upstream=[%s]",
      [
        kind,
        attempt,
        max_attempts,
        subagentId,
        delegateDepth,
        provider,
        baseUrl,
        _errorTypeName(error),
        summary,
        chain,
        httpStatus,
        bytesCount,
        chunks,
        elapsed,
        ttfb !== null ? `${ttfb.toFixed(2)}s` : "-",
        headersRepr,
      ],
      { mid_tool_call },
    );
  } catch {
    _logger.debug("stream-retry log emit failed", [], { exc_info: true });
  }
}

// ─── emit_stream_drop ────────────────────────────────────────────────────

export interface EmitStreamDropOptions {
  error: unknown;
  attempt: number;
  max_attempts: number;
  mid_tool_call: boolean;
  diag?: unknown;
}

/**
 * Emit a single user-visible line for a stream drop+retry.
 *
 * Both top-level agents and subagents announce drops in the UI — the parent
 * prefixes subagent lines with `[subagent-N]` via `log_prefix` so they're
 * easy to attribute. All cases also write a structured WARNING to
 * `agent.log` via {@link log_stream_retry} with the full diagnostic detail
 * for post-hoc analysis.
 */
export function emit_stream_drop(agent: unknown, opts: EmitStreamDropOptions): void {
  const { error, attempt, max_attempts, mid_tool_call, diag } = opts;
  const kind = mid_tool_call ? "drop mid tool-call" : "drop";
  log_stream_retry(agent, {
    kind,
    error,
    attempt,
    max_attempts,
    mid_tool_call,
    diag,
  });
  const agentRec = (agent as Record<string, unknown> | null | undefined) ?? {};
  const provider = (agentRec.provider as unknown) || "provider";
  // Compose a brief "after Xs" suffix when we have timing data — helps the
  // user distinguish "couldn't connect" (0s) from "died after 30s of
  // streaming" (likely upstream idle-kill or proxy timeout).
  let suffix = "";
  if (_isDiag(diag)) {
    try {
      const started = diag.started_at;
      if (started !== null && started !== undefined) {
        const startedFloat = Number(started);
        if (Number.isFinite(startedFloat)) {
          suffix = ` after ${Math.max(0.0, _now() - startedFloat).toFixed(1)}s`;
        }
      }
    } catch {
      // swallow
    }
  }
  try {
    const emitStatus = (agent as { _emit_status?: (msg: string) => void } | null | undefined)
      ?._emit_status;
    const touchActivity = (agent as { _touch_activity?: (msg: string) => void } | null | undefined)
      ?._touch_activity;
    if (typeof emitStatus === "function") {
      emitStatus.call(
        agent,
        `⚠️ ${String(provider)} stream ${kind} (${_errorTypeName(error)})${suffix} ` +
          `— reconnecting, retry ${attempt}/${max_attempts}`,
      );
    }
    if (typeof touchActivity === "function") {
      touchActivity.call(
        agent,
        `stream retry ${attempt}/${max_attempts} after ${_errorTypeName(error)}`,
      );
    }
  } catch {
    // swallow — UI emission is best-effort
  }
}

// ─── clock indirection (mockable in tests) ─────────────────────────────

const _defaultClock = (): number => Date.now() / 1000;
let _clock: () => number = _defaultClock;

/** Replace the internal clock with a mock. Tests use this for determinism. */
export function setStreamDiagClock(clock: () => number): void {
  _clock = clock;
}

export function _resetStreamDiagClock(): void {
  _clock = _defaultClock;
}

function _now(): number {
  return _clock();
}
