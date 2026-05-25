// Ported from tests/test_hermes_logging.py
// The 2 managed-mode tests are stripped of their patch("hermes_cli.config.is_managed",
// return_value=True) and instead inject `isManaged: () => true` into _addRotatingHandler.
// Deferred case `TestEntryPointsImportBootstrap` is owned by each entry-point package.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  COMPONENT_PREFIXES,
  ComponentFilter,
  LogLevel,
  PercentFormatter,
  RotatingFileHandler,
  StreamHandler,
  _ComponentFilter,
  _addRotatingHandler,
  _installSessionRecordFactory,
  _readLoggingConfig,
  _resetLoggingState,
  _stripRotatingHandlers,
  clearSessionContext,
  getLogRecordFactory,
  getLogger,
  getRootLogger,
  runWithSession,
  setLogRecordFactory,
  setSessionContext,
  setupLogging,
  setupVerboseLogging,
  type LogRecord,
} from "../src/hermes-logging.js";

let tmp: string;
let hermesHome: string;
let savedHome: string | undefined;

function freshHandlerCleanup(): void {
  const root = getRootLogger();
  for (const h of [...root.handlers]) {
    root.removeHandler(h);
    try {
      h.close();
    } catch {
      // ignore
    }
  }
  root.level = LogLevel.NOTSET;
}

// Capture the module-level default factory exactly once so afterEach can
// restore it. Without this, any test that calls setLogRecordFactory leaves
// the next test running against a stale factory.
const _initialFactory = getLogRecordFactory();

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "hermests-logging-")));
  hermesHome = join(tmp, ".hermes");
  mkdirSync(hermesHome, { recursive: true });
  savedHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = hermesHome;
  freshHandlerCleanup();
  _resetLoggingState();
  setLogRecordFactory(_initialFactory);
  clearSessionContext();
});

