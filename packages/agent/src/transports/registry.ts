/**
 * Transport registry.
 *
 * Faithful port of upstream `agent/transports/__init__.py`.
 *
 * Upstream behaviour preserved:
 *   - Registration is name-keyed; later registrations replace earlier ones.
 *   - `getTransport()` returns a fresh instance per call (not the class) —
 *     matches upstream `cls()` semantics.
 *   - First miss triggers discovery; subsequent misses ALSO re-trigger
 *     discovery once (upstream regression fix for partially-populated
 *     registries when individual transport modules are imported directly).
 *
 * ── Faithful divergences ──────────────────────────────────────────────
 * 1. Upstream auto-registers Anthropic / Codex / Chat-Completions / Bedrock
 *    at the bottom of each module. In TS we keep the registration
 *    side-effect at the bottom of each transport module (importing the
 *    barrel triggers them all) but the per-transport modules each take an
 *    adapter argument before they can be wired — so we expose explicit
 *    `registerXxxTransport(adapter)` helpers in each module. The barrel
 *    `index.ts` does NOT auto-import the per-provider files — call sites
 *    register on demand. This keeps `@hermests/agent` cycle-free with the
 *    sibling adapter sub-tasks (#5h / #5i / #5n).
 * 2. Upstream's `_discover_transports()` swallows `ImportError` from each
 *    sibling module. We do not need that fallback since registration is
 *    explicit; `_discoverTransports()` is a no-op stub kept for symmetry
 *    and tested for completeness.
 */

import type { ProviderTransport } from "./base.js";

/** Factory function — returns a fresh transport instance per call. */
export type TransportFactory = () => ProviderTransport;

const _REGISTRY = new Map<string, TransportFactory>();
let _discovered = false;

// Test seam: allow the discovery hook to be replaced. Production code never
// touches this; tests use it to verify the partial-registry recovery path.
let _discoveryHook: () => void = _noopDiscover;

/**
 * Register a transport factory for an `apiMode` string.
 *
 * Idempotent: re-registering the same `apiMode` replaces the prior factory
 * (matches upstream `_REGISTRY[api_mode] = transport_cls`).
 */
export function registerTransport(apiMode: string, factory: TransportFactory): void {
  _REGISTRY.set(apiMode, factory);
}

/**
 * Get a transport instance for the given `apiMode`, or `null` if no
 * transport is registered.
 *
 * On miss, runs the discovery hook once. If a miss persists, runs the
 * hook again — this matches the upstream regression fix where importing
 * one transport module directly (e.g. `agent.transports.chat_completions`)
 * leaves the registry partially populated and a subsequent lookup for a
 * different api_mode would otherwise return `null` despite the transport
 * being available via discovery.
 */
export function getTransport(apiMode: string): ProviderTransport | null {
  if (!_discovered) {
    _discoveryHook();
    _discovered = true;
  }
  let factory = _REGISTRY.get(apiMode);
  if (factory === undefined) {
    // Re-discover on miss, not only when the registry is empty, so
    // order-dependent imports do not make valid api_modes unavailable.
    _discoveryHook();
    factory = _REGISTRY.get(apiMode);
  }
  if (factory === undefined) {
    return null;
  }
  return factory();
}

/**
 * Replace the discovery hook used by `getTransport()`. Test-only — call
 * sites that need to wire a transport at startup should use
 * `registerTransport()` directly. Restores the no-op default when called
 * with `null`.
 */
export function _setDiscoveryHookForTesting(hook: (() => void) | null): void {
  _discoveryHook = hook ?? _noopDiscover;
}

/**
 * Force the registry to re-run discovery on next access. Test-only —
 * mirrors how upstream tests reset `_discovered = False`.
 */
export function _resetTransportRegistryForTesting(): void {
  _REGISTRY.clear();
  _discovered = false;
  _discoveryHook = _noopDiscover;
}

/**
 * Internal accessor for tests that need to inspect the live registry.
 * Returns a read-only view — mutations require `registerTransport()`.
 */
export function _getRegistry(): ReadonlyMap<string, TransportFactory> {
  return _REGISTRY;
}

function _noopDiscover(): void {
  // No-op by design. Upstream's discovery imports each sibling module to
  // trigger their bottom-of-file `register_transport()` calls. In TS the
  // sibling modules each export an explicit `registerXxxTransport(adapter)`
  // helper that the wiring code (deferred to integrators sub-task #5o)
  // must call with the appropriate adapter. See `registry.ts` header.
}
