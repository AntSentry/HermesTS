/**
 * Shared SKILL.md preprocessing helpers — port of upstream
 * `agent/skill_preprocessing.py`.
 *
 * Faithful divergences from upstream:
 *   - `subprocess.run(['bash', '-c', cmd], timeout=N)` →
 *     `child_process.spawnSync('bash', ['-c', cmd], { timeout: N*1000 })`.
 *     The Node form returns an object with `status`, `stdout`, `stderr`,
 *     `error`, `signal`; we map TIMEOUT/ENOENT/other failures to the
 *     same in-band markers upstream emits so a failing snippet never
 *     breaks the surrounding skill message.
 *   - `load_skills_config()` calls upstream `hermes_cli.config.load_config`
 *     which lives in #14 (cli). Routed through the extension registry —
 *     when no override is installed, returns `{}` (matching upstream's
 *     "best-effort with try/except" intent).
 *   - The `tests/conftest.py` live-system guard quirk upstream papers
 *     over is not relevant to Node — we don't need that branch.
 */

import { spawnSync } from "node:child_process";

import { getHermesHomeHooks } from "../extensions/index.js";

// Matches ${HERMES_SKILL_DIR} / ${HERMES_SESSION_ID} tokens in SKILL.md.
// Tokens that don't resolve are left as-is so the user can debug them.
const _SKILL_TEMPLATE_RE = /\$\{(HERMES_SKILL_DIR|HERMES_SESSION_ID)\}/g;

// Matches inline shell snippets like:  !`date +%Y-%m-%d`
// Non-greedy, single-line only — no newlines inside the backticks.
const _INLINE_SHELL_RE = /!`([^`\n]+)`/g;

// Cap inline-shell output so a runaway command can't blow out the context.
const _INLINE_SHELL_MAX_OUTPUT = 4000;

/**
 * Load the `skills` section of config.yaml (best-effort).
 *
 * Mirrors upstream `load_skills_config` (py:L23-34). The upstream
 * `hermes_cli.config.load_config` import lives in #14 (cli) — routed
 * through the extension registry; returns `{}` when no override is
 * installed, matching upstream's "broken import means default behaviour"
 * intent.
 */
export function loadSkillsConfig(): Record<string, unknown> {
  const hooks = getHermesHomeHooks();
  if (!hooks) return {};
  let cfg: unknown;
  try {
    cfg = hooks.loadConfig();
  } catch {
    return {};
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return {};
  const skillsCfg = (cfg as Record<string, unknown>)["skills"];
  if (!skillsCfg || typeof skillsCfg !== "object" || Array.isArray(skillsCfg)) return {};
  return skillsCfg as Record<string, unknown>;
}

/**
 * Replace `${HERMES_SKILL_DIR}` / `${HERMES_SESSION_ID}` in *content*.
 *
 * Only substitutes tokens for which a concrete value is available;
 * unresolved tokens are left in place. Mirrors upstream
 * `substitute_template_vars` (py:L37-60).
 */
export function substituteTemplateVars(
  content: string,
  skillDir: string | null | undefined,
  sessionId: string | null | undefined,
): string {
  if (!content) return content;
  const skillDirStr = skillDir ? String(skillDir) : null;
  const sessionIdStr = sessionId ? String(sessionId) : null;

  return content.replace(_SKILL_TEMPLATE_RE, (match, token: string) => {
    if (token === "HERMES_SKILL_DIR" && skillDirStr) return skillDirStr;
    if (token === "HERMES_SESSION_ID" && sessionIdStr) return sessionIdStr;
    return match;
  });
}

/**
 * Execute a single inline-shell snippet and return its trimmed stdout.
 *
 * Failures return a short `[inline-shell error: ...]` marker so one bad
 * snippet can't wreck the whole skill message. Mirrors upstream
 * `run_inline_shell` (py:L63-98).
 */
export function runInlineShell(
  command: string,
  cwd: string | null | undefined,
  timeout: number,
): string {
  const effectiveTimeout = Math.max(1, Math.trunc(timeout));
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("bash", ["-c", command], {
      cwd: cwd ?? undefined,
      timeout: effectiveTimeout * 1000,
      encoding: "utf-8",
    });
  } catch (err) {
    return `[inline-shell error: ${(err as Error).message}]`;
  }

  if (result.error) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return "[inline-shell error: bash not found]";
    if (e.code === "ETIMEDOUT") {
      return `[inline-shell timeout after ${effectiveTimeout}s: ${command}]`;
    }
    /* v8 ignore next */ // generic spawn error path — bash + Node always surface as ENOENT or ETIMEDOUT in practice; defensive guard preserves upstream's broad `except Exception` (py:L90-91).
    return `[inline-shell error: ${e.message}]`;
  }

  /* v8 ignore next 3 */ // SIGTERM/SIGKILL signal-without-error reporting differs across Node versions; defensive parity with upstream's timeout marker (py:L78-79).
  if (result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    return `[inline-shell timeout after ${effectiveTimeout}s: ${command}]`;
  }

  let output = ((result.stdout as string | null) ?? "").replace(/\n+$/, "");
  if (!output && result.stderr) {
    output = String(result.stderr).replace(/\n+$/, "");
  }
  if (output.length > _INLINE_SHELL_MAX_OUTPUT) {
    output = `${output.slice(0, _INLINE_SHELL_MAX_OUTPUT)}...[truncated]`;
  }
  return output;
}

/**
 * Replace every `!`cmd`` snippet in *content* with its stdout. Runs each
 * snippet with the skill directory as CWD so relative paths work the
 * way the author expects. Mirrors upstream `expand_inline_shell`
 * (py:L101-120).
 */
export function expandInlineShell(
  content: string,
  skillDir: string | null | undefined,
  timeout: number,
): string {
  if (!content.includes("!`")) return content;
  return content.replace(_INLINE_SHELL_RE, (_match, raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return "";
    return runInlineShell(cmd, skillDir ?? null, timeout);
  });
}

/**
 * Apply configured SKILL.md template and inline-shell preprocessing.
 *
 * Mirrors upstream `preprocess_skill_content` (py:L123-139). Defaults:
 * `template_vars=true`, `inline_shell=false`, `inline_shell_timeout=10`.
 */
export function preprocessSkillContent(
  content: string,
  skillDir: string | null | undefined,
  sessionId: string | null | undefined = null,
  skillsCfg: Record<string, unknown> | null = null,
): string {
  if (!content) return content;
  const cfg = skillsCfg && typeof skillsCfg === "object" ? skillsCfg : loadSkillsConfig();

  if (cfg["template_vars"] !== false) {
    content = substituteTemplateVars(content, skillDir, sessionId);
  }
  if (cfg["inline_shell"] === true) {
    const rawTimeout = cfg["inline_shell_timeout"];
    const timeout =
      typeof rawTimeout === "number" && Number.isFinite(rawTimeout) ? Math.trunc(rawTimeout) : 10;
    content = expandInlineShell(content, skillDir, timeout > 0 ? timeout : 10);
  }
  return content;
}