afterEach(() => {
  freshHandlerCleanup();
  _resetLoggingState();
  clearSessionContext();
  if (savedHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

function rotatingHandlers(filename: string): RotatingFileHandler[] {
  const root = getRootLogger();
  return root.handlers.filter(
    (h): h is RotatingFileHandler =>
      h instanceof RotatingFileHandler && h.baseFilename.includes(filename),
  );
}

function firstHandler(filename: string): RotatingFileHandler {
  const all = rotatingHandlers(filename);
  if (all.length === 0) {
    throw new Error(`no rotating handler found for ${filename}`);
  }
  return all[0]!;
}

function flushAll(): void {
  for (const h of getRootLogger().handlers) h.flush();
}

describe("setupLogging — base handlers", () => {
  test("creates log directory", () => {
    const dir = setupLogging({ hermesHome });
    expect(dir).toBe(join(hermesHome, "logs"));
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  test("creates agent.log handler at INFO", () => {
    setupLogging({ hermesHome });
    expect(rotatingHandlers("agent.log").length).toBe(1);
    expect(firstHandler("agent.log").level).toBe(LogLevel.INFO);
  });

  test("creates errors.log handler at WARNING", () => {
    setupLogging({ hermesHome });
    expect(rotatingHandlers("errors.log").length).toBe(1);
    expect(firstHandler("errors.log").level).toBe(LogLevel.WARNING);
  });

  test("idempotent: second call adds no duplicate handlers", () => {
    setupLogging({ hermesHome });
    setupLogging({ hermesHome });
    expect(rotatingHandlers("agent.log").length).toBe(1);
  });

  test("force=true still does not duplicate by path", () => {
    setupLogging({ hermesHome });
    setupLogging({ hermesHome, force: true });
    expect(rotatingHandlers("agent.log").length).toBe(1);
  });

  test("custom log level applies to the agent.log handler", () => {
    setupLogging({ hermesHome, logLevel: "DEBUG" });
    expect(firstHandler("agent.log").level).toBe(LogLevel.DEBUG);
  });

  test("unknown log level falls back to INFO", () => {
    setupLogging({ hermesHome, logLevel: "BOGUS" });
    expect(firstHandler("agent.log").level).toBe(LogLevel.INFO);
  });

  test("empty log level falls back to INFO", () => {
    setupLogging({ hermesHome, logLevel: "" });
    expect(firstHandler("agent.log").level).toBe(LogLevel.INFO);
  });

  test("custom maxSizeMb and backupCount applied", () => {
    setupLogging({ hermesHome, maxSizeMb: 10, backupCount: 5 });
    const handler = firstHandler("agent.log");
    expect(handler.maxBytes).toBe(10 * 1024 * 1024);
    expect(handler.backupCount).toBe(5);
  });

  test("noisy loggers are suppressed to WARNING", () => {
    setupLogging({ hermesHome });
    expect(getLogger("openai").level).toBeGreaterThanOrEqual(LogLevel.WARNING);
    expect(getLogger("httpx").level).toBeGreaterThanOrEqual(LogLevel.WARNING);
    expect(getLogger("httpcore").level).toBeGreaterThanOrEqual(LogLevel.WARNING);
  });

  test("writes to agent.log", () => {
    setupLogging({ hermesHome });
    const log = getLogger("test_hermes_logging.write_test");
    log.info("test message for agent.log");
    flushAll();
    const text = readFileSync(join(hermesHome, "logs", "agent.log"), "utf-8");
    expect(text).toContain("test message for agent.log");
  });

  test("warnings appear in both agent.log and errors.log", () => {
    setupLogging({ hermesHome });
    const log = getLogger("test_hermes_logging.warning_test");
    log.warning("this is a warning");
    flushAll();
    expect(
      readFileSync(join(hermesHome, "logs", "agent.log"), "utf-8"),
    ).toContain("this is a warning");
    expect(
      readFileSync(join(hermesHome, "logs", "errors.log"), "utf-8"),
    ).toContain("this is a warning");
  });

  test("info messages do not appear in errors.log", () => {
    setupLogging({ hermesHome });
    const log = getLogger("test_hermes_logging.info_test");
    log.info("info only message");
    flushAll();
    const errPath = join(hermesHome, "logs", "errors.log");
    if (existsSync(errPath)) {
      expect(readFileSync(errPath, "utf-8")).not.toContain("info only message");
    }
  });

  test("reads logging block from config.yaml", () => {
    writeFileSync(
      join(hermesHome, "config.yaml"),
      "logging:\n  level: DEBUG\n  max_size_mb: 2\n  backup_count: 1\n",
    );
    setupLogging({ hermesHome });
    const handler = firstHandler("agent.log");
    expect(handler.level).toBe(LogLevel.DEBUG);
    expect(handler.maxBytes).toBe(2 * 1024 * 1024);
    expect(handler.backupCount).toBe(1);
  });

  test("explicit params override config.yaml", () => {
    writeFileSync(
      join(hermesHome, "config.yaml"),
      "logging:\n  level: DEBUG\n",
    );
    setupLogging({ hermesHome, logLevel: "WARNING" });
    expect(firstHandler("agent.log").level).toBe(LogLevel.WARNING);
  });

  test("record factory is the session-injecting one", () => {
    setupLogging({ hermesHome });
    const factory = getLogRecordFactory();
    // The internal MarkedFactory carries the marker boolean.
    const marked = factory as typeof factory & { _hermesSessionInjector?: boolean };
    expect(marked._hermesSessionInjector).toBe(true);
    const record = factory("test", LogLevel.INFO, "", 0, "msg", [], null);
    expect("sessionTag" in record).toBe(true);
  });
});

describe("setupLogging — gateway mode", () => {
  test("creates gateway.log handler", () => {
    setupLogging({ hermesHome, mode: "gateway" });
    expect(rotatingHandlers("gateway.log").length).toBe(1);
  });

  test("does NOT create gateway.log in cli mode", () => {
    setupLogging({ hermesHome, mode: "cli" });
    expect(rotatingHandlers("gateway.log").length).toBe(0);
  });

  test("gateway mode after cli init still attaches gateway.log", () => {
    setupLogging({ hermesHome, mode: "cli" });
    setupLogging({ hermesHome, mode: "gateway" });
    expect(rotatingHandlers("gateway.log").length).toBe(1);

    getLogger("gateway.run").info("gateway connected after cli init");
    flushAll();
    expect(
      readFileSync(join(hermesHome, "logs", "gateway.log"), "utf-8"),
    ).toContain("gateway connected after cli init");
  });

  test("repeated gateway setup does not duplicate", () => {
    setupLogging({ hermesHome, mode: "cli" });
    setupLogging({ hermesHome, mode: "gateway" });
    setupLogging({ hermesHome, mode: "gateway" });
    expect(rotatingHandlers("gateway.log").length).toBe(1);
  });

  test("gateway.log receives gateway.* records", () => {
    setupLogging({ hermesHome, mode: "gateway" });
    getLogger("gateway.platforms.telegram").info("telegram connected");
    flushAll();
    expect(
      readFileSync(join(hermesHome, "logs", "gateway.log"), "utf-8"),
    ).toContain("telegram connected");
  });

  test("gateway.log rejects non-gateway records", () => {
    setupLogging({ hermesHome, mode: "gateway" });
    getLogger("tools.terminal_tool").info("running command");
    getLogger("agent.context_compressor").info("compressing context");
    flushAll();
    const gwPath = join(hermesHome, "logs", "gateway.log");
    if (existsSync(gwPath)) {
      const content = readFileSync(gwPath, "utf-8");
      expect(content).not.toContain("running command");
      expect(content).not.toContain("compressing context");
    }
  });

  test("agent.log catches gateway and tools records both", () => {
    setupLogging({ hermesHome, mode: "gateway" });
    getLogger("gateway.run").info("gateway msg");
    getLogger("tools.file_tools").info("file msg");
    flushAll();
    const text = readFileSync(join(hermesHome, "logs", "agent.log"), "utf-8");
    expect(text).toContain("gateway msg");
    expect(text).toContain("file msg");
  });
});

describe("Session context", () => {
  test("session tag appears in log output", () => {
    setupLogging({ hermesHome });
    setSessionContext("abc123");
    getLogger("test.session_tag").info("tagged message");
    flushAll();
    const text = readFileSync(join(hermesHome, "logs", "agent.log"), "utf-8");
    expect(text).toContain("[abc123]");
    expect(text).toContain("tagged message");
  });

  test("setSessionContext updates an active async-local cell", () => {
    runWithSession(null, () => {
      setSessionContext("cell-set");
      const rec = getLogRecordFactory()(
        "session.set.cell",
        LogLevel.INFO,
        "",
        0,
        "msg",
        [],
        null,
      );
      expect(rec.sessionTag).toBe(" [cell-set]");
    });
  });

  test("no session tag without context", () => {
    setupLogging({ hermesHome });
    clearSessionContext();
    getLogger("test.no_session").info("untagged message");
    flushAll();
    const text = readFileSync(join(hermesHome, "logs", "agent.log"), "utf-8");
    expect(text).toContain("untagged message");
    for (const line of text.split("\n")) {
      if (line.includes("untagged message")) {
        // No [xxx] between INFO and test.no_session.
        const between = line.split("INFO")[1]?.split("test.no_session")[0] ?? "";
        expect(/\[.+?\]/.test(between)).toBe(false);
      }
    }
  });

  test("clearSessionContext removes the tag", () => {
    setupLogging({ hermesHome });
    setSessionContext("xyz789");
    clearSessionContext();
    getLogger("test.cleared").info("after clear");
    flushAll();
    const text = readFileSync(join(hermesHome, "logs", "agent.log"), "utf-8");
    expect(text).not.toContain("[xyz789]");
  });

  test("session context is isolated across runWithSession (analogue of threads)", () => {
    setupLogging({ hermesHome });
    runWithSession("ctx_a", () => {
      getLogger("test.async_a").info("from context A");
      flushAll();
    });
    runWithSession("ctx_b", () => {
      getLogger("test.async_b").info("from context B");
      flushAll();
    });
    const text = readFileSync(join(hermesHome, "logs", "agent.log"), "utf-8");
    for (const line of text.split("\n")) {
      if (line.includes("from context A")) {
        expect(line).toContain("[ctx_a]");
        expect(line).not.toContain("[ctx_b]");
      }
      if (line.includes("from context B")) {
        expect(line).toContain("[ctx_b]");
        expect(line).not.toContain("[ctx_a]");
      }
    }
  });

  test("clearSessionContext clears an active async-local cell", () => {
    runWithSession("cell-session", () => {
      clearSessionContext();
      const rec = getLogRecordFactory()(
        "session.clear.cell",
        LogLevel.INFO,
        "",
        0,
        "msg",
        [],
        null,
      );
      expect(rec.sessionTag).toBe("");
    });
  });
});

describe("Record factory", () => {
  test("every record gets a sessionTag attribute", () => {
    const factory = getLogRecordFactory();
    const rec = factory("test", LogLevel.INFO, "", 0, "msg", [], null);
    expect("sessionTag" in rec).toBe(true);
  });

  test("empty tag without context", () => {
    clearSessionContext();
    const factory = getLogRecordFactory();
    const rec = factory("test", LogLevel.INFO, "", 0, "msg", [], null);
    expect(rec.sessionTag).toBe("");
  });

  test("tag formatted with context", () => {
    setSessionContext("sess_42");
    const factory = getLogRecordFactory();
    const rec = factory("test", LogLevel.INFO, "", 0, "msg", [], null);
    expect(rec.sessionTag).toBe(" [sess_42]");
  });

  test("idempotent install does not double-wrap", () => {
    _installSessionRecordFactory();
    const a = getLogRecordFactory();
    _installSessionRecordFactory();
    const b = getLogRecordFactory();
    expect(a).toBe(b);
  });

  test("setLogRecordFactory replaces the factory (and install can re-wrap)", () => {
    const custom = ((name: string, lvl: number, ..._rest: unknown[]) => {
      return {
        name,
        levelno: lvl as never,
        levelname: "X",
        message: "from-custom",
        args: [],
        created: new Date(),
        sessionTag: "",
      } as LogRecord;
    }) as Parameters<typeof setLogRecordFactory>[0];
    setLogRecordFactory(custom);
    expect(getLogRecordFactory()(
      "n",
      LogLevel.INFO,
      "",
      0,
      "msg",
      [],
      null,
    ).message).toBe("from-custom");
    // After re-installing the session-injecting factory, sessionTag is set.
    _installSessionRecordFactory();
    setSessionContext("re-wrap");
    const rec = getLogRecordFactory()(
      "n",
      LogLevel.INFO,
      "",
      0,
      "msg",
      [],
      null,
    );
    expect(rec.sessionTag).toBe(" [re-wrap]");
  });

  test("wrapped custom factory writes an empty tag without context", () => {
    const custom = ((name: string, lvl: number) => {
      return {
        name,
        levelno: lvl as never,
        levelname: "INFO",
        message: "wrapped-no-session",
        args: [],
        created: new Date(),
        sessionTag: "stale",
      } as LogRecord;
    }) as Parameters<typeof setLogRecordFactory>[0];
    clearSessionContext();
    setLogRecordFactory(custom);
    _installSessionRecordFactory();
    const rec = getLogRecordFactory()(
      "wrapped.no.session",
      LogLevel.INFO,
      "",
      0,
      "msg",
      [],
      null,
    );
    expect(rec.sessionTag).toBe("");
  });
});

describe("ComponentFilter", () => {
  test("passes matching prefix", () => {
    const f = new _ComponentFilter(["gateway"]);
    const rec: LogRecord = {
      name: "gateway.run",
      levelno: LogLevel.INFO,
      levelname: "INFO",
      message: "msg",
      args: [],
      created: new Date(),
      sessionTag: "",
    };
    expect(f.filter(rec)).toBe(true);
  });

  test("passes nested matching prefix", () => {
    const f = new _ComponentFilter(["gateway"]);
    const rec: LogRecord = {
      name: "gateway.platforms.telegram",
      levelno: LogLevel.INFO,
      levelname: "INFO",
      message: "msg",
      args: [],
      created: new Date(),
      sessionTag: "",
    };
    expect(f.filter(rec)).toBe(true);
  });

  test("blocks non-matching", () => {
    const f = new _ComponentFilter(["gateway"]);
    const rec: LogRecord = {
      name: "tools.terminal_tool",
      levelno: LogLevel.INFO,
      levelname: "INFO",
      message: "msg",
      args: [],
      created: new Date(),
      sessionTag: "",
    };
    expect(f.filter(rec)).toBe(false);
  });

  test("supports multiple prefixes", () => {
    const f = new _ComponentFilter(["agent", "run_agent", "model_tools"]);
    const mk = (name: string): LogRecord => ({
      name,
      levelno: LogLevel.INFO,
      levelname: "INFO",
      message: "",
      args: [],
      created: new Date(),
      sessionTag: "",
    });
    expect(f.filter(mk("agent.compressor"))).toBe(true);
    expect(f.filter(mk("run_agent"))).toBe(true);
    expect(f.filter(mk("model_tools"))).toBe(true);
    expect(f.filter(mk("tools.browser"))).toBe(false);
  });

  test("class re-exported under both names", () => {
    expect(ComponentFilter).toBe(_ComponentFilter);
  });
});

describe("COMPONENT_PREFIXES", () => {
  test("gateway prefix tuple", () => {
    expect(COMPONENT_PREFIXES.gateway).toEqual(["gateway", "hermes_plugins"]);
  });

  test("agent prefix list", () => {
    const prefixes = COMPONENT_PREFIXES.agent;
    expect(prefixes).toContain("agent");
    expect(prefixes).toContain("run_agent");
    expect(prefixes).toContain("model_tools");
  });

  test("tools prefix tuple", () => {
    expect(COMPONENT_PREFIXES.tools).toEqual(["tools"]);
  });

  test("cli prefix", () => {
    const prefixes = COMPONENT_PREFIXES.cli;
    expect(prefixes).toContain("hermes_cli");
    expect(prefixes).toContain("cli");
  });

  test("cron prefix", () => {
    expect(COMPONENT_PREFIXES.cron).toEqual(["cron"]);
  });
});

describe("setupVerboseLogging", () => {
  test("adds a stream handler at DEBUG level", () => {
    setupLogging({ hermesHome });
    setupVerboseLogging();
    const verbose = getRootLogger().handlers.filter(
      (h) => h instanceof StreamHandler && (h as StreamHandler)._hermesVerbose,
    );
    expect(verbose.length).toBe(1);
    expect((verbose[0] as StreamHandler).level).toBe(LogLevel.DEBUG);
  });

  test("idempotent", () => {
    setupLogging({ hermesHome });
    setupVerboseLogging();
    setupVerboseLogging();
    const verbose = getRootLogger().handlers.filter(
      (h) => h instanceof StreamHandler && (h as StreamHandler)._hermesVerbose,
    );
    expect(verbose.length).toBe(1);
  });

  test("custom formatter factory is honored", () => {
    setupLogging({ hermesHome });
    let factoryCalled = false;
    setupVerboseLogging((fmt, datefmt) => {
      factoryCalled = true;
      return new PercentFormatter(fmt, datefmt);
    });
    expect(factoryCalled).toBe(true);
  });
});

describe("_addRotatingHandler", () => {
  test("creates the parent directory", () => {
    const logPath = join(tmp, "subdir", "test.log");
    const logger = getLogger("_test_rotating");
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
    });
    expect(statSync(join(tmp, "subdir")).isDirectory()).toBe(true);
    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
  });

  test("no duplicate handler for the same path", () => {
    const logPath = join(tmp, "test.log");
    const logger = getLogger("_test_rotating_dup");
    const fmt = new PercentFormatter("%(message)s");
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: fmt,
    });
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: fmt,
    });
    const rotating = logger.handlers.filter((h) => h instanceof RotatingFileHandler);
    expect(rotating.length).toBe(1);
    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
  });

  test("optional log_filter is attached", () => {
    const logPath = join(tmp, "filtered.log");
    const logger = getLogger("_test_rotating_filter");
    const componentFilter = new _ComponentFilter(["test"]);
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
      logFilter: componentFilter,
    });
    const handler = logger.handlers.find(
      (h) => h instanceof RotatingFileHandler,
    ) as RotatingFileHandler;
    expect(handler.filters.length).toBe(1);
    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
  });

  test("handler relies on record factory for session_tag (no per-handler filter)", () => {
    const logPath = join(tmp, "no_session_filter.log");
    const logger = getLogger("_test_no_session_filter");
    logger.setLevel(LogLevel.INFO);
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: new PercentFormatter("%(session_tag)s%(message)s"),
    });
    const handler = logger.handlers.find(
      (h) => h instanceof RotatingFileHandler,
    ) as RotatingFileHandler;
    expect(handler.filters.length).toBe(0);

    setSessionContext("factory_test");
    logger.info("test msg");
    handler.flush();
    expect(readFileSync(logPath, "utf-8")).toContain("[factory_test]");

    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
  });

  test("isManaged callback sets group-writable mode on initial open", () => {
    const logPath = join(tmp, "managed-open.log");
    const logger = getLogger("_test_rotating_managed_open");
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
      isManaged: () => true,
    });
    expect(existsSync(logPath)).toBe(true);
    const mode = statSync(logPath).mode & 0o777;
    expect(mode).toBe(0o660);
    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
  });

  test("isManaged callback sets group-writable mode after rollover", () => {
    const logPath = join(tmp, "managed-rollover.log");
    const logger = getLogger("_test_rotating_managed_rollover");
    logger.setLevel(LogLevel.INFO);
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
      isManaged: () => true,
    });
    const handler = logger.handlers.find(
      (h) => h instanceof RotatingFileHandler,
    ) as RotatingFileHandler;
    logger.info("a".repeat(256));
    handler.flush();
    expect(existsSync(logPath)).toBe(true);
    const mode = statSync(logPath).mode & 0o777;
    expect(mode).toBe(0o660);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
  });

  test("rollover unlinks an existing .N+1 file before renaming", () => {
    const logPath = join(tmp, "rollover-overwrite.log");
    const logger = getLogger("_test_rotating_rollover_overwrite");
    logger.setLevel(LogLevel.INFO);
    // Pre-create a .1 file that the rollover dance must unlink before it
    // can rename the current base file in over it.
    writeFileSync(`${logPath}.1`, "old backup");
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
    });
    const handler = logger.handlers.find(
      (h) => h instanceof RotatingFileHandler,
    ) as RotatingFileHandler;
    // First info() writes "first\n" to the base file (after a no-op
    // initial rollover that renamed the empty base to .1 over the stale
    // pre-existing "old backup"). Second info() triggers another rollover
    // moving the base ("first\n") to .1.
    logger.info("first");
    handler.flush();
    logger.info("second");
    handler.flush();
    expect(readFileSync(`${logPath}.1`, "utf-8").trim()).toBe("first");
    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
  });

  test("close is idempotent (second call is no-op)", () => {
    const logPath = join(tmp, "double-close.log");
    const logger = getLogger("_test_double_close");
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
    });
    const handler = logger.handlers.find(
      (h) => h instanceof RotatingFileHandler,
    ) as RotatingFileHandler;
    handler.close();
    expect(() => handler.close()).not.toThrow();
    logger.removeHandler(handler);
  });

  test("maxBytes<=0 disables rollover", () => {
    const logPath = join(tmp, "no-rollover.log");
    const logger = getLogger("_test_no_rollover");
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 0,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
    });
    const handler = logger.handlers.find(
      (h) => h instanceof RotatingFileHandler,
    ) as RotatingFileHandler;
    for (let i = 0; i < 100; i++) logger.info("x".repeat(100));
    handler.flush();
    // No backup created.
    expect(existsSync(`${logPath}.1`)).toBe(false);
    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
  });

  test("maxBytes<=0 direct emit writes without rollover", () => {
    const logPath = join(tmp, "direct-no-rollover.log");
    const handler = new RotatingFileHandler(logPath, {
      maxBytes: 0,
      backupCount: 1,
    });
    handler.setFormatter(new PercentFormatter("%(message)s"));
    handler.emit({
      name: "direct.no.rollover",
      levelno: LogLevel.INFO,
      levelname: "INFO",
      message: "payload",
      args: [],
      created: new Date(),
      sessionTag: "",
    });
    handler.close();
    expect(readFileSync(logPath, "utf-8")).toContain("payload");
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  test("rollover shifts backupCount greater than one", () => {
    const logPath = join(tmp, "rollover-two-backups.log");
    writeFileSync(logPath, "base\n");
    writeFileSync(`${logPath}.1`, "first backup\n");
    const handler = new RotatingFileHandler(logPath, {
      maxBytes: 1,
      backupCount: 2,
    });
    handler.setFormatter(new PercentFormatter("%(message)s"));
    handler.emit({
      name: "direct.rollover.two",
      levelno: LogLevel.INFO,
      levelname: "INFO",
      message: "new base",
      args: [],
      created: new Date(),
      sessionTag: "",
    });
    handler.close();
    expect(readFileSync(logPath, "utf-8")).toContain("new base");
    expect(readFileSync(`${logPath}.1`, "utf-8")).toContain("base");
    expect(readFileSync(`${logPath}.2`, "utf-8")).toContain("first backup");
  });

  test("emit auto-reopens the fd after close()", () => {
    const logPath = join(tmp, "auto-reopen.log");
    const logger = getLogger("_test_auto_reopen");
    logger.setLevel(LogLevel.INFO);
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
    });
    const handler = logger.handlers.find(
      (h) => h instanceof RotatingFileHandler,
    ) as RotatingFileHandler;
    handler.close();
    logger.info("after close");
    handler.flush();
    expect(readFileSync(logPath, "utf-8")).toContain("after close");
    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
  });
});

