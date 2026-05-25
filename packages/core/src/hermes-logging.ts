/**
 * Centralized logging for HermesTS (port of hermes_logging.py).
 *
 * Faithful divergences:
 *   - Python's `logging` stdlib has no Node equivalent that mirrors all of:
 *     root-logger handler attachment, LogRecord factory injection of
 *     `%(session_tag)s`, propagation from child loggers, RotatingFileHandler
 *     with size-based rollover, per-handler filters, and pytest's caplog.
 *     We roll a custom implementation (~300 LOC, zero runtime deps) that
 *     preserves the public surface: setupLogging, setupVerboseLogging,
 *     setSessionContext, clearSessionContext, _ComponentFilter,
 *     COMPONENT_PREFIXES, getLogger, and the session_tag format token.
 *   - `threading.local` for per-thread session context → AsyncLocalStorage
 *     for per-async-task session context. Tests that use real threads in
 *     Python become tests that use isolated AsyncLocalStorage runs in Node.
 *   - `agent.redact.RedactingFormatter` is a downstream package. We accept
 *     a `formatter` callback in setupLogging options so the agent package
 *     can inject its redacting formatter; default is a plain formatter.
 *   - `hermes_cli.config.is_managed` is a downstream package. We accept an
 *     `isManaged` callback for the same reason; default returns false.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type WriteStream,
} from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { existsSync as fileExists, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getConfigPath, getHermesHome } from "./hermes-constants.js";

// ─── Levels (mirror Python's logging module) ────────────────────────────────

export const LogLevel = {
  NOTSET: 0,
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
} as const;
export type LogLevelName = keyof typeof LogLevel;
export type LogLevelValue = (typeof LogLevel)[LogLevelName];

function _resolveLevel(name: string | number | undefined): LogLevelValue {
  if (typeof name === "number") return name as LogLevelValue;
  if (!name) return LogLevel.INFO;
  const upper = name.toUpperCase() as LogLevelName;
  return LogLevel[upper] ?? LogLevel.INFO;
}

// ─── LogRecord ──────────────────────────────────────────────────────────────

export interface LogRecord {
  name: string;
  levelno: LogLevelValue;
  levelname: string;
  message: string;
  args: unknown[];
  created: Date;
  sessionTag: string;
}

function _levelName(level: LogLevelValue): string {
  for (const [n, v] of Object.entries(LogLevel) as [LogLevelName, LogLevelValue][]) {
    if (v === level) return n;
  }
  return "INFO";
}

// ─── Session context (AsyncLocalStorage replacement for threading.local) ────

const _sessionStorage = new AsyncLocalStorage<{ sessionId: string | null }>();
// Fallback for callers that don't use `runWithSession` — mirrors the
// upstream behavior where `set_session_context` mutates a singleton.
let _globalSession: string | null = null;

export function setSessionContext(sessionId: string): void {
  const cell = _sessionStorage.getStore();
  if (cell) cell.sessionId = sessionId;
  else _globalSession = sessionId;
}

export function clearSessionContext(): void {
  const cell = _sessionStorage.getStore();
  if (cell) cell.sessionId = null;
  else _globalSession = null;
}

function _currentSession(): string | null {
  return _sessionStorage.getStore()?.sessionId ?? _globalSession;
}

/**
 * Run *fn* inside an isolated session context — equivalent to spawning a
 * Python thread that calls `set_session_context` privately.
 */
export function runWithSession<T>(sessionId: string | null, fn: () => T): T {
  return _sessionStorage.run({ sessionId }, fn);
}

// ─── Record factory (matches upstream py:L90-119) ───────────────────────────

type RecordFactory = (
  name: string,
  level: LogLevelValue,
  pathname: string,
  lineno: number,
  msg: string,
  args: unknown[],
  exc: unknown,
) => LogRecord;

interface MarkedFactory extends RecordFactory {
  _hermesSessionInjector?: boolean;
}

let _recordFactory: MarkedFactory = function defaultFactory(
  name,
  level,
  _pathname,
  _lineno,
  msg,
  args,
  _exc,
): LogRecord {
  const sid = _currentSession();
  return {
    name,
    levelno: level,
    levelname: _levelName(level),
    message: msg,
    args,
    created: new Date(),
    sessionTag: sid ? ` [${sid}]` : "",
  };
};
_recordFactory._hermesSessionInjector = true;

