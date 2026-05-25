/**
 * Shared utility functions for HermesTS (port of utils.py).
 *
 * Faithful divergences:
 *   - `tempfile.mkstemp` → `fs.mkdtempSync` + manual file creation. Node's
 *     `os.tmpdir`-based mkdtemp doesn't support custom prefix per-file, so
 *     we create a randomized name inside the target directory matching
 *     upstream `dir=str(path.parent), prefix=f".{path.stem}_"` semantics.
 *   - `os.fsync(f.fileno())` → `fs.fsyncSync(fd)`. Direct equivalent.
 *   - `os.replace` preserving symlinks via `os.path.realpath` → mirrored
 *     by resolving symlinks via `fs.realpathSync` before renaming.
 *   - `ruamel.yaml` round-trip → `yaml` package's parse/stringify. The TS
 *     `yaml` package preserves comments and most quoting; full round-trip
 *     fidelity is documented as a known difference in docs/dep-mapping.md.
 *   - `urllib.parse.urlparse` → Node's WHATWG URL. The hostname extraction
 *     behavior matches for the cases the callers care about.
 */

import {
  closeSync as fsClose,
  chmodSync as fsChmod,
  existsSync as fsExists,
  fsyncSync as fsFsync,
  lstatSync as fsLstat,
  mkdirSync as fsMkdir,
  openSync as fsOpen,
  realpathSync as fsRealpath,
  renameSync as fsRename,
  statSync as fsStat,
  unlinkSync as fsUnlink,
  writeFileSync,
  writeSync as fsWrite,
} from "node:fs";
import { dirname, parse as pathParse, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ─── Mockable IO hooks ──────────────────────────────────────────────────────
//
// Same pattern as hermes-constants._io: test-only indirection so coverage
// can exercise defensive catch blocks without monkey-patching node:fs
// (Bun exposes those as non-configurable getters).

const _defaultIo = {
  closeSync: fsClose,
  chmodSync: fsChmod,
  existsSync: fsExists,
  fsyncSync: fsFsync,
  lstatSync: fsLstat,
  mkdirSync: fsMkdir,
  openSync: fsOpen,
  realpathSync: fsRealpath,
  renameSync: fsRename,
  statSync: fsStat,
  unlinkSync: fsUnlink,
  writeSync: fsWrite,
};

export const _utilsIo: typeof _defaultIo = { ..._defaultIo };
// Alias kept short for use inside this module.
const _io = _utilsIo;

export function _resetUtilsIo(): void {
  for (const k of Object.keys(_defaultIo) as Array<keyof typeof _defaultIo>) {
    (_io as Record<string, unknown>)[k] = (
      _defaultIo as Record<string, unknown>
    )[k];
  }
}

// Aliases preserved for source readability — the rest of the file uses the
// short names below, which always resolve through _io and therefore can
// be overridden by tests.
const closeSync = (...args: Parameters<typeof fsClose>) => _io.closeSync(...args);
const chmodSync = (...args: Parameters<typeof fsChmod>) => _io.chmodSync(...args);
const existsSync = (...args: Parameters<typeof fsExists>) => _io.existsSync(...args);
const fsyncSync = (...args: Parameters<typeof fsFsync>) => _io.fsyncSync(...args);
const lstatSync = (...args: Parameters<typeof fsLstat>) => _io.lstatSync(...args);
const mkdirSync = (...args: Parameters<typeof fsMkdir>) => _io.mkdirSync(...args);
const openSync = (...args: Parameters<typeof fsOpen>) => _io.openSync(...args);
const realpathSync = (...args: Parameters<typeof fsRealpath>) =>
  _io.realpathSync(...args);
const renameSync = (...args: Parameters<typeof fsRename>) => _io.renameSync(...args);
const statSync = (...args: Parameters<typeof fsStat>) => _io.statSync(...args);
const unlinkSync = (...args: Parameters<typeof fsUnlink>) => _io.unlinkSync(...args);
const writeSync = (...args: Parameters<typeof fsWrite>) => _io.writeSync(...args);

// ─── Truthy helpers ─────────────────────────────────────────────────────────

export const TRUTHY_STRINGS: ReadonlySet<string> = new Set([
  "1",
  "true",
  "yes",
  "on",
]);

/** Coerce bool-ish values using the shared truthy string set. */
export function isTruthyValue(value: unknown, defaultValue = false): boolean {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return TRUTHY_STRINGS.has(value.trim().toLowerCase());
  }
  return Boolean(value);
}

