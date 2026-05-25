import { describe, it, expect } from "vitest";
import { AssertionError, MockLogger, type LogEntry } from "../src/mock-logger.js";

describe("MockLogger", () => {
  it("captures entries at every level with args and a timestamp", () => {
    const logger = new MockLogger("svc", () => new Date("2024-06-01T00:00:00Z"));

    logger.debug("d", 1);
    logger.info("i", { k: "v" });
    logger.warning("w");
    logger.error("e", "extra");
    logger.critical("c");

    expect(logger.entries.length).toBe(5);
    expect(logger.entries[0]).toMatchObject({
      level: "debug",
      message: "d",
      args: [1],
    });
    expect(logger.entries[0]!.timestamp.toISOString()).toBe("2024-06-01T00:00:00.000Z");
    expect(logger.entries[1]!.args[0]).toEqual({ k: "v" });
    expect(logger.entries[2]!.level).toBe("warning");
    expect(logger.entries[3]!.args).toEqual(["extra"]);
    expect(logger.entries[4]!.level).toBe("critical");
  });

  it("defaults name to 'mock' and nowFn to a fresh Date", () => {
    const before = Date.now();
    const logger = new MockLogger();
    logger.info("hi");
    const after = Date.now();
    expect(logger.name).toBe("mock");
    const ts = logger.entries[0]!.timestamp.getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("entriesAt returns only the requested level", () => {
    const logger = new MockLogger();
    logger.info("a");
    logger.error("b");
    logger.info("c");
    expect(logger.entriesAt("info").map((e) => e.message)).toEqual(["a", "c"]);
    expect(logger.entriesAt("error").map((e) => e.message)).toEqual(["b"]);
    expect(logger.entriesAt("debug")).toEqual([]);
  });

  it("clear() wipes captured entries", () => {
    const logger = new MockLogger();
    logger.info("a");
    logger.clear();
    expect(logger.entries).toEqual([]);
  });

  describe("assertLogged", () => {
    it("matches a substring", () => {
      const logger = new MockLogger();
      logger.info("connection opened to db1");
      const hit = logger.assertLogged("info", "db1");
      expect(hit.message).toContain("db1");
    });

    it("matches a RegExp", () => {
      const logger = new MockLogger();
      logger.error("timeout after 5000ms");
      const hit = logger.assertLogged("error", /timeout after \d+ms/);
      expect(hit.message).toMatch(/timeout/);
    });

    it("matches a predicate", () => {
      const logger = new MockLogger();
      logger.warning("retry", 3);
      const hit = logger.assertLogged("warning", (e: LogEntry) => e.args[0] === 3);
      expect(hit.args).toEqual([3]);
    });

    it("uses the predicate's name in the failure message when present", () => {
      const logger = new MockLogger();
      logger.info("hello");
      function customPredicate(e: LogEntry) {
        return e.message === "absent";
      }
      expect(() => logger.assertLogged("info", customPredicate)).toThrow(/customPredicate/);
    });

    it("handles anonymous predicate gracefully in the error message", () => {
      const logger = new MockLogger();
      logger.info("hi");
      const anon = ((e: LogEntry) => e.message === "absent") as (e: LogEntry) => boolean;
      Object.defineProperty(anon, "name", { value: "" });
      expect(() => logger.assertLogged("info", anon)).toThrow(/matching predicate;/);
    });

    it("throws AssertionError when no entries exist at the level", () => {
      const logger = new MockLogger();
      expect(() => logger.assertLogged("error", "nope")).toThrow(AssertionError);
      expect(() => logger.assertLogged("error", "nope")).toThrow(/no error entries captured/);
    });

    it("throws AssertionError with dump when entries exist but none match", () => {
      const logger = new MockLogger();
      logger.info("first");
      logger.info("second");
      try {
        logger.assertLogged("info", "third");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(AssertionError);
        expect((e as Error).message).toContain("first");
        expect((e as Error).message).toContain("second");
        expect((e as Error).message).toContain('"third"');
      }
    });

    it("includes RegExp text in the failure message", () => {
      const logger = new MockLogger();
      logger.info("hello");
      expect(() => logger.assertLogged("info", /xyz/)).toThrow(/\/xyz\//);
    });
  });

  describe("assertCallCount", () => {
    it("passes when the count is exact", () => {
      const logger = new MockLogger();
      logger.info("a");
      logger.info("b");
      expect(() => logger.assertCallCount("info", 2)).not.toThrow();
    });

    it("throws AssertionError when the count differs", () => {
      const logger = new MockLogger();
      logger.info("a");
      expect(() => logger.assertCallCount("info", 2)).toThrow(AssertionError);
      expect(() => logger.assertCallCount("info", 2)).toThrow(/expected 2 info call\(s\); got 1/);
    });

    it("counts zero correctly", () => {
      const logger = new MockLogger();
      expect(() => logger.assertCallCount("debug", 0)).not.toThrow();
    });
  });
});

describe("AssertionError", () => {
  it("has the correct name", () => {
    const e = new AssertionError("nope");
    expect(e.name).toBe("AssertionError");
    expect(e.message).toBe("nope");
    expect(e).toBeInstanceOf(Error);
  });
});
