// Ported from hermes_state.py:38-183 (WAL fallback module-level helpers).
import { getLogger } from "@hermests/core";
import type { AdapterDatabase } from "./db-adapter.js";

const logger = getLogger("hermes_state");

// Ported from hermes_state.py:54-58
export const WAL_INCOMPAT_MARKERS = [
  "locking protocol", // SQLITE_PROTOCOL on NFS/SMB
  "not authorized", // Some FUSE mounts block WAL pragma outright
  "disk i/o error", // Flaky network FS during WAL setup
] as const;

// Module-level state — per-process. Ported from hermes_state.py:66-74.
// In a multi-thread Python program this is guarded by a Lock. Node is
// single-threaded for JS, so we hold the values directly. The
// (re)entrancy of async code that touches these is fine because we
// only ever do synchronous reads/writes.
let _lastInitError: string | null = null;
const _walFallbackWarnedPaths = new Set<string>();

// Ported from hermes_state.py:77-91
export function _setLastInitError(msg: string | null): void {
  _lastInitError = msg;
}

// Ported from hermes_state.py:94-102
export function getLastInitError(): string | null {
  return _lastInitError;
}

// Ported from hermes_state.py:105-125
export function formatSessionDbUnavailable(
  prefix = "Session database not available",
): string {
  const cause = getLastInitError();
  if (!cause) {
    return `${prefix}.`;
  }
  let hint = "";
  const lower = cause.toLowerCase();
  if (WAL_INCOMPAT_MARKERS.some((marker) => lower.includes(marker))) {
    hint = " (state.db may be on NFS/SMB/FUSE — see https://www.sqlite.org/wal.html)";
  }
  return `${prefix}: ${cause}${hint}.`;
}

// Test/internal helper for clearing the dedup set between tests.
export function _resetWalFallbackWarnedPaths(): void {
  _walFallbackWarnedPaths.clear();
}

// Ported from hermes_state.py:164-183
function _logWalFallbackOnce(dbLabel: string, exc: Error): void {
  if (_walFallbackWarnedPaths.has(dbLabel)) {
    return;
  }
  _walFallbackWarnedPaths.add(dbLabel);
  logger.warning(
    `${dbLabel}: WAL journal_mode unsupported on this filesystem (${exc.message}) — ` +
      `falling back to journal_mode=DELETE (slower rollback-journal mode; ` +
      `reduces concurrency but works on NFS/SMB/FUSE). See ` +
      `https://www.sqlite.org/wal.html for details. This warning fires once ` +
      `per process per database.`,
  );
}

// SQLITE_BUSY / SQLITE_LOCKED codes don't reach JS as numeric constants
// through better-sqlite3; we match on message substrings to mirror
// upstream's str(exc).lower() check.
function _isWalIncompatError(exc: unknown): exc is Error {
  if (!(exc instanceof Error)) return false;
  const msg = exc.message.toLowerCase();
  return WAL_INCOMPAT_MARKERS.some((marker) => msg.includes(marker));
}

// Ported from hermes_state.py:128-161
export function applyWalWithFallback(
  conn: AdapterDatabase,
  options: { dbLabel?: string } = {},
): "wal" | "delete" {
  const dbLabel = options.dbLabel ?? "state.db";
  try {
    conn.exec("PRAGMA journal_mode=WAL");
    return "wal";
  } catch (exc) {
    if (!_isWalIncompatError(exc)) {
      throw exc;
    }
    _logWalFallbackOnce(dbLabel, exc);
    conn.exec("PRAGMA journal_mode=DELETE");
    return "delete";
  }
}