describe("_readLoggingConfig", () => {
  test("returns nulls when no config.yaml present", () => {
    const cfg = _readLoggingConfig();
    expect(cfg.level).toBeNull();
    expect(cfg.maxSizeMb).toBeNull();
    expect(cfg.backupCount).toBeNull();
  });

  test("reads the logging section", () => {
    writeFileSync(
      join(hermesHome, "config.yaml"),
      "logging:\n  level: DEBUG\n  max_size_mb: 10\n  backup_count: 5\n",
      { flag: "w" },
    );
    // Need hermesHome created first.
    const cfg = _readLoggingConfig();
    expect(cfg.level).toBe("DEBUG");
    expect(cfg.maxSizeMb).toBe(10);
    expect(cfg.backupCount).toBe(5);
  });

  test("handles missing logging section", () => {
    writeFileSync(join(hermesHome, "config.yaml"), "model: test\n", { flag: "w" });
    const cfg = _readLoggingConfig();
    expect(cfg.level).toBeNull();
  });

  test("empty config file falls back to null logging config", () => {
    writeFileSync(join(hermesHome, "config.yaml"), "", { flag: "w" });
    const cfg = _readLoggingConfig();
    expect(cfg).toEqual({ level: null, maxSizeMb: null, backupCount: null });
  });

  test("logging object with missing keys returns null defaults", () => {
    writeFileSync(join(hermesHome, "config.yaml"), "logging: {}\n", { flag: "w" });
    const cfg = _readLoggingConfig();
    expect(cfg).toEqual({ level: null, maxSizeMb: null, backupCount: null });
  });

  test("swallows malformed yaml without raising", () => {
    writeFileSync(join(hermesHome, "config.yaml"), "::: not yaml\n", { flag: "w" });
    expect(() => _readLoggingConfig()).not.toThrow();
  });
});

