/**
 * Shared constants for Hermes (TypeScript port of hermes_constants.py).
 *
 * Import-safe module with no internal dependencies — can be imported from
 * anywhere without risk of circular imports.
 *
 * Faithful divergences from upstream:
 *   - contextvars.ContextVar → AsyncLocalStorage<string> (upstream py:L15-17).
 *     Per-task scoping semantics match: each async context gets its own
 *     override stack and resetting via the token unwinds correctly.
 *   - sysconfig.get_path("data"|"purelib"|"platlib") → no direct Node
 *     equivalent (no Python wheel concept). _get_packaged_data_dir is
 *     ported as a stub that returns null and is documented in
 *     docs/dep-mapping.md.
 *   - socket.getaddrinfo monkey-patch → dns.lookup wrapper. The Node
 *     equivalent of "prefer IPv4" is to set the lookup family parameter.
 *     Documented in docs/dep-mapping.md.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import {
  resolve as pathResolve,
  parse as pathParse,
  basename,
  dirname,
  join,
  sep,
  isAbsolute,
} from "node:path";
import { realpathSync } from "node:fs";
import dns, { type LookupAddress, type LookupAllOptions, type LookupOneOptions, type LookupOptions } from "node:dns";

// ─── ContextVar equivalent ──────────────────────────────────────────────────

// Token returned by setHermesHomeOverride; passed back into reset to unwind.
// We model contextvars.Token as an opaque object with the previous value
// captured inside it. The AsyncLocalStorage is enterWith-based so multiple
// active overrides nest the way ContextVar.set/reset does in Python.
export interface HermesHomeToken {
  readonly previous: string | undefined;
}

const _hermesHomeStorage = new AsyncLocalStorage<{ value: string | undefined }>();

/** Get-or-init the per-context cell. */
function _getCell(): { value: string | undefined } {
  let cell = _hermesHomeStorage.getStore();
  if (!cell) {
    cell = { value: undefined };
    _hermesHomeStorage.enterWith(cell);
  }
  return cell;
}

/**
 * Set a context-local Hermes home override and return its reset token.
 *
 * Faithful to set_hermes_home_override (upstream py:L20-27). Like the
 * Python version, this is for in-process, per-task scoping; it does NOT
 * mutate process.env which is shared by every async task.
 */
export function setHermesHomeOverride(path: string | null): HermesHomeToken {
  const cell = _getCell();
  const previous = cell.value;
  cell.value = path === null ? undefined : String(path);
  return { previous };
}

/** Restore the previous context-local Hermes home override. */
export function resetHermesHomeOverride(token: HermesHomeToken): void {
  const cell = _getCell();
  cell.value = token.previous;
}

/** Return the active context-local Hermes home override, if any. */
export function getHermesHomeOverride(): string | null {
  const cell = _hermesHomeStorage.getStore();
  const value = cell?.value;
  if (!value) return null;
  return String(value);
}

// ─── Profile-fallback warning state ─────────────────────────────────────────

// One-shot guard for the "active profile vs HERMES_HOME mismatch" warning.
// Exported under an internal-prefixed name so tests can reset it the way the
// upstream Python tests reset _profile_fallback_warned via importlib.reload.
export const _internals = {
  profileFallbackWarned: false as boolean,
  wslDetected: undefined as boolean | undefined,
  containerDetected: undefined as boolean | undefined,
};

// ─── Hermes home / root resolution ──────────────────────────────────────────

/**
 * Return the Hermes home directory (default: ~/.hermes).
 *
 * Reads HERMES_HOME env var, falls back to ~/.hermes. Single source of truth.
 *
 * When HERMES_HOME is unset but an active_profile file indicates a
 * non-default profile is active, emits a one-shot warning to stderr —
 * matching upstream py:L43-101.
 */
export function getHermesHome(): string {
  const override = getHermesHomeOverride();
  if (override) return override;

  const envVal = (process.env.HERMES_HOME ?? "").trim();
  if (envVal) return envVal;

  if (!_internals.profileFallbackWarned) {
    let active = "";
    try {
      const activePath = join(homedir(), ".hermes", "active_profile");
      if (existsSync(activePath)) {
        active = readFileSync(activePath, "utf-8").trim();
      }
    } catch {
      active = "";
    }
    if (active && active !== "default") {
      _internals.profileFallbackWarned = true;
      const msg =
        `[HERMES_HOME fallback] HERMES_HOME is unset but active ` +
        `profile is '${active}'. Falling back to ~/.hermes, which ` +
        `is the DEFAULT profile — not '${active}'. Any data this ` +
        `process writes will land in the wrong profile. The ` +
        `subprocess spawner should pass HERMES_HOME explicitly ` +
        `(see issue #18594).`;
      try {
        process.stderr.write(msg + "\n");
      } catch {
        // Best-effort — stderr could be detached.
      }
    }
  }

  return join(homedir(), ".hermes");
}

