/**
 * Process-level bootstrap helpers.
 *
 * Faithful port of upstream `agent/process_bootstrap.py`.
 *
 * Three concerns, all tied to boot-time / runtime IO setup:
 *
 * 1. **Crash-resistant stdio** — `SafeWriter` wraps `process.stdout` /
 *    `process.stderr` so EPIPE / EBADF from broken pipes cannot crash
 *    the agent. `installSafeStdio` applies it.
 *
 * 2. **HTTP proxy resolution** — `getProxyFromEnv` reads `HTTPS_PROXY`
 *    / `HTTP_PROXY` / `ALL_PROXY`; `getProxyForBaseUrl` respects
 *    `NO_PROXY` for the given base URL.
 *
 * Faithful divergence:
 *   - The upstream `_OpenAIProxy` + `_load_openai_cls` lazy-import
 *     shim for `openai.OpenAI` is NOT ported. Node's `import()` is
 *     already lazy and ESM module loading is cached; the shim has no
 *     analog. The transports package will wire whatever HTTP client it
 *     prefers directly. Documented at upstream
 *     `process_bootstrap.py:39-61`.
 *   - `urllib.request.proxy_bypass_environment(host)` becomes a small
 *     `NO_PROXY` matcher because Node has no equivalent stdlib helper.
 *     Matches the Python implementation: comma/space-separated host
 *     patterns, optional leading dot for suffix match, "*" wildcard.
 */

import { baseUrlHostname, normalizeProxyUrl } from "@hermests/core";

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;

/**
 * Read proxy URL from environment variables.
 *
 * Checks `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (and lowercase
 * variants) in order. Returns the first valid proxy URL found, or
 * `null` if no proxy is configured.
 */
export function getProxyFromEnv(): string | null {
  for (const key of PROXY_ENV_KEYS) {
    const value = (process.env[key] ?? "").trim();
    if (value) {
      return normalizeProxyUrl(value);
    }
  }
  return null;
}

/**
 * Return `true` if `host` matches any pattern in the `NO_PROXY`
 * environment variable. Pattern syntax matches CPython's
 * `urllib.request.proxy_bypass_environment`:
 *   - "*" → always bypass.
 *   - Comma OR space separated patterns.
 *   - Leading "." → suffix match against the host.
 *   - Otherwise: case-insensitive substring of "tail" of the host.
 */
function noProxyMatch(host: string): boolean {
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? "").trim();
  if (!noProxy) {
    return false;
  }
  if (noProxy === "*") {
    return true;
  }
  const lower = host.toLowerCase();
  const tokens = noProxy.split(/[,\s]+/).filter(Boolean);
  for (const token of tokens) {
    const pat = token.toLowerCase();
    if (pat.startsWith(".")) {
      // Suffix match — ".example.com" matches "api.example.com" but not
      // bare "example.com" (mirrors CPython behavior precisely).
      if (lower.endsWith(pat) || lower === pat.slice(1)) {
        return true;
      }
      continue;
    }
    if (lower === pat || lower.endsWith(`.${pat}`)) {
      return true;
    }
  }
  return false;
}

/** Return an env-configured proxy unless `NO_PROXY` excludes this base URL. */
export function getProxyForBaseUrl(baseUrl: string | null | undefined): string | null {
  const proxy = getProxyFromEnv();
  if (!proxy || !baseUrl) {
    return proxy;
  }
  const host = baseUrlHostname(baseUrl);
  if (!host) {
    return proxy;
  }
  if (noProxyMatch(host)) {
    return null;
  }
  return proxy;
}

/**
 * Transparent stdio wrapper that swallows EPIPE/EBADF/EIO errors. When
 * Hermes runs as a systemd service, Docker container, or headless
 * daemon, stdout/stderr can become unavailable and any `console.log`
 * call would throw. Wrapping `process.stdout.write` with this protects
 * the agent loop from death-by-print.
 */
const SWALLOWED_CODES: ReadonlySet<string> = new Set(["EPIPE", "EBADF", "EIO"]);

interface SafeWriterTarget {
  write(buffer: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
}

export class SafeWriter {
  private readonly inner: SafeWriterTarget;
  private installed = false;
  private originalWrite: SafeWriterTarget["write"] | null = null;

  constructor(inner: SafeWriterTarget) {
    this.inner = inner;
  }

  /**
   * Replace `inner.write` with a guarded version. Idempotent — calling
   * `install` twice is a no-op so re-importing this module doesn't
   * double-wrap.
   */
  install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;
    // Save the original reference (no bind) so uninstall restores the
    // exact same function the caller can compare with ===.
    this.originalWrite = this.inner.write;
    const inner = this.inner;
    const original = this.originalWrite;
    this.inner.write = function safeWrite(
      this: SafeWriterTarget,
      buffer: string | Uint8Array,
      cb?: (err?: Error | null) => void,
    ): boolean {
      try {
        return original.call(inner, buffer, cb);
      } catch (exc) {
        // Node stdio failures arrive as ErrnoException with `.code`.
        const code = (exc as NodeJS.ErrnoException).code;
        if (code !== undefined && SWALLOWED_CODES.has(code)) {
          if (cb) {
            cb();
          }
          return true;
        }
        throw exc;
      }
    };
  }

  /** Restore the original write. Test-only. */
  uninstall(): void {
    if (!this.installed) {
      return;
    }
    this.installed = false;
    if (this.originalWrite !== null) {
      this.inner.write = this.originalWrite;
    }
  }
}

let _stdoutWriter: SafeWriter | null = null;
let _stderrWriter: SafeWriter | null = null;

/**
 * Wrap `process.stdout` / `process.stderr` so best-effort console
 * output cannot crash the agent. Idempotent.
 */
export function installSafeStdio(): void {
  if (_stdoutWriter === null) {
    _stdoutWriter = new SafeWriter(process.stdout);
    _stdoutWriter.install();
  }
  if (_stderrWriter === null) {
    _stderrWriter = new SafeWriter(process.stderr);
    _stderrWriter.install();
  }
}

/** Test-only: uninstall the safe stdio wrappers. */
export function uninstallSafeStdio(): void {
  if (_stdoutWriter !== null) {
    _stdoutWriter.uninstall();
    _stdoutWriter = null;
  }
  if (_stderrWriter !== null) {
    _stderrWriter.uninstall();
    _stderrWriter = null;
  }
}