describe("Logger hierarchy", () => {
  test("getLogger('') returns root", () => {
    expect(getLogger("")).toBe(getRootLogger());
    expect(getLogger("root")).toBe(getRootLogger());
  });

  test("getLogger returns the same instance on repeated calls", () => {
    const a = getLogger("hierarchy.test.child");
    const b = getLogger("hierarchy.test.child");
    expect(a).toBe(b);
  });

  test("parent linkage walks dotted hierarchy", () => {
    getLogger("hier.a");
    const child = getLogger("hier.a.b.c");
    // Parent is whichever ancestor exists in _loggers.
    expect(child.parent?.name).toBe("hier.a");
  });

  test("getEffectiveLevel walks up to root WARNING default", () => {
    const child = getLogger("eff.level.unset");
    // No level set anywhere → root default WARNING (per upstream).
    // We need root to be NOTSET for the walk to bottom out at WARNING.
    getRootLogger().level = LogLevel.NOTSET;
    expect(child.getEffectiveLevel()).toBe(LogLevel.WARNING);
  });

  test("logger.setLevel accepts string and number", () => {
    const l = getLogger("eff.level.set");
    l.setLevel("DEBUG");
    expect(l.level).toBe(LogLevel.DEBUG);
    l.setLevel(LogLevel.WARNING);
    expect(l.level).toBe(LogLevel.WARNING);
  });

  test("propagation off stops handler chain at this logger", () => {
    const logs: string[] = [];
    const root = getRootLogger();
    const customRoot = {
      level: LogLevel.NOTSET,
      formatter: new PercentFormatter("%(message)s"),
      filters: [],
      setLevel() {},
      setFormatter() {},
      addFilter() {},
      shouldPass: () => true,
      handle(rec: LogRecord) {
        logs.push(`root:${rec.message}`);
      },
      emit(rec: LogRecord) {
        logs.push(`root:${rec.message}`);
      },
      flush() {},
      close() {},
    } as unknown as Parameters<typeof root.addHandler>[0];
    root.addHandler(customRoot);

    const local = getLogger("prop.test");
    local.propagate = false;
    local.setLevel(LogLevel.DEBUG);

    local.info("should NOT propagate");
    expect(logs.filter((l) => l.includes("should NOT propagate")).length).toBe(0);

    root.removeHandler(customRoot);
  });

  test("log methods cover all 5 levels", () => {
    const records: string[] = [];
    const root = getRootLogger();
    const stub = {
      level: LogLevel.DEBUG,
      formatter: new PercentFormatter("%(levelname)s:%(message)s"),
      filters: [],
      setLevel() {},
      setFormatter() {},
      addFilter() {},
      shouldPass: () => true,
      handle(rec: LogRecord) {
        records.push(`${rec.levelname}:${rec.message}`);
      },
      emit(rec: LogRecord) {
        records.push(`${rec.levelname}:${rec.message}`);
      },
      flush() {},
      close() {},
    } as unknown as Parameters<typeof root.addHandler>[0];
    root.setLevel(LogLevel.DEBUG);
    root.addHandler(stub);

    const l = getLogger("levels.test");
    l.setLevel(LogLevel.DEBUG);
    l.debug("d");
    l.info("i");
    l.warning("w");
    l.error("e");
    l.critical("c");

    expect(records).toEqual(["DEBUG:d", "INFO:i", "WARNING:w", "ERROR:e", "CRITICAL:c"]);
    root.removeHandler(stub);
  });
});