/**
 * Return the root Hermes directory for profile-level operations.
 *
 * Faithful to get_default_hermes_root (upstream py:L104-140). Standard
 * deployments → ~/.hermes. Docker → HERMES_HOME directly. Profile mode
 * (~/.hermes/profiles/<name>) → ~/.hermes. Docker profile mode → docker root.
 */
export function getDefaultHermesRoot(): string {
  const nativeHome = join(homedir(), ".hermes");
  const envHome = process.env.HERMES_HOME ?? "";
  if (!envHome) return nativeHome;
  const envPath = envHome;

  // Resolve both to canonical form before checking containment, matching
  // Python's Path.resolve().relative_to() semantics.
  const resolveSafe = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return pathResolve(p);
    }
  };
  const envResolved = resolveSafe(envPath);
  const nativeResolved = resolveSafe(nativeHome);

  if (
    envResolved === nativeResolved ||
    envResolved.startsWith(nativeResolved + sep)
  ) {
    return nativeHome;
  }

  // Not under ~/.hermes — Docker / custom. If immediate parent is "profiles",
  // grandparent is the root.
  const parent = dirname(envPath);
  if (basename(parent) === "profiles") {
    return dirname(parent);
  }
  return envPath;
}

// ─── Packaged-data discovery ────────────────────────────────────────────────

/**
 * Return an installed data-files directory if one exists.
 *
 * Faithful divergence from _get_packaged_data_dir (upstream py:L143-157):
 * Node has no equivalent of Python's sysconfig.get_path("data"|"purelib"|
 * "platlib") because there's no wheel/setup.py data_files concept. Bundled
 * skills in HermesTS will live under a known relative path within the
 * package; callers should provide an explicit default. This always returns
 * null in the TS port and is exported only so the resolution chain in
 * getOptionalSkillsDir/getBundledSkillsDir matches upstream order.
 */
export function _getPackagedDataDir(_name: string): string | null {
  return null;
}

/**
 * Return the optional-skills directory, honoring package-manager wrappers.
 * Faithful to get_optional_skills_dir (upstream py:L160-174).
 */
export function getOptionalSkillsDir(defaultDir: string | null = null): string {
  const override = (process.env.HERMES_OPTIONAL_SKILLS ?? "").trim();
  if (override) return override;
  const packaged = _getPackagedDataDir("optional-skills");
  if (packaged !== null) return packaged;
  if (defaultDir !== null) return defaultDir;
  return join(getHermesHome(), "optional-skills");
}

/**
 * Return the bundled skills directory for source and packaged installs.
 * Faithful to get_bundled_skills_dir (upstream py:L177-194).
 */
export function getBundledSkillsDir(defaultDir: string | null = null): string {
  const override = (process.env.HERMES_BUNDLED_SKILLS ?? "").trim();
  if (override) return override;
  const packaged = _getPackagedDataDir("skills");
  if (packaged !== null) return packaged;
  if (defaultDir !== null) return defaultDir;
  return join(getHermesHome(), "skills");
}

/**
 * Resolve a Hermes subdirectory with backward compatibility.
 *
 * New installs get the consolidated layout (e.g. cache/images).
 * Existing installs that already have the old path keep using it.
 * Faithful to get_hermes_dir (upstream py:L197-215).
 */
export function getHermesDir(newSubpath: string, oldName: string): string {
  const home = getHermesHome();
  const oldPath = join(home, oldName);
  if (existsSync(oldPath)) return oldPath;
  return join(home, newSubpath);
}

/**
 * Return a user-friendly display string for the current HERMES_HOME.
 * Faithful to display_hermes_home (upstream py:L218-235).
 */
export function displayHermesHome(): string {
  const home = getHermesHome();
  const userHome = homedir();
  if (home === userHome) {
    return "~/";
  }
  if (home.startsWith(userHome + sep)) {
    return "~/" + home.slice(userHome.length + 1);
  }
  return home;
}

/**
 * Chmod 0o700 on the parent of *path*, but only when safe.
 *
 * Refuses to chmod / or any direct child of / (resolved parent with fewer
 * than 3 parts) to prevent catastrophic host bricking.
 * Faithful to secure_parent_dir (upstream py:L238-255).
 */
