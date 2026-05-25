/**
 * Windows UTF-8 bootstrap for Hermes entry points (port of hermes_bootstrap.py).
 *
 * Faithful divergence: Node on Windows already uses UTF-8 for process.stdout
 * by default in most modern configurations — the cp1252 footgun that
 * motivates the Python module mostly doesn't apply. We still:
 *
 *   1. Set PYTHONUTF8=1 and PYTHONIOENCODING=utf-8 so any Python child
 *      processes we spawn (legacy hermes-agent helpers, tooling) inherit
 *      UTF-8 mode. This is the upstream py:L23-27 behavior.
 *   2. Call `setDefaultEncoding('utf8')` on stdout/stderr when supported.
 *   3. Use setdefault semantics — user opt-out via PYTHONUTF8=0 is respected.
 *
 * Returns true if bootstrap actually applied (Windows + first call).
 * Idempotent: subsequent calls after the first are no-ops.
 *
 * State is exposed via the `_state` object to support the upstream py:L153
 * test pattern that pokes `_IS_WINDOWS` directly to simulate platforms.
 */

export const _state = {
  isWindows: process.platform === "win32",
  bootstrapApplied: false,
};

export function applyWindowsUtf8Bootstrap(): boolean {
  if (!_state.isWindows) return false;
  if (_state.bootstrapApplied) return false;

  // 1. Child processes inherit these and run in UTF-8 mode.
  //    setdefault semantics — only set when missing (respects user opt-out).
  if (process.env.PYTHONUTF8 === undefined) {
    process.env.PYTHONUTF8 = "1";
  }
  if (process.env.PYTHONIOENCODING === undefined) {
    process.env.PYTHONIOENCODING = "utf-8";
  }

  // 2. Reconfigure current process stdio to UTF-8. Mirrors upstream py:L92-119.
  for (const streamName of ["stdout", "stderr"] as const) {
    const stream = process[streamName];
    if (!stream) continue;
    const reconfigure = (stream as unknown as {
      setDefaultEncoding?: (enc: string) => unknown;
    }).setDefaultEncoding;
    if (typeof reconfigure !== "function") continue;
    try {
      reconfigure.call(stream, "utf8");
    } catch {
      // Match upstream: OSError / ValueError are swallowed. The env-var
      // half of the fix still applies for child processes, which is the
      // bigger win.
    }
  }

  // stdin reconfigure — mirrors upstream py:L112-119.
  const stdin = process.stdin as unknown as {
    setEncoding?: (enc: string) => unknown;
  };
  if (stdin && typeof stdin.setEncoding === "function") {
    try {
      stdin.setEncoding("utf8");
    } catch {
      // non-fatal
    }
  }

  _state.bootstrapApplied = true;
  return true;
}

// Apply on import — entry points just need `import "@hermests/core/bootstrap"`
// (or the side-effect-only form) at the top of their module.
applyWindowsUtf8Bootstrap();