export function getLogRecordFactory(): RecordFactory {
  return _recordFactory;
}

export function setLogRecordFactory(fn: RecordFactory): void {
  _recordFactory = fn as MarkedFactory;
}

export function _installSessionRecordFactory(): void {
  const current = _recordFactory;
  if (current._hermesSessionInjector) return;
  const wrapped: MarkedFactory = (name, level, pathname, lineno, msg, args, exc) => {
    const record = current(name, level, pathname, lineno, msg, args, exc);
    const sid = _currentSession();
    record.sessionTag = sid ? ` [${sid}]` : "";
    return record;
  };
  wrapped._hermesSessionInjector = true;
  _recordFactory = wrapped;
}

// ─── Filters ────────────────────────────────────────────────────────────────

export type LogFilter = (record: LogRecord) => boolean;

/**
 * Filter that passes records whose logger name starts with one of *prefixes*.
 * Faithful to _ComponentFilter (py:L126-139).
 */
export class ComponentFilter {
  private readonly _prefixes: readonly string[];
  constructor(prefixes: readonly string[]) {
    this._prefixes = [...prefixes];
  }
  filter(record: LogRecord): boolean {
    return this._prefixes.some((p) => record.name.startsWith(p));
  }
}

export const _ComponentFilter = ComponentFilter;

export const COMPONENT_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  gateway: ["gateway", "hermes_plugins"],
  agent: ["agent", "run_agent", "model_tools", "batch_runner"],
  tools: ["tools"],
  cli: ["hermes_cli", "cli"],
  cron: ["cron"],
};

// ─── Formatters ─────────────────────────────────────────────────────────────

/**
 * Default formatter — interpolates Python-style %(field)s placeholders.
 * Supports asctime, levelname, name, message, sessionTag/session_tag.
 */
export interface Formatter {
  format(record: LogRecord): string;
}

function _formatAsctime(d: Date, datefmt?: string): string {
  if (datefmt === "%H:%M:%S") {
    return d.toISOString().slice(11, 19);
  }
  // Match Python's default: "YYYY-MM-DD HH:MM:SS,mmm"
  const iso = d.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  const ms = iso.slice(20, 23);
  return `${date} ${time},${ms}`;
}

export class PercentFormatter implements Formatter {
  constructor(
    private readonly fmt: string,
    private readonly datefmt?: string,
  ) {}
  format(record: LogRecord): string {
    return this.fmt
      .replace(/%\(asctime\)s/g, _formatAsctime(record.created, this.datefmt))
      .replace(/%\(levelname\)s/g, record.levelname)
      .replace(/%\(session_tag\)s/g, record.sessionTag)
      .replace(/%\(sessionTag\)s/g, record.sessionTag)
      .replace(/%\(name\)s/g, record.name)
      .replace(/%\(message\)s/g, record.message);
  }
}

export const _LOG_FORMAT =
  "%(asctime)s %(levelname)s%(session_tag)s %(name)s: %(message)s";
export const _LOG_FORMAT_VERBOSE =
  "%(asctime)s - %(name)s - %(levelname)s%(session_tag)s - %(message)s";

// ─── Handler abstraction ────────────────────────────────────────────────────

export abstract class Handler {
  level: LogLevelValue = LogLevel.NOTSET;
  formatter: Formatter = new PercentFormatter("%(message)s");
  filters: LogFilter[] = [];
  _hermesVerbose?: boolean;

  setLevel(level: LogLevelValue): void {
    this.level = level;
  }
  setFormatter(fmt: Formatter): void {
    this.formatter = fmt;
  }
  addFilter(f: LogFilter | ComponentFilter): void {
    if (f instanceof ComponentFilter) {
      this.filters.push((r) => f.filter(r));
    } else {
      this.filters.push(f);
    }
  }
  shouldPass(record: LogRecord): boolean {
    if (record.levelno < this.level) return false;
    return this.filters.every((f) => f(record));
  }
  handle(record: LogRecord): void {
    if (!this.shouldPass(record)) return;
    this.emit(record);
  }
  abstract emit(record: LogRecord): void;
  abstract flush(): void;
  abstract close(): void;
}