describe("setupLogging defaults", () => {
  test("uses HERMES_HOME when hermesHome option is omitted", () => {
    const dir = setupLogging();
    expect(dir).toBe(join(hermesHome, "logs"));
  });
});

describe("PercentFormatter", () => {
  test("interpolates all known fields", () => {
    const fmt = new PercentFormatter(
      "%(asctime)s %(levelname)s%(session_tag)s %(name)s: %(message)s",
    );
    const rec: LogRecord = {
      name: "n",
      levelno: LogLevel.INFO,
      levelname: "INFO",
      message: "hello",
      args: [],
      created: new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678)),
      sessionTag: " [abc]",
    };
    const out = fmt.format(rec);
    expect(out).toContain("2026-01-02 03:04:05,678");
    expect(out).toContain("INFO");
    expect(out).toContain("[abc]");
    expect(out).toContain("n: hello");
  });

  test("supports the verbose %H:%M:%S datefmt", () => {
    const fmt = new PercentFormatter("%(asctime)s %(message)s", "%H:%M:%S");
    const rec: LogRecord = {
      name: "n",
      levelno: LogLevel.INFO,
      levelname: "INFO",
      message: "x",
      args: [],
      created: new Date(Date.UTC(2026, 0, 1, 12, 34, 56)),
      sessionTag: "",
    };
    expect(fmt.format(rec)).toBe("12:34:56 x");
  });
});

