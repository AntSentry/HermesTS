/**
 * MockLogger — in-memory fake matching the @hermests/core Logger surface.
 *
 * Structurally compatible with `Logger` from @hermests/core/logging
 * (debug/info/warning/error/critical methods, plus setLevel/addHandler/etc.).
 * Kept as a standalone interface so test-helpers can be consumed by
 * packages that don't depend on @hermests/core directly.
 *
 * Coupling note: if the canonical Logger surface grows new methods, add
 * the corresponding capture here and update LoggerSurface accordingly.
 */

export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";

export interface LogEntry {
  level: LogLevel;
  message: string;
  args: unknown[];
  timestamp: Date;
}

/**
 * Minimum surface that matches @hermests/core Logger.
 * Downstream callers can assign a MockLogger to a Logger-typed slot via
 * structural typing.
 */
export interface LoggerSurface {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warning(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  critical(msg: string, ...args: unknown[]): void;
}

export class MockLogger implements LoggerSurface {
  readonly name: string;
  readonly entries: LogEntry[] = [];
  private nowFn: () => Date;

  constructor(name = "mock", nowFn: () => Date = () => new Date()) {
    this.name = name;
    this.nowFn = nowFn;
  }

  debug(message: string, ...args: unknown[]): void {
    this.record("debug", message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.record("info", message, args);
  }
  warning(message: string, ...args: unknown[]): void {
    this.record("warning", message, args);
  }
  error(message: string, ...args: unknown[]): void {
    this.record("error", message, args);
  }
  critical(message: string, ...args: unknown[]): void {
    this.record("critical", message, args);
  }

  private record(level: LogLevel, message: string, args: unknown[]): void {
    this.entries.push({ level, message, args, timestamp: this.nowFn() });
  }

  /** Wipe the captured log entries — call between tests. */
  clear(): void {
    this.entries.length = 0;
  }

  /** Return the entries captured at *level*. */
  entriesAt(level: LogLevel): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }

  /**
   * Assert a matching entry was captured at *level*. *matcher* may be:
   *   - a string (substring match against `message`)
   *   - a RegExp tested against `message`
   *   - a predicate over the LogEntry
   *
   * Throws AssertionError with a useful diff if no match is found.
   */
  assertLogged(level: LogLevel, matcher: string | RegExp | ((e: LogEntry) => boolean)): LogEntry {
    const candidates = this.entriesAt(level);
    const test = compileMatcher(matcher);
    const hit = candidates.find(test);
    if (!hit) {
      const dump =
        candidates.length === 0
          ? `no ${level} entries captured`
          : candidates.map((e, i) => `  [${i}] ${e.message}`).join("\n");
      throw new AssertionError(
        `expected ${level} log matching ${describeMatcher(matcher)}; got:\n${dump}`,
      );
    }
    return hit;
  }

  /** Assert exactly *count* entries were captured at *level*. */
  assertCallCount(level: LogLevel, count: number): void {
    const actual = this.entriesAt(level).length;
    if (actual !== count) {
      throw new AssertionError(
        `expected ${count} ${level} call(s); got ${actual}`,
      );
    }
  }
}

function compileMatcher(
  matcher: string | RegExp | ((e: LogEntry) => boolean),
): (e: LogEntry) => boolean {
  if (typeof matcher === "string") {
    return (e) => e.message.includes(matcher);
  }
  if (matcher instanceof RegExp) {
    return (e) => matcher.test(e.message);
  }
  return matcher;
}

function describeMatcher(matcher: string | RegExp | ((e: LogEntry) => boolean)): string {
  if (typeof matcher === "string") return JSON.stringify(matcher);
  if (matcher instanceof RegExp) return matcher.toString();
  return matcher.name ? `predicate ${matcher.name}` : "predicate";
}

/** Assertion error distinct from Node's built-in so tests can catch it explicitly. */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}
