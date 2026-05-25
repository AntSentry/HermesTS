/**
 * Async/sync bridging helpers.
 *
 * Faithful divergence from upstream `agent/async_utils.py`.
 *
 * Upstream provides `safe_schedule_threadsafe(coro, loop)` — a wrapper
 * around `asyncio.run_coroutine_threadsafe(coro, loop)` that closes the
 * coroutine if the loop is None or rejects scheduling, so the call site
 * doesn't leak an un-awaited coroutine frame (Python's "coroutine was
 * never awaited" RuntimeWarning).
 *
 * Node has no equivalent failure mode:
 *   - There is exactly one event loop per process; you can't schedule a
 *     promise "onto" a different one. `loop` is therefore meaningless.
 *   - Promises never raise a "promise was never awaited" warning. They
 *     resolve or reject independent of whether the caller awaits the
 *     returned value.
 *   - `Promise.resolve().then(...)` always schedules to the single
 *     microtask queue and cannot fail synchronously.
 *
 * So the upstream signature has no analog and is intentionally not
 * exported. We expose `safeScheduleThreadsafe(taskFn, loop)` as a thin
 * shim that returns a Promise (success) or `null` (when `loop` is
 * explicitly the sentinel `null`, mirroring upstream's "loop is None"
 * branch). It exists for parity with sites that previously called
 * `safe_schedule_threadsafe` so the porter of the integrator
 * (`conversation_loop`, `tool_executor`, etc.) has an obvious 1:1
 * substitute when porting those callers.
 *
 * Upstream docstring's contract preserved:
 *   - `null` loop → returns `null`, with optional log line.
 *   - All other paths → returns a Promise.
 */

import { getLogger, type Logger } from "@hermests/core";

const DEFAULT_LOGGER = getLogger("agent.async_utils");

/** Pseudo-loop type — Node has one global loop, this is a tag for the parameter. */
export type EventLoopHandle = symbol | object | null;

/** A function that produces a Promise — Node equivalent of a coroutine object. */
export type AsyncTask<T> = () => Promise<T>;

export interface SafeScheduleOptions {
  logger?: Logger;
  logMessage?: string;
  logLevel?: "debug" | "info" | "warning" | "error";
}

/**
 * Schedule an async task. Returns the Promise on success, or `null` when
 * `loop` is `null` (matches upstream's "loop is None" early-return).
 *
 * Unlike upstream, scheduling itself cannot fail in Node — `await fn()`
 * is the entire mechanism. The try/catch around the call wraps the
 * task's synchronous prelude so a throwing function body is treated as
 * a rejected promise rather than crashing the call site.
 */
export function safeScheduleThreadsafe<T>(
  taskFn: AsyncTask<T>,
  loop: EventLoopHandle,
  options: SafeScheduleOptions = {},
): Promise<T> | null {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const logMessage = options.logMessage ?? "Failed to schedule coroutine on loop";
  const logLevel = options.logLevel ?? "debug";

  if (loop === null) {
    logger[logLevel](`${logMessage}: loop is None`);
    return null;
  }

  try {
    return Promise.resolve(taskFn());
  } catch (exc) {
    logger[logLevel](`${logMessage}: ${stringifyError(exc)}`);
    return Promise.reject(exc);
  }
}

function stringifyError(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.message;
  }
  return String(exc);
}
