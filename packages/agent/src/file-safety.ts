/**
 * Shared file safety rules used by tools and ACP shims.
 *
 * Faithful port of upstream `agent/file_safety.py`.
 *
 * Two surfaces:
 *   - Write deny — `isWriteDenied(path)` blocks SSH keys, shell
 *     rc files, system credential stores, the agent's own auth/config
 *     files, and (when set) anything outside `HERMES_WRITE_SAFE_ROOT`.
 *   - Read block — `getReadBlockError(path)` produces a user-facing
 *     denial string for prompt-injection cache files and credential
 *     stores. Defense-in-depth, NOT a security boundary.
 *
 * The same hardening trade-offs apply: the terminal tool runs as the
 * same OS user and can still read these files; the gate exists to
 * surface clear denials to obedient models and to leave an audit trail.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import { getDefaultHermesRoot, getHermesHome } from "@hermests/core";

function expandUser(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Best-effort realpath that mirrors Python `os.path.realpath`: resolve
 * the existing portion of the path and append the unresolved tail
 * verbatim, so a non-existent leaf still gets a stable canonical form.
 */
function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Walk up to the first resolvable ancestor and re-join the
    // unresolved tail. Root (`/` or drive letter) is always resolvable
    // on POSIX/Windows, so this loop terminates without needing a
    // bottoming-out guard.
    const abs = resolve(path);
    let current = abs;
    const segments: string[] = [];
    while (true) {
      try {
        const real = realpathSync(current);
        return join(real, ...segments);
      } catch {
        const parent = resolve(current, "..");
        const base = current.slice(parent.length).replace(/^\/+/, "");
        if (base) {
          segments.unshift(base);
        }
        current = parent;
      }
    }
  }
}

/** Return exact sensitive paths that must never be written. */
export function buildWriteDeniedPaths(home: string): Set<string> {
  const hermesHome = getHermesHome();
  const hermesRoot = getDefaultHermesRoot();
  const candidates = [
    join(home, ".ssh", "authorized_keys"),
    join(home, ".ssh", "id_rsa"),
    join(home, ".ssh", "id_ed25519"),
    join(home, ".ssh", "config"),
    // Active profile .env (or top-level .env when not in profile mode).
    join(hermesHome, ".env"),
    // Top-level .env, even when running under a profile (#15981).
    join(hermesRoot, ".env"),
    join(home, ".bashrc"),
    join(home, ".zshrc"),
    join(home, ".profile"),
    join(home, ".bash_profile"),
    join(home, ".zprofile"),
    join(home, ".netrc"),
    join(home, ".pgpass"),
    join(home, ".npmrc"),
    join(home, ".pypirc"),
    "/etc/sudoers",
    "/etc/passwd",
    "/etc/shadow",
  ];
  const out = new Set<string>();
  for (const p of candidates) {
    out.add(tryRealpath(p));
  }
  return out;
}

/** Return sensitive directory prefixes that must never be written. */
export function buildWriteDeniedPrefixes(home: string): string[] {
  const dirs = [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".kube"),
    "/etc/sudoers.d",
    "/etc/systemd",
    join(home, ".docker"),
    join(home, ".azure"),
    join(home, ".config", "gh"),
  ];
  return dirs.map((p) => `${tryRealpath(p)}${sep}`);
}

/** Return the resolved `HERMES_WRITE_SAFE_ROOT` path, or `null` if unset. */
export function getSafeWriteRoot(): string | null {
  const root = process.env.HERMES_WRITE_SAFE_ROOT ?? "";
  if (!root) {
    return null;
  }
  return tryRealpath(expandUser(root));
}

/** Collect distinct realpaths for `HERMES_HOME` + the global hermes root. */
function distinctHermesDirs(): string[] {
  const out: string[] = [];
  for (const base of [getHermesHome(), getDefaultHermesRoot()]) {
    const real = tryRealpath(base);
    if (!out.includes(real)) {
      out.push(real);
    }
  }
  return out;
}