/** Return true when an environment variable is set to a truthy value. */
export function envVarEnabled(name: string, defaultValue = ""): boolean {
  return isTruthyValue(process.env[name] ?? defaultValue, false);
}

// ─── File mode preservation ─────────────────────────────────────────────────

/** Capture the permission bits of *path* if it exists, else null. */
function _preserveFileMode(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path) as import("node:fs").Stats;
    return stat.mode & 0o777;
  } catch {
    return null;
  }
}

/** Re-apply *mode* to *path* after an atomic replace. */
function _restoreFileMode(path: string, mode: number | null): void {
  if (mode === null) return;
  try {
    chmodSync(path, mode);
  } catch {
    // ignore
  }
}

// ─── Atomic replace (symlink-preserving) ────────────────────────────────────

/**
 * Atomically move *tmpPath* onto *target*, preserving symlinks.
 *
 * Mirrors upstream atomic_replace (py:L61-82). When *target* is a symlink,
 * the real file is overwritten via realpath; the symlink survives.
 */
export function atomicReplace(tmpPath: string, target: string): string {
  let realPath = target;
  try {
    const st = lstatSync(target) as import("node:fs").Stats;
    if (st.isSymbolicLink()) {
      // realpathSync will throw if the link is broken. Match upstream
      // behavior (os.path.realpath returns the resolved path even when
      // the target doesn't exist) by manually following one level.
      try {
        realPath = realpathSync(target);
      } catch {
        // Broken symlink — read the link target manually.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readlinkSync } = require("node:fs") as typeof import("node:fs");
        let linkTarget = readlinkSync(target);
        if (!linkTarget.startsWith("/")) {
          linkTarget = join(dirname(target), linkTarget);
        }
        realPath = linkTarget;
      }
    }
  } catch {
    // lstat failed — target doesn't exist. realPath stays as target.
  }
  renameSync(tmpPath, realPath);
  return realPath;
}

/** Create a unique temp filename inside *dir* with the prefix/suffix scheme. */
function _mkTemp(dir: string, prefix: string, suffix: string): { fd: number; path: string } {
  // 16 hex chars = 8 random bytes — enough for collision avoidance.
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = join(dir, `${prefix}${randomBytes(8).toString("hex")}${suffix}`);
    try {
      // O_CREAT | O_EXCL | O_RDWR, mode 0600 (matches Python's tempfile default).
      const fd = openSync(candidate, "wx+", 0o600);
      return { fd, path: candidate };
    } catch (err) {
      // Collision — try again. Any other error: rethrow.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Failed to create temp file in ${dir} after 10 attempts`);
}

// ─── JSON atomic write ──────────────────────────────────────────────────────

interface AtomicJsonOptions {
  indent?: number;
}

/**
 * Write JSON data to a file atomically.
 *
 * Uses temp file + fsync + rename to ensure the target file is never left
 * in a partially-written state. Faithful to atomic_json_write (py:L85-136).
 */
export function atomicJsonWrite(
  path: string,
  data: unknown,
  options: AtomicJsonOptions = {},
): void {
  const { indent = 2 } = options;
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });

  const originalMode = _preserveFileMode(path);
  const stem = pathParse(path).name;
  const { fd, path: tmpPath } = _mkTemp(parent, `.${stem}_`, ".tmp");

  try {
    const payload = JSON.stringify(data, null, indent);
    writeSync(fd, payload, 0, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    const realPath = atomicReplace(tmpPath, path);
    _restoreFileMode(realPath, originalMode);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // already gone
    }
    throw err;
  }
}

// ─── YAML atomic write ──────────────────────────────────────────────────────

interface AtomicYamlOptions {
  defaultFlowStyle?: boolean;
  sortKeys?: boolean;
  extraContent?: string;
}

/**
 * Write YAML data to a file atomically. Faithful to atomic_yaml_write
 * (py:L139-188).
 */
export function atomicYamlWrite(
  path: string,
  data: unknown,
  options: AtomicYamlOptions = {},
): void {
  const { sortKeys = false, extraContent } = options;
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });

  const originalMode = _preserveFileMode(path);
  const stem = pathParse(path).name;
  const { fd, path: tmpPath } = _mkTemp(parent, `.${stem}_`, ".tmp");

  try {
    let payload = stringifyYaml(data, { sortMapEntries: sortKeys });
    if (extraContent) payload += extraContent;
    writeSync(fd, payload, 0, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    const realPath = atomicReplace(tmpPath, path);
    _restoreFileMode(realPath, originalMode);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // already gone
    }
    throw err;
  }
}

