/**
 * Contextual first-touch onboarding hints — port of upstream
 * `agent/onboarding.py`.
 *
 * Each hint shows once per install (tracked in `config.yaml` under
 * `onboarding.seen.<flag>`) and then never again. This module is kept
 * tiny and dependency-free so both the CLI and gateway can import it.
 *
 * Faithful divergences from upstream:
 *   - `Path.home()` → `os.homedir()`.
 *   - `atomic_yaml_write` is imported lazily upstream via
 *     `from utils import atomic_yaml_write`; ported directly to a top-
 *     level import of `@hermests/core`'s `atomicYamlWrite`.
 *   - The upstream `except Exception` swallows everything; preserved
 *     verbatim so a corrupt YAML doesn't block the agent boot.
 */

import { existsSync as fsExists, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicYamlWrite } from "@hermests/core";
import { parse as parseYaml } from "yaml";

// ─── Flag names (stable — used as config.yaml keys under onboarding.seen)

export const BUSY_INPUT_FLAG = "busy_input_prompt";
export const TOOL_PROGRESS_FLAG = "tool_progress_prompt";
export const OPENCLAW_RESIDUE_FLAG = "openclaw_residue_cleanup";

// ─── Hint content ──────────────────────────────────────────────────────

/**
 * Hint shown the first time a user messages while the agent is busy.
 * Mirrors upstream `busy_input_hint_gateway` (py:L35-59).
 */
export function busyInputHintGateway(mode: string): string {
  if (mode === "queue") {
    return (
      "💡 First-time tip — I queued your message instead of interrupting. " +
      "Send `/busy interrupt` to make new messages stop the current task " +
      "immediately, or `/busy status` to check. This notice won't appear again."
    );
  }
  if (mode === "steer") {
    return (
      "💡 First-time tip — I steered your message into the current run; " +
      "it will arrive after the next tool call instead of interrupting. " +
      "Send `/busy interrupt` or `/busy queue` to change this, or " +
      "`/busy status` to check. This notice won't appear again."
    );
  }
  return (
    "💡 First-time tip — I just interrupted my current task to answer you. " +
    "Send `/busy queue` to queue follow-ups for after the current task instead, " +
    "`/busy steer` to inject them mid-run without interrupting, or " +
    "`/busy status` to check. This notice won't appear again."
  );
}

/** CLI version. Mirrors upstream `busy_input_hint_cli` (py:L62-80). */
export function busyInputHintCli(mode: string): string {
  if (mode === "queue") {
    return (
      "(tip) Your message was queued for the next turn. " +
      "Use /busy interrupt to make Enter stop the current run instead, " +
      "or /busy steer to inject mid-run. This tip only shows once."
    );
  }
  if (mode === "steer") {
    return (
      "(tip) Your message was steered into the current run; it arrives " +
      "after the next tool call. Use /busy interrupt or /busy queue to " +
      "change this. This tip only shows once."
    );
  }
  return (
    "(tip) Your message interrupted the current run. " +
    "Use /busy queue to queue messages for the next turn instead, " +
    "or /busy steer to inject mid-run. This tip only shows once."
  );
}

/** Mirrors upstream `tool_progress_hint_gateway` (py:L83-88). */
export function toolProgressHintGateway(): string {
  return (
    "💡 First-time tip — that tool took a while and I'm streaming every step. " +
    "If the progress messages feel noisy, send `/verbose` to cycle modes " +
    "(all → new → off). This notice won't appear again."
  );
}

/** Mirrors upstream `tool_progress_hint_cli` (py:L91-95). */
export function toolProgressHintCli(): string {
  return (
    "(tip) That tool ran for a while. Use /verbose to cycle tool-progress " +
    "display modes (all -> new -> off -> verbose). This tip only shows once."
  );
}

/** Mirrors upstream `openclaw_residue_hint_cli` (py:L98-114). */
export function openclawResidueHintCli(): string {
  return (
    "A legacy OpenClaw directory was detected at ~/.openclaw/.\n" +
    "To port your config, memory, and skills over to Hermes, run " +
    "`hermes claw migrate`.\n" +
    "If you've already migrated and want to archive the old directory, " +
    "run `hermes claw cleanup` (renames it to ~/.openclaw.pre-migration — " +
    "OpenClaw will stop working after this).\n" +
    "This tip only shows once."
  );
}

/**
 * Return True if an OpenClaw workspace directory is present in `$HOME`.
 *
 * Mirrors upstream `detect_openclaw_residue` (py:L117-126). Pure
 * filesystem check — no side effects. *home* override exists for tests.
 */
export function detectOpenclawResidue(home: string | null | undefined = null): boolean {
  const base = home ?? homedir();
  const target = join(base, ".openclaw");
  try {
    // statSync throws ENOENT when target is absent, ENOTDIR for stray
    // links — both must read as "no residue".
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// ─── State read / write ───────────────────────────────────────────────

function _getSeenDict(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const onboarding = (config as Record<string, unknown>)["onboarding"];
  if (!onboarding || typeof onboarding !== "object" || Array.isArray(onboarding)) return {};
  const seen = (onboarding as Record<string, unknown>)["seen"];
  if (!seen || typeof seen !== "object" || Array.isArray(seen)) return {};
  return seen as Record<string, unknown>;
}

/**
 * Return True if the user has already been shown this first-touch hint.
 * Mirrors upstream `is_seen` (py:L141-143).
 */
export function isSeen(config: unknown, flag: string): boolean {
  return Boolean(_getSeenDict(config)[flag]);
}

/**
 * Persist `onboarding.seen.<flag> = true` to *configPath*. Mirrors
 * upstream `mark_seen` (py:L146-178).
 *
 * Returns true on success, false on any error (including the config
 * file being absent — onboarding is best-effort).
 */
export function markSeen(configPath: string, flag: string): boolean {
  try {
    let cfg: Record<string, unknown> = {};
    if (fsExists(configPath)) {
      try {
        const parsed = parseYaml(readFileSync(configPath, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          cfg = parsed as Record<string, unknown>;
        }
      } catch {
        // Corrupt YAML — proceed with empty cfg, matches upstream's
        // `yaml.safe_load(f) or {}` fallback.
        cfg = {};
      }
    }
    let onboarding = cfg["onboarding"];
    if (!onboarding || typeof onboarding !== "object" || Array.isArray(onboarding)) {
      onboarding = {};
      cfg["onboarding"] = onboarding;
    }
    let seen = (onboarding as Record<string, unknown>)["seen"];
    if (!seen || typeof seen !== "object" || Array.isArray(seen)) {
      seen = {};
      (onboarding as Record<string, unknown>)["seen"] = seen;
    }
    if ((seen as Record<string, unknown>)[flag] === true) {
      return true;
    }
    (seen as Record<string, unknown>)[flag] = true;
    atomicYamlWrite(configPath, cfg);
    return true;
  } catch {
    return false;
  }
}
