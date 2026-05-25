/**
 * External secret source integrations.
 *
 * Faithful port of upstream `agent/secret_sources/__init__.py` (the
 * package marker — 14 LOC of docstring).
 *
 * A secret source is anything that can supply environment-variable-
 * shaped credentials at process startup, AFTER `~/.hermes/.env` has
 * loaded. By default sources are non-destructive: they only set values
 * for env vars that aren't already present, so .env and shell exports
 * continue to win.
 *
 * Currently shipped (in upstream — ports land in later sub-tasks):
 *
 *   - `bitwarden` — Bitwarden Secrets Manager (`bws` CLI). The
 *     concrete port lives in sub-task #5g (auth + credentials); this
 *     file only re-establishes the package marker.
 */

/** Description text mirrored from the upstream docstring for traceability. */
export const SECRET_SOURCES_DESCRIPTION =
  "External secret source integrations supplied to the process AFTER " +
  "~/.hermes/.env loads. Non-destructive by default — existing env " +
  "vars are not overwritten.";
