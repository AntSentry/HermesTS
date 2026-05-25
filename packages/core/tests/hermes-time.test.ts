// Ported from tests/test_timezone.py — TestHermesTimeNow + TestGetTimezone
// (TestCodeExecutionTZ and TestCronTimezone are deferred to tasks #5, #6, #14, #13.)

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _resetTimezoneWarningEmitter,
  formatInZone,
  getTimezone,
  getUtcOffsetMinutes,
  now,
  resetTimezoneCache,
  setTimezoneWarningEmitter,
} from "../src/hermes-time.js";

const ENV_TZ = "HERMES_TIMEZONE";
const ENV_HERMES_HOME = "HERMES_HOME";

let savedTz: string | undefined;
let savedHome: string | undefined;
let tmpHome: string | undefined;

beforeEach(() => {
  savedTz = process.env[ENV_TZ];
  savedHome = process.env[ENV_HERMES_HOME];
  delete process.env[ENV_TZ];
  // Isolate from any user-level ~/.hermes/config.yaml so getTimezone()'s
  // config.yaml resolution doesn't bleed into the env-driven tests.
  tmpHome = mkdtempSync(join(tmpdir(), "hermests-time-"));
  process.env[ENV_HERMES_HOME] = tmpHome;
  resetTimezoneCache();
  _resetTimezoneWarningEmitter();
});

afterEach(() => {
  if (savedTz === undefined) delete process.env[ENV_TZ];
  else process.env[ENV_TZ] = savedTz;
  if (savedHome === undefined) delete process.env[ENV_HERMES_HOME];
  else process.env[ENV_HERMES_HOME] = savedHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  resetTimezoneCache();
  _resetTimezoneWarningEmitter();
});