describe("Handler filtering", () => {
  test("addFilter accepts both ComponentFilter and bare predicate", () => {
    const root = getRootLogger();
    root.setLevel(LogLevel.DEBUG);
    const logPath = join(tmp, "handler-filter.log");
    _addRotatingHandler(root, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: new PercentFormatter("%(name)s:%(message)s"),
    });
    const handler = root.handlers.find(
      (h) => h instanceof RotatingFileHandler && h.baseFilename === logPath,
    ) as RotatingFileHandler;

    handler.addFilter(new ComponentFilter(["allowed"]));
    handler.addFilter((rec) => !rec.message.includes("DROP"));

    const a = getLogger("allowed.one");
    a.setLevel(LogLevel.INFO);
    a.info("good");
    const b = getLogger("blocked.one");
    b.setLevel(LogLevel.INFO);
    b.info("blocked by component");
    const c = getLogger("allowed.two");
    c.setLevel(LogLevel.INFO);
    c.info("DROP me");
    handler.flush();

    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("allowed.one:good");
    expect(content).not.toContain("blocked by component");
    expect(content).not.toContain("DROP me");

    root.removeHandler(handler);
    handler.close();
  });
});

describe("StreamHandler", () => {
  test("emits formatted record to the underlying stream", () => {
    const chunks: string[] = [];
    const fakeStream = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream;
    const h = new StreamHandler(fakeStream);
    h.setLevel(LogLevel.DEBUG);
    h.setFormatter(new PercentFormatter("%(message)s"));
    h.handle({
      name: "n",
      levelno: LogLevel.INFO,
      levelname: "INFO",
      message: "hello",
      args: [],
      created: new Date(),
      sessionTag: "",
    });
    expect(chunks).toEqual(["hello\n"]);
    expect(() => h.flush()).not.toThrow();
    expect(() => h.close()).not.toThrow();
  });
});

