/**
 * Centralized Nous Portal request tags.
 *
 * Faithful port of upstream `agent/portal_tags.py`.
 *
 * Every Hermes request that hits the Nous Portal — main agent loop,
 * auxiliary client (compression / titles / vision / web_extract /
 * session_search / etc.), and any future code path — must carry the same
 * product-attribution tags so Nous can attribute usage to Hermes Agent and
 * bucket it by client release.
 *
 * Faithful divergence:
 *   - Upstream lazy-imports `from hermes_cli import __version__` at call
 *     time so tests that monkey-patch the version see the change. TS has
 *     no equivalent module-attribute monkey-patch; we expose
 *     `setHermesVersionProvider(fn)` as a DI seam so the cli package (or
 *     tests) can override the version resolver without touching this
 *     module. Mirrors the `UserAgentProvider` pattern in
 *     `@hermests/providers`.
 */

export type HermesVersionProvider = () => string;

let _versionProvider: HermesVersionProvider | null = null;

/**
 * Override the version provider used by `hermesClientTag` /
 * `nousPortalTags`. The cli package wires the real `__version__` here at
 * load time; the default fallback returns `"unknown"`.
 */
export function setHermesVersionProvider(fn: HermesVersionProvider): void {
  _versionProvider = fn;
}

/** Reset the version provider to the built-in fallback. Test-only helper. */
export function resetHermesVersionProvider(): void {
  _versionProvider = null;
}

/** Return the current Hermes release version, e.g. `"0.13.0"`. */
function hermesVersion(): string {
  if (_versionProvider === null) {
    return "unknown";
  }
  try {
    return _versionProvider();
  } catch {
    return "unknown";
  }
}

/**
 * Return the `client=...` tag for Nous Portal requests.
 *
 * Format: `client=hermes-client-v<MAJOR>.<MINOR>.<PATCH>`.
 */
export function hermesClientTag(): string {
  return `client=hermes-client-v${hermesVersion()}`;
}

/**
 * Return the canonical list of Nous Portal product tags.
 *
 * Always returns a fresh array so callers can mutate it freely.
 */
export function nousPortalTags(): string[] {
  return ["product=hermes-agent", hermesClientTag()];
}