export class StreamHandler extends Handler {
  constructor(private readonly stream: NodeJS.WritableStream = process.stderr) {
    super();
  }
  emit(record: LogRecord): void {
    this.stream.write(this.formatter.format(record) + "\n");
  }
  flush(): void {
    // process.stderr is unbuffered enough for our purposes.
  }
  close(): void {
    // never close process streams.
  }
}

// ─── Rotating file handler ──────────────────────────────────────────────────

/**
 * Size-based rotating file handler — faithful to Python's
 * `logging.handlers.RotatingFileHandler` (the upstream py:L298-327 subclass
 * adds chmod-after-open for "managed" deployments).
 */
export class RotatingFileHandler extends Handler {
  baseFilename: string;
  maxBytes: number;
  backupCount: number;
  private fd: number | null = null;
  private currentSize = 0;
  private managed: boolean;

  constructor(
    filename: string,
    options: {
      maxBytes: number;
      backupCount: number;
      isManaged?: () => boolean;
    },
  ) {
    super();
    this.baseFilename = pathResolve(filename);
    this.maxBytes = options.maxBytes;
    this.backupCount = options.backupCount;
    this.managed = options.isManaged ? options.isManaged() : false;
    this._open();
  }

  private _open(): void {
    mkdirSync(dirname(this.baseFilename), { recursive: true });
    // O_APPEND | O_CREAT | O_WRONLY, mode 0644 by default; chmod afterwards.
    this.fd = openSync(this.baseFilename, "a", 0o644);
    try {
      this.currentSize = fstatSync(this.fd).size;
    } catch {
      this.currentSize = 0;
    }
    this._chmodIfManaged();
  }

  private _chmodIfManaged(): void {
    if (!this.managed) return;
    try {
      chmodSync(this.baseFilename, 0o660);
    } catch {
      // ignore
    }
  }

  private _shouldRollover(payloadLength: number): boolean {
    if (this.maxBytes <= 0) return false;
    return this.currentSize + payloadLength >= this.maxBytes;
  }

  private _doRollover(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
    for (let i = this.backupCount; i >= 1; i--) {
      const src = i === 1 ? this.baseFilename : `${this.baseFilename}.${i - 1}`;
      const dst = `${this.baseFilename}.${i}`;
      if (existsSync(src)) {
        if (existsSync(dst)) {
          try {
            unlinkSync(dst);
          } catch {
            // ignore
          }
        }
        try {
          renameSync(src, dst);
        } catch {
          // ignore
        }
      }
    }
    this._open();
    this._chmodIfManaged();
  }

  emit(record: LogRecord): void {
    const payload = this.formatter.format(record) + "\n";
    const bytes = Buffer.byteLength(payload, "utf-8");
    if (this._shouldRollover(bytes)) {
      this._doRollover();
    }
    if (this.fd === null) this._open();
    writeSync(this.fd as number, payload, null, "utf-8");
    this.currentSize += bytes;
  }

  flush(): void {
    // openSync('a') has the kernel-side buffer; no userspace flush needed
    // since we use writeSync, which goes straight to the fd.
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // ignore
    }
    this.fd = null;
  }
}

// ─── Root logger / loggers ──────────────────────────────────────────────────

export class Logger {
  parent: Logger | null = null;
  propagate = true;
  level: LogLevelValue = LogLevel.NOTSET;
  handlers: Handler[] = [];
  constructor(public readonly name: string) {}

  setLevel(level: LogLevelValue | string): void {
    this.level = typeof level === "string" ? _resolveLevel(level) : level;
  }
  addHandler(h: Handler): void {
    this.handlers.push(h);
  }
  removeHandler(h: Handler): void {
    const idx = this.handlers.indexOf(h);
    if (idx !== -1) this.handlers.splice(idx, 1);
  }

  /**
   * Determine the effective level by walking up the hierarchy.
   * Faithful to Python's getEffectiveLevel.
   */
  getEffectiveLevel(): LogLevelValue {
    let cur: Logger | null = this;
    while (cur) {
      if (cur.level !== LogLevel.NOTSET) return cur.level;
      cur = cur.parent;
    }
    return LogLevel.WARNING;
  }