/** Return `true` if `path` is blocked by the write denylist or safe root. */
export function isWriteDenied(path: string): boolean {
  const home = tryRealpath(homedir());
  const resolved = tryRealpath(expandUser(String(path)));

  if (buildWriteDeniedPaths(home).has(resolved)) {
    return true;
  }
  for (const prefix of buildWriteDeniedPrefixes(home)) {
    if (resolved.startsWith(prefix)) {
      return true;
    }
  }

  // Hermes control-plane files — block both the active profile's view
  // AND the global root view (same shape as #15981).
  const controlFileNames = ["auth.json", "config.yaml", "webhook_subscriptions.json"];
  const mcpTokensDirName = "mcp-tokens";

  for (const baseReal of distinctHermesDirs()) {
    for (const name of controlFileNames) {
      if (resolved === tryRealpath(join(baseReal, name))) {
        return true;
      }
    }
    const mcpReal = tryRealpath(join(baseReal, mcpTokensDirName));
    if (resolved === mcpReal || resolved.startsWith(`${mcpReal}${sep}`)) {
      return true;
    }
  }

  const safeRoot = getSafeWriteRoot();
  if (safeRoot !== null && !(resolved === safeRoot || resolved.startsWith(`${safeRoot}${sep}`))) {
    return true;
  }

  return false;
}

/** Resolve a path the way Python's `Path(p).expanduser().resolve()` does. */
function resolveLikePython(path: string): string {
  let expanded = expandUser(path);
  if (!isAbsolute(expanded)) {
    expanded = resolve(expanded);
  }
  return tryRealpath(expanded);
}

/** Best-effort relative-to test; returns `true` if `child` is inside `parent`. */
function isInside(child: string, parent: string): boolean {
  if (child === parent) {
    return true;
  }
  // For normalized paths from realpath, parents are never sep-terminated
  // unless they are the filesystem root ("/" on POSIX) — and we never
  // pass "/" as the parent here (callers always join with a sub-dir).
  return child.startsWith(`${parent}${sep}`);
}

/**
 * Return an error message when a read targets a denied Hermes path.
 * Two categories: skills `.hub` cache files (prompt-injection carriers)
 * and credential / secret stores.
 *
 * Defense-in-depth — not a security boundary. See upstream docstring
 * (`file_safety.py:138-175`) for the full discussion.
 */
export function getReadBlockError(path: string): string | null {
  const resolved = resolveLikePython(path);
  const hermesDirs = distinctHermesDirs();

  // Skills .hub — prompt-injection carriers.
  for (const hd of hermesDirs) {
    const blockedDirs = [join(hd, "skills", ".hub", "index-cache"), join(hd, "skills", ".hub")];
    for (const blocked of blockedDirs) {
      if (isInside(resolved, blocked)) {
        return (
          `Access denied: ${path} is an internal Hermes cache file ` +
          "and cannot be read directly to prevent prompt injection. " +
          "Use the skills_list or skill_view tools instead."
        );
      }
    }
  }

  // Credential / secret stores.
  const credentialFileNames = [
    "auth.json",
    "auth.lock",
    ".anthropic_oauth.json",
    ".env",
    "webhook_subscriptions.json",
  ];
  for (const hd of hermesDirs) {
    for (const name of credentialFileNames) {
      if (resolved === tryRealpath(join(hd, name))) {
        return (
          `Access denied: ${path} is a Hermes credential store ` +
          "and cannot be read directly. Provider tools consume " +
          "these credentials through internal channels. " +
          "(Defense-in-depth — not a security boundary; the " +
          "terminal tool can still bypass.)"
        );
      }
    }
  }

  // mcp-tokens/: directory prefix match.
  for (const hd of hermesDirs) {
    const mcpTokens = tryRealpath(join(hd, "mcp-tokens"));
    if (resolved === mcpTokens) {
      return (
        `Access denied: ${path} is the Hermes MCP token directory ` +
        "and cannot be read directly. (Defense-in-depth — not a " +
        "security boundary; the terminal tool can still bypass.)"
      );
    }
    if (isInside(resolved, mcpTokens) && resolved !== mcpTokens) {
      return (
        `Access denied: ${path} is a Hermes MCP token file ` +
        "and cannot be read directly. (Defense-in-depth — not a " +
        "security boundary; the terminal tool can still bypass.)"
      );
    }
  }

  return null;
}