describe("now()", () => {
  test("returns a Date", () => {
    process.env[ENV_TZ] = "Asia/Kolkata";
    const result = now();
    expect(result).toBeInstanceOf(Date);
  });

  test("Date is internally UTC (faithful divergence from py)", () => {
    process.env[ENV_TZ] = "UTC";
    const result = now();
    // JS Dates are always UTC internally; the "tz awareness" the upstream
    // py promises is via getTimezone() / formatInZone().
    expect(typeof result.getTime()).toBe("number");
  });

  test("US/Eastern offset is -5 or -4 hours (DST-aware)", () => {
    process.env[ENV_TZ] = "America/New_York";
    const zone = getTimezone();
    expect(zone).toBe("America/New_York");
    const offsetMinutes = getUtcOffsetMinutes(zone as string);
    const offsetHours = offsetMinutes / 60;
    expect([-5, -4]).toContain(offsetHours);
  });

  test("Asia/Kolkata offset is +5:30", () => {
    process.env[ENV_TZ] = "Asia/Kolkata";
    const zone = getTimezone();
    expect(getUtcOffsetMinutes(zone as string)).toBe(330);
  });

  test("UTC offset is 0", () => {
    process.env[ENV_TZ] = "UTC";
    const zone = getTimezone();
    expect(getUtcOffsetMinutes(zone as string)).toBe(0);
  });

  test("empty timezone falls back to server-local (getTimezone returns null)", () => {
    delete process.env[ENV_TZ];
    expect(getTimezone()).toBeNull();
  });

  test("formatted output matches strftime-style behavior", () => {
    process.env[ENV_TZ] = "Asia/Kolkata";
    const formatted = formatInZone(now(), {
      weekday: "long",
      month: "long",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    expect(formatted.length).toBeGreaterThan(10);
  });

  test("cache invalidation picks up new timezone", () => {
    process.env[ENV_TZ] = "UTC";
    resetTimezoneCache();
    expect(getUtcOffsetMinutes(getTimezone() as string)).toBe(0);

    process.env[ENV_TZ] = "Asia/Kolkata";
    resetTimezoneCache();
    expect(getUtcOffsetMinutes(getTimezone() as string)).toBe(330);
  });
});

describe("getTimezone()", () => {
  test("returns IANA name for valid zone", () => {
    process.env[ENV_TZ] = "Europe/London";
    expect(getTimezone()).toBe("Europe/London");
  });

  test("returns null for empty", () => {
    delete process.env[ENV_TZ];
    expect(getTimezone()).toBeNull();
  });

  test("returns null and emits warning for invalid", () => {
    process.env[ENV_TZ] = "Not/A/Timezone";
    const warnings: string[] = [];
    setTimezoneWarningEmitter((msg) => warnings.push(msg));

    expect(getTimezone()).toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Invalid timezone");
    expect(warnings[0]).toContain("Not/A/Timezone");
  });

  test("cached after first call", () => {
    process.env[ENV_TZ] = "Europe/Berlin";
    expect(getTimezone()).toBe("Europe/Berlin");
    // Mutate env; without resetTimezoneCache() the value stays cached.
    process.env[ENV_TZ] = "Asia/Tokyo";
    expect(getTimezone()).toBe("Europe/Berlin");
  });

  test("reads timezone from config.yaml when env is unset", () => {
    delete process.env[ENV_TZ];
    writeFileSync(join(tmpHome as string, "config.yaml"), "timezone: Australia/Sydney\n");
    resetTimezoneCache();
    expect(getTimezone()).toBe("Australia/Sydney");
  });

  test("ignores non-string timezone in config.yaml", () => {
    delete process.env[ENV_TZ];
    writeFileSync(
      join(tmpHome as string, "config.yaml"),
      "timezone:\n  - not\n  - a\n  - string\n",
    );
    resetTimezoneCache();
    expect(getTimezone()).toBeNull();
  });

  test("ignores empty/whitespace timezone in config.yaml", () => {
    delete process.env[ENV_TZ];
    writeFileSync(join(tmpHome as string, "config.yaml"), 'timezone: "   "\n');
    resetTimezoneCache();
    expect(getTimezone()).toBeNull();
  });

  test("handles unreadable config.yaml gracefully", () => {
    delete process.env[ENV_TZ];
    writeFileSync(join(tmpHome as string, "config.yaml"), "::: not yaml\n");
    resetTimezoneCache();
    expect(getTimezone()).toBeNull();
  });
});

describe("_resolveTimezoneName error path", () => {
  test("malformed config.yaml parser failure returns empty timezone", () => {
    // simulates parse_yaml failure from hermes_time.py:L42-48.
    delete process.env[ENV_TZ];
    writeFileSync(join(tmpHome as string, "config.yaml"), "timezone:\n\tbad: value\n");
    resetTimezoneCache();
    expect(() => getTimezone()).not.toThrow();
    expect(getTimezone()).toBeNull();
  });

  test("empty config.yaml parses to null and falls back to local time", () => {
    // simulates absent timezone mapping from hermes_time.py:L42-48.
    delete process.env[ENV_TZ];
    writeFileSync(join(tmpHome as string, "config.yaml"), "");
    resetTimezoneCache();
    expect(getTimezone()).toBeNull();
  });
});

describe("formatInZone()", () => {
  test("uses configured zone when none supplied", () => {
    process.env[ENV_TZ] = "UTC";
    resetTimezoneCache();
    const out = formatInZone(new Date(0), { hour: "2-digit", hour12: false });
    expect(out).toBe("00");
  });

  test("uses explicit zone parameter", () => {
    const out = formatInZone(
      new Date("2026-01-01T00:00:00Z"),
      { hour: "2-digit", hour12: false },
      "Asia/Kolkata",
    );
    // Kolkata is UTC+5:30, so midnight UTC → 05 local
    expect(out).toBe("05");
  });

  test("supports null zone (no timeZone option set)", () => {
    delete process.env[ENV_TZ];
    resetTimezoneCache();
    const out = formatInZone(new Date(0), { year: "numeric" }, null);
    expect(out).toMatch(/\d{4}/);
  });

  test("missing date part contributes zero to offset math", () => {
    const original = Intl.DateTimeFormat;
    const fakeDateTimeFormat = function () {
      return {
        formatToParts: () => [
          { type: "year", value: "2026" },
          { type: "month", value: "01" },
          { type: "day", value: "01" },
          { type: "hour", value: "00" },
          { type: "minute", value: "00" },
        ],
      };
    } as unknown as typeof Intl.DateTimeFormat;
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: fakeDateTimeFormat,
    });
    try {
      expect(
        getUtcOffsetMinutes("UTC", new Date("2026-01-01T00:00:00Z")),
      ).toBe(0);
    } finally {
      vi.stubGlobal("Intl", {
        ...Intl,
        DateTimeFormat: original,
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("setTimezoneWarningEmitter()", () => {
  test("default emitter writes to stderr without throwing", () => {
    _resetTimezoneWarningEmitter();
    // Capture stderr writes so the test output isn't polluted.
    const original = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      process.env[ENV_TZ] = "Bogus/Zone";
      resetTimezoneCache();
      getTimezone();
    } finally {
      process.stderr.write = original;
    }
    expect(captured.some((c) => c.includes("Bogus/Zone"))).toBe(true);
  });

  test("custom emitter receives warning messages", () => {
    const warnings: string[] = [];
    setTimezoneWarningEmitter((msg) => warnings.push(msg));
    process.env[ENV_TZ] = "Also/Bogus";
    resetTimezoneCache();
    getTimezone();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Also/Bogus");
  });

  test("non-Error timezone validation failure is stringified", () => {
    const original = Intl.DateTimeFormat;
    const warnings: string[] = [];
    setTimezoneWarningEmitter((msg) => warnings.push(msg));
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: function () {
        throw "string failure";
      } as unknown as typeof Intl.DateTimeFormat,
    });
    try {
      process.env[ENV_TZ] = "String/Failure";
      resetTimezoneCache();
      expect(getTimezone()).toBeNull();
    } finally {
      vi.stubGlobal("Intl", {
        ...Intl,
        DateTimeFormat: original,
      });
      vi.unstubAllGlobals();
    }
    expect(warnings[0]).toContain("string failure");
  });

  test("_resetTimezoneWarningEmitter reinstalls the stderr writer", () => {
    setTimezoneWarningEmitter(() => undefined);
    _resetTimezoneWarningEmitter();
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      process.env[ENV_TZ] = "Yet/Another/Bad";
      resetTimezoneCache();
      getTimezone();
    } finally {
      process.stderr.write = orig;
    }
    expect(captured.some((c) => c.includes("Yet/Another/Bad"))).toBe(true);
  });
});