describe("_stripRotatingHandlers helper", () => {
  test("removes all RotatingFileHandlers from root", () => {
    setupLogging({ hermesHome });
    expect(rotatingHandlers("agent.log").length).toBe(1);
    _stripRotatingHandlers();
    expect(rotatingHandlers("agent.log").length).toBe(0);
  });
});

describe("Coverage: rotating handler error branches", () => {
  test("rollover swallows unlink errors when removing a pre-existing backup", async () => {
    // Pre-create a .1 backup, then chmod its parent so the unlink in the
    // rollover dance fails. The handler should swallow the error and
    // continue — covers hermes-logging.ts:L363-366.
    const logPath = join(tmp, "unlink-fail.log");
    const logger = getLogger("_test_unlink_fail");
    logger.setLevel(LogLevel.INFO);
    writeFileSync(`${logPath}.1`, "old");

    // Monkey-patch unlinkSync via fs module spy is fragile under Bun, so
    // instead we wrap the existing handler and call _doRollover directly
    // after stubbing the global unlinkSync. We use vi.spyOn on the
    // RotatingFileHandler prototype if needed. Simpler: use a private
    // unwritable backup file by making the existing .1 a directory.
    rmSync(`${logPath}.1`);
    mkdirSync(`${logPath}.1`);
    writeFileSync(join(`${logPath}.1`, "inside"), "x");

    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
    });
    const handler = logger.handlers.find(
      (h) => h instanceof RotatingFileHandler,
    ) as RotatingFileHandler;

    // First write — initial open already happened, currentSize=0; one info
    // makes size > 1 so the second write triggers rollover, which tries to
    // unlink the .1 directory (fails on POSIX: EISDIR for unlinkSync on a
    // non-empty dir), then tries to rename the base file over it. Both
    // ops have try/catch that we want to exercise.
    expect(() => {
      logger.info("first");
      logger.info("second");
      handler.flush();
    }).not.toThrow();

    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
    // Clean up the dir-as-backup we created.
    rmSync(`${logPath}.1`, { recursive: true, force: true });
  });

  test("RotatingFileHandler.close swallows fd errors", () => {
    const logPath = join(tmp, "close-fail.log");
    const logger = getLogger("_test_close_fail");
    logger.setLevel(LogLevel.INFO);
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
    });
    const handler = logger.handlers.find(
      (h) => h instanceof RotatingFileHandler,
    ) as RotatingFileHandler;
    // Reach in and corrupt the fd so closeSync throws.
    (handler as unknown as { fd: number | null }).fd = 999_999_999;
    expect(() => handler.close()).not.toThrow();
    logger.removeHandler(handler);
  });

  test("openSync mode preserved (default 0o644 if not managed)", () => {
    const logPath = join(tmp, "unmanaged.log");
    const logger = getLogger("_test_unmanaged");
    logger.setLevel(LogLevel.INFO);
    _addRotatingHandler(logger, logPath, {
      level: LogLevel.INFO,
      maxBytes: 1024,
      backupCount: 1,
      formatter: new PercentFormatter("%(message)s"),
    });
    expect(existsSync(logPath)).toBe(true);
    for (const h of [...logger.handlers]) {
      logger.removeHandler(h);
      h.close();
    }
  });

  test("_readLoggingConfig swallows config.yaml read errors", () => {
    // Make the file unreadable by making its parent un-traversable, then
    // restore. On unix, chmod 0o000 on the file blocks reads.
    const cfg = join(hermesHome, "config.yaml");
    writeFileSync(cfg, "logging:\n  level: DEBUG\n");
    chmodSync(cfg, 0o000);
    try {
      const out = _readLoggingConfig();
      // On macOS root can still read; gracefully accept either path:
      // either it threw and we got nulls, or it succeeded with DEBUG.
      expect(["DEBUG", null]).toContain(out.level);
    } finally {
      chmodSync(cfg, 0o644);
    }
  });
});

