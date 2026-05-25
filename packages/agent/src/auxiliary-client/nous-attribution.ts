/**
 * Nous Portal attribution `extra_body` builder.
 * Faithful port of lines 397-424 of upstream `agent/auxiliary_client.py`.
 *
 * Tags are computed at call time so a hot-reloaded `hermes_cli.__version__`
 * is reflected without restarting long-running processes. The
 * `_nous_extra_body()` upstream private helper is exposed here as
 * `nousExtraBody()`.
 */

import { nousPortalTags } from "../_internal/sibling-stubs.js";

/**
 * Return a fresh Nous Portal `extra_body` dict. Faithful to
 * `_nous_extra_body` (py:L408-414).
 *
 * Callers should pass this as `extra_body` in
 * `chat.completions.create()` when the auxiliary client is backed by Nous
 * Portal. The dict is fresh each call — callers may freely mutate it.
 */
export function nousExtraBody(): { tags: string[] } {
  return { tags: nousPortalTags() };
}

/**
 * Backwards-compatible module-level snapshot. Some callers (tests, third-party
 * plugins) read `NOUS_EXTRA_BODY` directly; this keeps it as a snapshot of
 * the current tags at module-load time. Callers that need the freshest value
 * should call `nousExtraBody()` instead.
 *
 * Faithful to the module-level `NOUS_EXTRA_BODY = _nous_extra_body()`
 * (py:L421).
 */
export const NOUS_EXTRA_BODY: { tags: string[] } = nousExtraBody();

/**
 * Mutable module-level flag: set at resolve time — `true` if the auxiliary
 * client points to Nous Portal. Faithful to `auxiliary_is_nous: bool = False`
 * (py:L424).
 *
 * Exposed as a getter/setter pair so resolution code can flip it from
 * outside this module without breaking the per-module-variable contract that
 * tests rely on (`import { isAuxiliaryNous } from ...` always returns the
 * current value).
 */
let _auxiliaryIsNous = false;

/** Read the current value of `auxiliary_is_nous`. */
export function isAuxiliaryNous(): boolean {
  return _auxiliaryIsNous;
}

/** Set the current value of `auxiliary_is_nous`. */
export function setAuxiliaryIsNous(value: boolean): void {
  _auxiliaryIsNous = value;
}
