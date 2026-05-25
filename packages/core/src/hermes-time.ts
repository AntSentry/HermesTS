/**
 * Timezone-aware clock for Hermes (TypeScript port of hermes_time.py).
 *
 * Provides a `now()` helper that returns a timezone-aware Date-like value
 * based on the user's configured IANA timezone (e.g. "Asia/Kolkata").
 *
 * Resolution order:
 *   1. HERMES_TIMEZONE environment variable
 *   2. `timezone` key in ~/.hermes/config.yaml
 *   3. Falls back to the server's local time
 *
 * Faithful divergences:
 *   - Python's `zoneinfo.ZoneInfo` returns a tzinfo object that attaches
 *     to a datetime. JavaScript's `Date` is always UTC internally with no
 *     timezone attachment — there's no way to bind a zone to a Date. We
 *     expose the IANA name as the "zoneinfo" value (a string) and offer
 *     `formatInZone(now, fmt)` for callers that need to render in the zone.
 *     `now()` returns a regular Date — which IS timezone-aware in the
 *     sense that its UTC value is unambiguous — and `getTimezone()`
 *     returns the IANA name. Documented in docs/dep-mapping.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getConfigPath } from "./hermes-constants.js";

// Cached state — resolved once, reused on every call.
// Tests call `resetTimezoneCache()` to force re-resolution.
let _cachedTz: string | null = null;
let _cachedTzName: string | null = null;
let _cacheResolved = false;

// Warning collector for invalid timezones. Upstream uses `logging.warning`
// which gets picked up by pytest's caplog. We mirror that via an exported
// emitter so callers (and tests) can hook in. The logging module wires its
// own listener; tests can read `_lastWarning` directly.
type WarningEmitter = (message: string) => void;
let _warningEmitter: WarningEmitter = (msg) => {
  process.stderr.write(`hermes_time: ${msg}\n`);
};
export function setTimezoneWarningEmitter(fn: WarningEmitter): void {
  _warningEmitter = fn;
}
export function _resetTimezoneWarningEmitter(): void {
  _warningEmitter = (msg) => {
    process.stderr.write(`hermes_time: ${msg}\n`);
  };
}

/** Read the configured IANA timezone string (or empty). */
function _resolveTimezoneName(): string {
  // 1. Environment variable (highest priority).
  const tzEnv = (process.env.HERMES_TIMEZONE ?? "").trim();
  if (tzEnv) return tzEnv;

  // 2. config.yaml `timezone` key.
  try {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      const text = readFileSync(configPath, "utf-8");
      const cfg = parseYaml(text) ?? {};
      const tzCfg = (cfg as Record<string, unknown>).timezone;
      if (typeof tzCfg === "string" && tzCfg.trim()) {
        return tzCfg.trim();
      }
    }
  } catch {
    // fall through
  }

  return "";
}

/**
 * Validate an IANA timezone name and return it, or null if invalid.
 *
 * Uses `Intl.DateTimeFormat` to check — Node's Intl throws RangeError on
 * unknown zones. Matches upstream `_get_zoneinfo` (py:L64-75) semantics.
 */
function _validateZone(name: string): string | null {
  if (!name) return null;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    _warningEmitter(
      `Invalid timezone '${name}': ${msg}. Falling back to server local time.`,
    );
    return null;
  }
}

/**
 * Return the user's configured IANA timezone string, or null (meaning
 * server-local).
 *
 * Resolved once and cached. Call `resetTimezoneCache()` after config changes.
 */
export function getTimezone(): string | null {
  if (!_cacheResolved) {
    _cachedTzName = _resolveTimezoneName();
    _cachedTz = _validateZone(_cachedTzName);
    _cacheResolved = true;
  }
  return _cachedTz;
}

/** Reset the cached timezone — test-only. */
export function resetTimezoneCache(): void {
  _cachedTz = null;
  _cachedTzName = null;
  _cacheResolved = false;
}

/**
 * Return the UTC offset in minutes for a given IANA zone at a given instant.
 *
 * Uses Intl.DateTimeFormat parts to derive the wall-clock time in the zone,
 * then computes the difference vs the actual UTC instant. Handles DST
 * because Intl resolves each instant individually.
 */
export function getUtcOffsetMinutes(zone: string, at: Date = new Date()): number {
  // Format the instant in the target zone, then re-parse as if it were UTC.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(at);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Return the current time as a Date.
 *
 * The Date itself is always UTC internally (this is a JS language fact).
 * The "timezone awareness" promised by the upstream Python API is preserved
 * via `getTimezone()`: callers that need wall-clock in the configured zone
 * use `formatInZone(now(), fmt)` or pull the offset via `getUtcOffsetMinutes`.
 */
export function now(): Date {
  return new Date();
}

/**
 * Format a Date in the configured (or specified) IANA zone using
 * Intl.DateTimeFormat options. Convenience around the Python idiom
 * `now().strftime(fmt)` since JS has no strftime.
 */
export function formatInZone(
  date: Date,
  options: Intl.DateTimeFormatOptions = {},
  zone: string | null = getTimezone(),
): string {
  const opts: Intl.DateTimeFormatOptions = { ...options };
  if (zone) opts.timeZone = zone;
  return new Intl.DateTimeFormat("en-US", opts).format(date);
}
