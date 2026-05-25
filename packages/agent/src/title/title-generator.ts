/**
 * Auto-generate short session titles from the first user/assistant
 * exchange — port of upstream `agent/title_generator.py`.
 *
 * Faithful divergences from upstream:
 *   - `threading.Thread(target=auto_title_session, daemon=True).start()`
 *     in `maybe_auto_title` has no Node equivalent. Node's event loop
 *     is single-threaded; the same fire-and-forget semantics map to an
 *     unawaited `Promise.resolve().then(() => autoTitleSession(...))`.
 *     Same observable behaviour: caller returns immediately, work runs
 *     after the current microtask queue drains.
 *   - `agent.auxiliary_client.call_llm` lives in #5j; ported via the
 *     extension registry. Tests install a fake; production wires the
 *     real call_llm once #5j lands.
 *   - The session_db abstraction is unchanged — it's just an object
 *     with `get_session_title(id)` and `set_session_title(id, title)`
 *     methods, which we represent as an interface here.
 */

import { getAuxiliaryLlmHooks } from "../extensions/index.js";

/**
 * Minimal contract the title generator needs from the session DB.
 * Upstream uses Python's duck typing — we model it explicitly.
 */
export interface SessionDb {
  get_session_title(sessionId: string): string | null | undefined;
  set_session_title(sessionId: string, title: string): void;
}

export type FailureCallback = (task: string, error: unknown) => void;
export type TitleCallback = (title: string) => void;

const _TITLE_PROMPT =
  "Generate a short, descriptive title (3-7 words) for a conversation that starts with the " +
  "following exchange. The title should capture the main topic or intent. " +
  "Return ONLY the title text, nothing else. No quotes, no punctuation at the end, no prefixes.";

/**
 * Generate a session title from the first exchange. Mirrors upstream
 * `generate_title` (py:L29-84).
 */
export function generateTitle(
  userMessage: string,
  assistantResponse: string,
  options: {
    timeout?: number;
    failureCallback?: FailureCallback | null;
    mainRuntime?: Record<string, unknown> | null;
  } = {},
): string | null {
  const timeout = options.timeout ?? 30.0;
  const failureCallback = options.failureCallback ?? null;
  const mainRuntime = options.mainRuntime ?? null;

  const userSnippet = userMessage ? userMessage.slice(0, 500) : "";
  const assistantSnippet = assistantResponse ? assistantResponse.slice(0, 500) : "";

  const messages = [
    { role: "system", content: _TITLE_PROMPT },
    { role: "user", content: `User: ${userSnippet}\n\nAssistant: ${assistantSnippet}` },
  ];

  const hooks = getAuxiliaryLlmHooks();
  if (!hooks) {
    // No call_llm wired — surface as a failure to the caller the same
    // way the upstream `try/except Exception` block would.
    if (failureCallback !== null) {
      try {
        failureCallback("title generation", new Error("auxiliary LLM not configured"));
      } catch {
        // ignore — upstream swallows callback errors too
      }
    }
    return null;
  }

  try {
    const response = hooks.callLlm({
      task: "title_generation",
      messages,
      max_tokens: 500,
      temperature: 0.3,
      timeout,
      main_runtime: mainRuntime,
    });
    let title = String(response.choices[0]?.message.content ?? "").trim();
    // Strip leading/trailing matching quotes (Python str.strip("\"'")).
    while (title.length > 0 && (title[0] === '"' || title[0] === "'")) title = title.slice(1);
    while (title.length > 0 && (title[title.length - 1] === '"' || title[title.length - 1] === "'")) {
      title = title.slice(0, -1);
    }
    if (title.toLowerCase().startsWith("title:")) {
      title = title.slice(6).trim();
    }
    if (title.length > 80) {
      title = `${title.slice(0, 77)}...`;
    }
    return title || null;
  } catch (err) {
    if (failureCallback !== null) {
      try {
        failureCallback("title generation", err);
      } catch {
        // ignore — upstream swallows callback errors too
      }
    }
    return null;
  }
}

/**
 * Generate and set a session title if one doesn't already exist.
 * Mirrors upstream `auto_title_session` (py:L87-130).
 *
 * Silently skips if:
 *   - sessionDb is null
 *   - session already has a title
 *   - title generation fails
 */
export function autoTitleSession(
  sessionDb: SessionDb | null | undefined,
  sessionId: string,
  userMessage: string,
  assistantResponse: string,
  options: {
    failureCallback?: FailureCallback | null;
    mainRuntime?: Record<string, unknown> | null;
    titleCallback?: TitleCallback | null;
  } = {},
): void {
  if (!sessionDb || !sessionId) return;

  let existing: unknown;
  try {
    existing = sessionDb.get_session_title(sessionId);
  } catch {
    return;
  }
  if (existing) return;

  const title = generateTitle(userMessage, assistantResponse, {
    timeout: 30.0,
    failureCallback: options.failureCallback ?? null,
    mainRuntime: options.mainRuntime ?? null,
  });
  if (!title) return;

  try {
    sessionDb.set_session_title(sessionId, title);
    if (options.titleCallback !== null && options.titleCallback !== undefined) {
      try {
        options.titleCallback(title);
      } catch {
        // ignore — upstream swallows callback errors
      }
    }
  } catch {
    // ignore — upstream debug-logs and returns
  }
}

/**
 * Fire-and-forget title generation after the first exchange. Mirrors
 * upstream `maybe_auto_title` (py:L133-171).
 *
 * Faithful divergence: the upstream daemon thread becomes a
 * microtask-scheduled async call — same fire-and-forget contract, no
 * caller blocking.
 */
export function maybeAutoTitle(
  sessionDb: SessionDb | null | undefined,
  sessionId: string,
  userMessage: string,
  assistantResponse: string,
  conversationHistory: Array<Record<string, unknown>>,
  options: {
    failureCallback?: FailureCallback | null;
    mainRuntime?: Record<string, unknown> | null;
    titleCallback?: TitleCallback | null;
  } = {},
): void {
  if (!sessionDb || !sessionId || !userMessage || !assistantResponse) return;

  let userMsgCount = 0;
  for (const m of conversationHistory ?? []) {
    if (m && typeof m === "object" && (m as Record<string, unknown>)["role"] === "user") {
      userMsgCount += 1;
    }
  }
  if (userMsgCount > 2) return;

  // Schedule on a microtask so the caller returns immediately — mirrors
  // upstream's `threading.Thread(..., daemon=True).start()` semantics.
  _scheduleBackground(() => {
    autoTitleSession(sessionDb, sessionId, userMessage, assistantResponse, options);
  });
}

/**
 * Background-scheduling indirection so tests can synchronize the
 * fire-and-forget call. Defaults to a microtask schedule; tests
 * substitute a synchronous runner to assert on side effects.
 */
function _defaultScheduleRun(fn: () => void): void {
  queueMicrotask(fn);
}

export const _scheduler: { run: (fn: () => void) => void } = {
  run: _defaultScheduleRun,
};

function _scheduleBackground(fn: () => void): void {
  _scheduler.run(fn);
}

/** Test hook — replace the background scheduler. */
export function _setSchedulerForTests(run: ((fn: () => void) => void) | null): void {
  _scheduler.run = run ?? _defaultScheduleRun;
}
