/**
 * Credential-pool accessor helpers used by the auxiliary client.
 * Faithful port of lines 513-572 of upstream `agent/auxiliary_client.py`.
 *
 * These helpers wrap `agent.credential_pool.load_pool` and the
 * `PooledCredential` instance shape so that the resolution chain can read
 * runtime API keys / base URLs without crashing when the pool is unavailable
 * or partially populated.
 */

import { getLogger } from "@hermests/core";
import {
  type CredentialPoolLike,
  type PooledCredentialLike,
  loadPool,
} from "../_internal/sibling-stubs.js";

const logger = getLogger("agent.auxiliary_client.pool_helpers");

/** Tuple result of `selectPoolEntry`: `[poolExistsForProvider, selectedEntry]`. */
export interface SelectPoolResult {
  poolExists: boolean;
  entry: PooledCredentialLike | null;
}

/**
 * Return `(pool_exists_for_provider, selected_entry)`. Faithful to
 * `_select_pool_entry` (py:L513-526). Both load and select swallow exceptions
 * and log at debug — pool failures must never abort an aux call.
 */
export function selectPoolEntry(provider: string): SelectPoolResult {
  let pool: CredentialPoolLike | null;
  try {
    pool = loadPool(provider);
  } catch (exc) {
    logger.debug("Auxiliary client: could not load pool for %s: %s", provider, exc);
    return { poolExists: false, entry: null };
  }
  if (!pool || !pool.has_credentials()) {
    return { poolExists: false, entry: null };
  }
  try {
    return { poolExists: true, entry: pool.select() };
  } catch (exc) {
    logger.debug("Auxiliary client: could not select pool entry for %s: %s", provider, exc);
    return { poolExists: true, entry: null };
  }
}

/**
 * Best-effort current / next pool entry without mutating selection order.
 * Faithful to `_peek_pool_entry` (py:L529-549).
 *
 * Prefers `pool.current()` when defined; otherwise falls back to `pool.peek()`.
 * Returns `null` on any failure.
 */
export function peekPoolEntry(provider: string): PooledCredentialLike | null {
  let pool: CredentialPoolLike | null;
  try {
    pool = loadPool(provider);
  } catch (exc) {
    logger.debug("Auxiliary client: could not load pool for %s (peek): %s", provider, exc);
    return null;
  }
  if (!pool || !pool.has_credentials()) {
    return null;
  }
  try {
    if (typeof pool.current === "function") {
      const current = pool.current();
      if (current !== null && current !== undefined) {
        return current;
      }
    }
    if (typeof pool.peek === "function") {
      return pool.peek();
    }
  } catch (exc) {
    logger.debug("Auxiliary client: could not peek pool entry for %s: %s", provider, exc);
  }
  return null;
}

/**
 * Read the runtime API key from a pool entry, applying the
 * `PooledCredential.runtime_api_key` property's provider-specific fallback
 * (e.g. `agent_key` for nous).
 *
 * Faithful to `_pool_runtime_api_key` (py:L552-558).
 */
export function poolRuntimeApiKey(entry: PooledCredentialLike | null | undefined): string {
  if (entry === null || entry === undefined) {
    return "";
  }
  // Use the PooledCredential.runtime_api_key field which handles
  // provider-specific fallback (e.g. agent_key for nous). Upstream uses
  // Python's truthy `or`, so empty-string runtime_api_key falls through to
  // access_token — keep that semantic by using `||`.
  const key = entry.runtime_api_key || entry.access_token || "";
  return String(key || "").trim();
}

/**
 * Read the runtime base URL from a pool entry, falling through
 * `runtime_base_url` → `inference_base_url` → `base_url` → `fallback`.
 * Faithful to `_pool_runtime_base_url` (py:L561-572).
 */
export function poolRuntimeBaseUrl(
  entry: PooledCredentialLike | null | undefined,
  fallback = "",
): string {
  if (entry === null || entry === undefined) {
    return String(fallback || "")
      .trim()
      .replace(/\/+$/, "");
  }
  // Upstream chains the fallbacks with `or` — empty strings on the entry must
  // fall through, not short-circuit a `??`. `fallback` defaults to "" at the
  // signature so even if all four sources are falsy `url` is always a string.
  const url = entry.runtime_base_url || entry.inference_base_url || entry.base_url || fallback;
  return String(url).trim().replace(/\/+$/, "");
}