export function secureParentDir(path: string): void {
  let parent: string;
  try {
    parent = realpathSync(dirname(path));
  } catch {
    parent = pathResolve(dirname(path));
  }

  // Split into parts the way Python's Path.parts does — the first part of
  // an absolute POSIX path is "/", and each segment after is its own entry.
  // We mirror "len(parent.parts) < 3" so e.g. "/usr" (parts=("/", "usr"))
  // is rejected and "/usr/lib/foo" (parts=("/", "usr", "lib", "foo")) is OK.
  const parsed = pathParse(parent);
  const rest = parent
    .slice(parsed.root.length)
    .split(sep)
    .filter((segment) => segment.length > 0);
  const partsLen = (parsed.root ? 1 : 0) + rest.length;
  // POSIX root check ("/").
  if (parent === "/" || partsLen < 3) return;

  try {
    chmodSync(parent, 0o700);
  } catch {
    // Match upstream: OSError is suppressed.
  }
}

/**
 * Return a per-profile HOME directory for subprocesses, or null.
 * Faithful to get_subprocess_home (upstream py:L258-281).
 */
export function getSubprocessHome(): string | null {
  const hermesHome = getHermesHomeOverride() ?? process.env.HERMES_HOME ?? "";
  if (!hermesHome) return null;
  const profileHome = join(hermesHome, "home");
  try {
    const stat = readDirSafely(profileHome);
    if (stat) return profileHome;
  } catch {
    return null;
  }
  return null;
}