  private _log(level: LogLevelValue, msg: string, args: unknown[]): void {
    if (level < this.getEffectiveLevel()) return;
    const record = _recordFactory(this.name, level, "", 0, msg, args, null);
    let cur: Logger | null = this;
    while (cur) {
      for (const h of cur.handlers) h.handle(record);
      if (!cur.propagate) break;
      cur = cur.parent;
    }
  }

  debug(msg: string, ...args: unknown[]): void {
    this._log(LogLevel.DEBUG, msg, args);
  }
  info(msg: string, ...args: unknown[]): void {
    this._log(LogLevel.INFO, msg, args);
  }
  warning(msg: string, ...args: unknown[]): void {
    this._log(LogLevel.WARNING, msg, args);
  }
  error(msg: string, ...args: unknown[]): void {
    this._log(LogLevel.ERROR, msg, args);
  }
  critical(msg: string, ...args: unknown[]): void {
    this._log(LogLevel.CRITICAL, msg, args);
  }
}

const _loggers = new Map<string, Logger>();
const _root = new Logger("root");

export function getLogger(name = ""): Logger {
  if (!name || name === "root") return _root;
  const existing = _loggers.get(name);
  if (existing) return existing;
  const logger = new Logger(name);
  // Parent linkage by dotted hierarchy.
  const parts = name.split(".");
  parts.pop();
  while (parts.length) {
    const parentName = parts.join(".");
    if (_loggers.has(parentName)) {
      logger.parent = _loggers.get(parentName) as Logger;
      break;
    }
    parts.pop();
  }
  if (!logger.parent) logger.parent = _root;
  _loggers.set(name, logger);
  return logger;
}

// Install the session-injecting record factory immediately on import.
_installSessionRecordFactory();

// ─── Config reader ──────────────────────────────────────────────────────────

interface LoggingConfig {
  level?: string | null;
  max_size_mb?: number | null;
  backup_count?: number | null;
}

export function _readLoggingConfig(): {
  level: string | null;
  maxSizeMb: number | null;
  backupCount: number | null;
} {
  try {
    const configPath = getConfigPath();
    if (fileExists(configPath)) {
      const text = readFileSync(configPath, "utf-8");
      const cfg = parseYaml(text) ?? {};
      const logCfg = (cfg as Record<string, unknown>).logging;
      if (logCfg && typeof logCfg === "object") {
        const lc = logCfg as LoggingConfig;
        return {
          level: lc.level ?? null,
          maxSizeMb: lc.max_size_mb ?? null,
          backupCount: lc.backup_count ?? null,
        };
      }
    }
  } catch {
    // fall through
  }
  return { level: null, maxSizeMb: null, backupCount: null };
}

// ─── Noisy logger suppression ───────────────────────────────────────────────

const _NOISY_LOGGERS = [
  "openai",
  "openai._base_client",
  "httpx",
  "httpcore",
  "asyncio",
  "hpack",
  "hpack.hpack",
  "grpc",
  "modal",
  "urllib3",
  "urllib3.connectionpool",
  "websockets",
  "charset_normalizer",
  "markdown_it",
] as const;

// ─── _add_rotating_handler ──────────────────────────────────────────────────

interface AddRotatingHandlerOptions {
  level: LogLevelValue;
  maxBytes: number;
  backupCount: number;
  formatter: Formatter;
  logFilter?: ComponentFilter | LogFilter | undefined;
  isManaged?: (() => boolean) | undefined;
}

export function _addRotatingHandler(
  logger: Logger,
  path: string,
  options: AddRotatingHandlerOptions,
): void {
  const resolved = pathResolve(path);
  for (const existing of logger.handlers) {
    if (
      existing instanceof RotatingFileHandler &&
      existing.baseFilename === resolved
    ) {
      return;
    }
  }
  mkdirSync(dirname(resolved), { recursive: true });
  const handler = new RotatingFileHandler(resolved, {
    maxBytes: options.maxBytes,
    backupCount: options.backupCount,
    isManaged: options.isManaged,
  });
  handler.setLevel(options.level);
  handler.setFormatter(options.formatter);
  if (options.logFilter) handler.addFilter(options.logFilter);
  logger.addHandler(handler);
}

// ─── setupLogging / setupVerboseLogging ─────────────────────────────────────