/**
 * Update one dotted YAML key while preserving comments and readable text.
 *
 * Faithful to atomic_roundtrip_yaml_update (py:L191-252). The TS `yaml`
 * package's Document API preserves comments; this matches ruamel.yaml's
 * intent.
 */
export function atomicRoundtripYamlUpdate(
  path: string,
  keyPath: string,
  value: unknown,
): void {
  // eslint-disable-next-line @typescript-eslint/no-require-invocations
  const YAMLModule = require("yaml") as typeof import("yaml");
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });

  let doc: import("yaml").Document.Parsed | import("yaml").Document;
  if (existsSync(path)) {
    const text = require("node:fs").readFileSync(path, "utf-8") as string;
    doc = YAMLModule.parseDocument(text);
  } else {
    doc = new YAMLModule.Document({});
  }

  const keys = keyPath.split(".");
  doc.setIn(keys, value);

  const originalMode = _preserveFileMode(path);
  const stem = pathParse(path).name;
  const { fd, path: tmpPath } = _mkTemp(parent, `.${stem}_`, ".tmp");
  try {
    writeSync(fd, doc.toString(), 0, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    const realPath = atomicReplace(tmpPath, path);
    _restoreFileMode(realPath, originalMode);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // already gone
    }
    throw err;
  }
}

// ─── JSON helpers ───────────────────────────────────────────────────────────

/**
 * Parse JSON, returning *defaultValue* on any parse error.
 * Faithful to safe_json_loads (py:L258-268).
 */
export function safeJsonLoads<T = unknown>(text: string, defaultValue: T | null = null): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return defaultValue;
  }
}

// ─── Environment variable helpers ───────────────────────────────────────────

/** Read an env var as an integer with fallback. Faithful to env_int (py:L274-282). */
export function envInt(key: string, defaultValue = 0): number {
  const raw = (process.env[key] ?? "").trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return parsed;
}

/** Read an env var as a boolean. Faithful to env_bool (py:L285-287). */
export function envBool(key: string, defaultValue = false): boolean {
  return isTruthyValue(process.env[key] ?? "", defaultValue);
}

// ─── Proxy helpers ──────────────────────────────────────────────────────────

const _PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;

/**
 * Normalize proxy URLs for httpx/aiohttp compatibility.
 * Faithful to normalize_proxy_url (py:L299-311).
 */
export function normalizeProxyUrl(proxyUrl: string | null | undefined): string | null {
  const candidate = String(proxyUrl ?? "").trim();
  if (!candidate) return null;
  if (candidate.toLowerCase().startsWith("socks://")) {
    return `socks5://${candidate.slice("socks://".length)}`;
  }
  return candidate;
}

/** Rewrite supported proxy env vars to canonical URL forms in-place. */
export function normalizeProxyEnvVars(): void {
  for (const key of _PROXY_ENV_KEYS) {
    const value = process.env[key] ?? "";
    const normalized = normalizeProxyUrl(value);
    if (normalized && normalized !== value) {
      process.env[key] = normalized;
    }
  }
}

// ─── URL parsing helpers ────────────────────────────────────────────────────

/**
 * Return the lowercased hostname for a base URL, or "" if absent.
 *
 * Faithful to base_url_hostname (py:L326-340). Uses WHATWG URL — when the
 * input lacks a scheme, we prepend "http://" so the parser can identify
 * the host. Trailing dots and case are normalized.
 */
export function baseUrlHostname(baseUrl: string | null | undefined): string {
  const raw = (baseUrl ?? "").toString().trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

/**
 * Return true when the base URL's hostname is *domain* or a subdomain.
 *
 * Faithful to base_url_host_matches (py:L343-361). Defends against the
 * substring false-positive class documented in the upstream test file.
 */
export function baseUrlHostMatches(
  baseUrl: string | null | undefined,
  domain: string | null | undefined,
): boolean {
  const hostname = baseUrlHostname(baseUrl);
  if (!hostname) return false;
  const normalizedDomain = (domain ?? "").toString().trim().toLowerCase().replace(/\.+$/, "");
  if (!normalizedDomain) return false;
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
}

// Silence unused-import warning for writeFileSync — kept for parity with the
// fsync-then-rename pattern in case future revisions need a direct one-shot.
void writeFileSync;