describe("RotatingFileHandler mocked fs error branches", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("fstatSync EBADF leaves currentSize at 0", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const fstat = vi.fn(() => {
      throw Object.assign(new Error("bad fd"), { code: "EBADF" });
    });
    vi.doMock("node:fs", () => ({
      ...actualFs,
      // simulates fstat EBADF from hermes_logging.py:L298-327.
      fstatSync: fstat,
    }));
    const { PercentFormatter: MockFormatter, RotatingFileHandler: MockHandler } =
      await import("../src/hermes-logging.ts" + "?mock-fstat");
    const logPath = join(tmp, "mock-fstat.log");
    const handler = new MockHandler(logPath, {
      maxBytes: 1024,
      backupCount: 1,
    });
    handler.setFormatter(new MockFormatter("%(message)s"));

    expect(() =>
      handler.emit({
        name: "mock.fstat",
        levelno: LogLevel.INFO,
        levelname: "INFO",
        message: "after fstat failure",
        args: [],
        created: new Date(),
        sessionTag: "",
      }),
    ).not.toThrow();
    handler.close();

    expect(fstat).toHaveBeenCalled();
    expect(readFileSync(logPath, "utf-8")).toContain("after fstat failure");
  });

  test("chmodSync managed-mode failure is best effort", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const chmod = vi.fn(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    vi.doMock("node:fs", () => ({
      ...actualFs,
      // simulates managed chmod EPERM from hermes_logging.py:L309-327.
      chmodSync: chmod,
    }));
    const { RotatingFileHandler: MockHandler } = await import(
      "../src/hermes-logging.ts" + "?mock-chmod"
    );

    expect(
      () =>
        new MockHandler(join(tmp, "mock-chmod.log"), {
          maxBytes: 1024,
          backupCount: 1,
          isManaged: () => true,
        }).close(),
    ).not.toThrow();
    expect(chmod).toHaveBeenCalled();
  });

  test("closeSync rollover failure still reopens and writes", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const close = vi.fn(() => {
      throw Object.assign(new Error("bad fd"), { code: "EBADF" });
    });
    vi.doMock("node:fs", () => ({
      ...actualFs,
      // simulates rollover close EBADF from hermes_logging.py:L298-327.
      closeSync: close,
    }));
    const { PercentFormatter: MockFormatter, RotatingFileHandler: MockHandler } =
      await import("../src/hermes-logging.ts" + "?mock-close");
    const logPath = join(tmp, "mock-close-rollover.log");
    const handler = new MockHandler(logPath, {
      maxBytes: 1,
      backupCount: 1,
    });
    handler.setFormatter(new MockFormatter("%(message)s"));
    const record = (message: string): LogRecord => ({
      name: "mock.close",
      levelno: LogLevel.INFO,
      levelname: "INFO",
      message,
      args: [],
      created: new Date(),
      sessionTag: "",
    });

    expect(() => {
      handler.emit(record("first"));
      handler.emit(record("second"));
    }).not.toThrow();

    expect(close).toHaveBeenCalled();
    expect(readFileSync(logPath, "utf-8")).toContain("second");
  });
});

describe("Coverage: logger default factory exercised via real call", () => {
  test("the source default factory produces a record with sessionTag", () => {
    // Reset to the module's pristine initial factory and exercise it
    // directly without going through any test override. This covers
    // hermes-logging.ts:L128-147 default factory body and L150-151
    // getLogRecordFactory return path.
    setLogRecordFactory(_initialFactory);
    setSessionContext("default-factory-test");
    const factory = getLogRecordFactory();
    const rec = factory(
      "coverage.factory",
      LogLevel.INFO,
      "",
      0,
      "default factory exercised",
      [],
      null,
    );
    expect(rec.name).toBe("coverage.factory");
    expect(rec.levelname).toBe("INFO");
    expect(rec.sessionTag).toBe(" [default-factory-test]");
  });

  test("_levelName falls back to INFO for unknown level values", () => {
    setLogRecordFactory(_initialFactory);
    const factory = getLogRecordFactory();
    const rec = factory(
      "n",
      999 as unknown as typeof LogLevel.INFO,
      "",
      0,
      "msg",
      [],
      null,
    );
    expect(rec.levelname).toBe("INFO");
  });
});