export interface SetupLoggingOptions {
  hermesHome?: string;
  logLevel?: string;
  maxSizeMb?: number;
  backupCount?: number;
  mode?: "cli" | "gateway" | "cron" | string;
  force?: boolean;
  /** Inject a custom formatter (e.g. agent/redact RedactingFormatter). */
  formatterFactory?: (fmt: string) => Formatter;
  /** Inject the is_managed predicate from hermes_cli.config. */
  isManaged?: () => boolean;
}

let _loggingInitialized = false;

export function _resetLoggingState(): void {
  _loggingInitialized = false;
}

export function setupLogging(options: SetupLoggingOptions = {}): string {
  const home = options.hermesHome ?? getHermesHome();
  const logDir = join(home, "logs");
  mkdirSync(logDir, { recursive: true });

  const cfg = _readLoggingConfig();
  const levelName = (options.logLevel ?? cfg.level ?? "INFO").toUpperCase();
  const level = _resolveLevel(levelName);
  const maxBytes = (options.maxSizeMb ?? cfg.maxSizeMb ?? 5) * 1024 * 1024;
  const backups = options.backupCount ?? cfg.backupCount ?? 3;
  const formatterFactory =
    options.formatterFactory ?? ((fmt: string) => new PercentFormatter(fmt));

  // agent.log (INFO+).
  _addRotatingHandler(_root, join(logDir, "agent.log"), {
    level,
    maxBytes,
    backupCount: backups,
    formatter: formatterFactory(_LOG_FORMAT),
    isManaged: options.isManaged,
  });

  // errors.log (WARNING+).
  _addRotatingHandler(_root, join(logDir, "errors.log"), {
    level: LogLevel.WARNING,
    maxBytes: 2 * 1024 * 1024,
    backupCount: 2,
    formatter: formatterFactory(_LOG_FORMAT),
    isManaged: options.isManaged,
  });

  // gateway.log (INFO+, filtered to gateway component).
  if (options.mode === "gateway") {
    _addRotatingHandler(_root, join(logDir, "gateway.log"), {
      level: LogLevel.INFO,
      maxBytes: 5 * 1024 * 1024,
      backupCount: 3,
      formatter: formatterFactory(_LOG_FORMAT),
      logFilter: new ComponentFilter(COMPONENT_PREFIXES.gateway as readonly string[]),
      isManaged: options.isManaged,
    });
  }

  if (_loggingInitialized && !options.force) return logDir;

  if (_root.level === LogLevel.NOTSET || _root.level > level) {
    _root.setLevel(level);
  }

  for (const name of _NOISY_LOGGERS) {
    getLogger(name).setLevel(LogLevel.WARNING);
  }

  _loggingInitialized = true;
  return logDir;
}

export function setupVerboseLogging(
  formatterFactory: (fmt: string, datefmt?: string) => Formatter = (fmt, datefmt) =>
    new PercentFormatter(fmt, datefmt),
): void {
  // Avoid duplicate stream handlers — match upstream py:L272-275.
  for (const h of _root.handlers) {
    if (h instanceof StreamHandler && h._hermesVerbose) return;
  }
  const handler = new StreamHandler(process.stderr);
  handler.setLevel(LogLevel.DEBUG);
  handler.setFormatter(formatterFactory(_LOG_FORMAT_VERBOSE, "%H:%M:%S"));
  handler._hermesVerbose = true;
  _root.addHandler(handler);

  if (_root.level > LogLevel.DEBUG) _root.setLevel(LogLevel.DEBUG);

  for (const name of _NOISY_LOGGERS) {
    getLogger(name).setLevel(LogLevel.WARNING);
  }
  getLogger("rex-deploy").setLevel(LogLevel.INFO);
}

// ─── Root accessor & test helpers ───────────────────────────────────────────

export function getRootLogger(): Logger {
  return _root;
}

/**
 * Strip all RotatingFileHandlers from the root logger. Test-only helper
 * that matches the upstream conftest's pre-test cleanup (py:L26-37).
 */
export function _stripRotatingHandlers(): void {
  for (const h of [..._root.handlers]) {
    if (h instanceof RotatingFileHandler) {
      _root.removeHandler(h);
      h.close();
    }
  }
}

// Used by callers wanting to assert the underlying stream type without
// importing WriteStream directly.
export type AnyWriteStream = WriteStream | NodeJS.WritableStream;