function readDirSafely(path: string): boolean {
  try {
    return existsSync(path) && require("node:fs").statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ─── Reasoning effort parsing ───────────────────────────────────────────────

export const VALID_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffort = (typeof VALID_REASONING_EFFORTS)[number];

export type ReasoningEffortResult =
  | { enabled: false }
  | { enabled: true; effort: ReasoningEffort };

/**
 * Parse a reasoning effort level into a config object.
 * Valid: "none", "minimal", "low", "medium", "high", "xhigh".
 * Faithful to parse_reasoning_effort (upstream py:L287-302).
 */
export function parseReasoningEffort(effort: string): ReasoningEffortResult | null {
  if (!effort || !effort.trim()) return null;
  const normalized = effort.trim().toLowerCase();
  if (normalized === "none") return { enabled: false };
  if ((VALID_REASONING_EFFORTS as readonly string[]).includes(normalized)) {
    return { enabled: true, effort: normalized as ReasoningEffort };
  }
  return null;
}

// ─── Platform detection ─────────────────────────────────────────────────────

/**
 * Return true when running inside a Termux (Android) environment.
 * Faithful to is_termux (upstream py:L305-312).
 */
export function isTermux(): boolean {
  const prefix = process.env.PREFIX ?? "";
  return Boolean(
    process.env.TERMUX_VERSION || prefix.includes("com.termux/files/usr"),
  );
}

/**
 * Return true when running inside WSL (Windows Subsystem for Linux).
 * Result is cached for the process lifetime.
 * Faithful to is_wsl (upstream py:L318-333).
 */
export function isWsl(): boolean {
  if (_internals.wslDetected !== undefined) return _internals.wslDetected;
  try {
    const content = readFileSync("/proc/version", "utf-8");
    _internals.wslDetected = content.toLowerCase().includes("microsoft");
  } catch {
    _internals.wslDetected = false;
  }
  return _internals.wslDetected;
}

/**
 * Return true when running inside a Docker/Podman container.
 * Faithful to is_container (upstream py:L339-364).
 */
export function isContainer(): boolean {
  if (_internals.containerDetected !== undefined) return _internals.containerDetected;
  if (existsSync("/.dockerenv")) {
    _internals.containerDetected = true;
    return true;
  }
  if (existsSync("/run/.containerenv")) {
    _internals.containerDetected = true;
    return true;
  }
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
    if (
      cgroup.includes("docker") ||
      cgroup.includes("podman") ||
      cgroup.includes("/lxc/")
    ) {
      _internals.containerDetected = true;
      return true;
    }
  } catch {
    // fall through
  }
  _internals.containerDetected = false;
  return false;
}

// ─── Well-known paths ───────────────────────────────────────────────────────

/** Path to config.yaml under HERMES_HOME. Faithful to get_config_path (py:L370-376). */
export function getConfigPath(): string {
  return join(getHermesHome(), "config.yaml");
}

/** Path to the skills directory under HERMES_HOME. Faithful to get_skills_dir (py:L379-381). */
export function getSkillsDir(): string {
  return join(getHermesHome(), "skills");
}

/** Path to the .env file under HERMES_HOME. Faithful to get_env_path (py:L385-387). */
export function getEnvPath(): string {
  return join(getHermesHome(), ".env");
}

// ─── Network preferences ────────────────────────────────────────────────────

/**
 * Prefer IPv4 connections.
 *
 * Faithful divergence from apply_ipv4_preference (upstream py:L393-432):
 * Python monkey-patches socket.getaddrinfo so AF_UNSPEC callers resolve
 * to AF_INET first and fall back to AF_UNSPEC on gaierror. Node's
 * equivalent is patching dns.lookup, which is used by net.connect, http
 * agents, undici, etc. We rewrite calls with family:0 (the Node default
 * "unspecified") into family:4 (IPv4), and on ENOTFOUND/EAI_AGAIN fall
 * back to family:0 to keep pure-IPv6 hosts working.
 *
 * Safe to call multiple times — only patches once. Set force=false (the
 * default) to no-op; pass true when config network.force_ipv4 is set.
 */
type DnsLookup = typeof dns.lookup;

interface PatchedLookup extends DnsLookup {
  _hermesIpv4Patched?: boolean;
}

export function applyIpv4Preference(force = false): void {
  if (!force) return;

  const current = dns.lookup as PatchedLookup;
  if (current._hermesIpv4Patched) return;

  const original = current;

  // dns.lookup has three overloads. We forward arguments through a single
  // function and detect which form was used at runtime.
  const patched: DnsLookup = ((
    hostname: string,
    optionsOrFamilyOrCallback: unknown,
    maybeCallback?: unknown,
  ): void => {
    // Determine whether the second arg is options-object, family-number, or callback.
    const hasOptionsObject =
      typeof optionsOrFamilyOrCallback === "object" &&
      optionsOrFamilyOrCallback !== null;
    const hasFamilyNumber = typeof optionsOrFamilyOrCallback === "number";
    const directCallback =
      typeof optionsOrFamilyOrCallback === "function"
        ? (optionsOrFamilyOrCallback as (
            err: NodeJS.ErrnoException | null,
            address: string | LookupAddress[],
            family?: number,
          ) => void)
        : undefined;
    const callback =
      directCallback ??
      (maybeCallback as
        | ((
            err: NodeJS.ErrnoException | null,
            address: string | LookupAddress[],
            family?: number,
          ) => void)
        | undefined);

    let requestedFamily = 0;
    let optionsForCall: LookupOptions | LookupAllOptions | LookupOneOptions | number =
      0;

    if (hasOptionsObject) {
      const opts = optionsOrFamilyOrCallback as LookupOptions;
      requestedFamily = opts.family ?? 0;
      optionsForCall = opts;
    } else if (hasFamilyNumber) {
      requestedFamily = optionsOrFamilyOrCallback as number;
      optionsForCall = requestedFamily;
    }

    // Only intercept "unspecified" (family 0). Explicit AF_INET6 (6) requests
    // must pass through untouched — same contract as the upstream py:L420-428.
    if (requestedFamily !== 0) {
      return (original as Function)(hostname, optionsForCall, callback);
    }

    const ipv4Options: LookupOptions =
      hasOptionsObject
        ? { ...(optionsOrFamilyOrCallback as LookupOptions), family: 4 }
        : { family: 4 };

    (original as Function)(
      hostname,
      ipv4Options,
      (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => {
        if (err && (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN")) {
          // Fall back to full resolution (pure-IPv6 hosts).
          (original as Function)(hostname, optionsForCall, callback);
          return;
        }
        callback?.(err, address, family);
      },
    );
  }) as DnsLookup;

  (patched as PatchedLookup)._hermesIpv4Patched = true;
  // dns.lookup is read-only in some Node versions; defineProperty works.
  Object.defineProperty(dns, "lookup", {
    configurable: true,
    writable: true,
    value: patched,
  });
}

// ─── Provider base URLs ─────────────────────────────────────────────────────

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`;
export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

// ─── Test-only helpers ──────────────────────────────────────────────────────

/**
 * Reset module-level caches. Test-only. Not part of the upstream Python API
 * (upstream uses importlib.reload), but Node has no per-module reload, so
 * we expose a deliberate reset hook. Keeps tests deterministic.
 */
export function _resetForTesting(): void {
  _internals.profileFallbackWarned = false;
  _internals.wslDetected = undefined;
  _internals.containerDetected = undefined;
}

// Helper used by `pathParse` consumers when nothing else suffices; included
// here so unused-symbol checks don't flag it.
void isAbsolute;
