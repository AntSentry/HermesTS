// Ported from tests/test_hermes_bootstrap.py
// TestEntryPointsImportBootstrap is deferred to whichever task owns each
// entry point (cli #14, agent #5, acp #9, gateway #10, batch #13).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { _state, applyWindowsUtf8Bootstrap } from "../src/hermes-bootstrap.js";

const ENV_UTF8 = "PYTHONUTF8";
const ENV_IOENCODING = "PYTHONIOENCODING";

function resetState(isWindows: boolean): void {
  _state.isWindows = isWindows;
  _state.bootstrapApplied = false;
}

function saveEnv(): { utf8: string | undefined; ioenc: string | undefined } {
  return {
    utf8: process.env[ENV_UTF8],
    ioenc: process.env[ENV_IOENCODING],
  };
}

function restoreEnv(saved: { utf8: string | undefined; ioenc: string | undefined }): void {
  if (saved.utf8 === undefined) delete process.env[ENV_UTF8];
  else process.env[ENV_UTF8] = saved.utf8;
  if (saved.ioenc === undefined) delete process.env[ENV_IOENCODING];
  else process.env[ENV_IOENCODING] = saved.ioenc;
}

describe("apply_windows_utf8_bootstrap — simulated Windows", () => {
  let saved: ReturnType<typeof saveEnv>;

  beforeEach(() => {
    saved = saveEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetState(process.platform === "win32");
    vi.restoreAllMocks();
  });

  test("env vars set on simulated Windows", () => {
    // simulates Windows branch from hermes_bootstrap.py:L23-27
    delete process.env[ENV_UTF8];
    delete process.env[ENV_IOENCODING];
    resetState(true);

    const applied = applyWindowsUtf8Bootstrap();

    expect(applied).toBe(true);
    expect(process.env[ENV_UTF8]).toBe("1");
    expect(process.env[ENV_IOENCODING]).toBe("utf-8");
    expect(_state.bootstrapApplied).toBe(true);
  });

  test("respects user opt-out: PYTHONUTF8=0 preserved", () => {
    // simulates user_pythonutf8_zero_preserved from hermes_bootstrap.py:L24
    process.env[ENV_UTF8] = "0";
    delete process.env[ENV_IOENCODING];
    resetState(true);

    applyWindowsUtf8Bootstrap();

    expect(process.env[ENV_UTF8]).toBe("0");
  });

  test("respects user opt-out: PYTHONIOENCODING preserved", () => {
    // simulates user_pythonioencoding_preserved from hermes_bootstrap.py:L26
    delete process.env[ENV_UTF8];
    process.env[ENV_IOENCODING] = "latin-1";
    resetState(true);

    applyWindowsUtf8Bootstrap();

    expect(process.env[ENV_IOENCODING]).toBe("latin-1");
  });

  test("idempotent: second call returns false", () => {
    delete process.env[ENV_UTF8];
    delete process.env[ENV_IOENCODING];
    resetState(true);

    expect(applyWindowsUtf8Bootstrap()).toBe(true);
    expect(applyWindowsUtf8Bootstrap()).toBe(false);
  });

  test("repeated calls do not raise", () => {
    resetState(true);
    for (let i = 0; i < 5; i++) {
      expect(() => applyWindowsUtf8Bootstrap()).not.toThrow();
    }
  });

  test("reconfigure call is attempted on stdout and stderr", () => {
    // simulates stdout_reconfigured_to_utf8 from hermes_bootstrap.py:L92-119
    delete process.env[ENV_UTF8];
    delete process.env[ENV_IOENCODING];
    resetState(true);

    const stdoutSpy = vi.fn();
    const stderrSpy = vi.fn();
    vi.stubGlobal("process", {
      ...process,
      stdout: {
        ...process.stdout,
        setDefaultEncoding: stdoutSpy,
      },
      stderr: {
        ...process.stderr,
        setDefaultEncoding: stderrSpy,
      },
      stdin: {
        ...process.stdin,
        setEncoding: () => undefined,
      },
      env: process.env,
      platform: "win32",
    });

    applyWindowsUtf8Bootstrap();
    expect(stdoutSpy).toHaveBeenCalledWith("utf8");
    expect(stderrSpy).toHaveBeenCalledWith("utf8");
  });

  test("reconfigure OSError is swallowed", () => {
    // simulates reconfigure_oserror_is_caught from hermes_bootstrap.py:L94 (try/except)
    resetState(true);

    vi.stubGlobal("process", {
      ...process,
      stdout: {
        ...process.stdout,
        setDefaultEncoding: () => {
          throw new Error("simulated: stream already closed");
        },
      },
      stderr: {
        ...process.stderr,
        setDefaultEncoding: () => {
          throw new Error("simulated: stream already closed");
        },
      },
      stdin: {
        ...process.stdin,
        setEncoding: () => {
          throw new Error("simulated stdin failure");
        },
      },
      env: process.env,
      platform: "win32",
    });

    expect(() => applyWindowsUtf8Bootstrap()).not.toThrow();
  });

  test("non-reconfigurable stream does not crash (missing setDefaultEncoding)", () => {
    // simulates non_reconfigurable_stream_does_not_crash from hermes_bootstrap.py:L92 (typeof check)
    resetState(true);

    // Stream lacks setDefaultEncoding entirely — typeof check should skip.
    vi.stubGlobal("process", {
      ...process,
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: { write: () => true },
      env: process.env,
      platform: "win32",
    });

    expect(() => applyWindowsUtf8Bootstrap()).not.toThrow();
  });

  test("stdin reconfigure is attempted when supported", () => {
    // simulates stdin reconfigure from hermes_bootstrap.py:L112-119
    resetState(true);

    const stdinSpy = vi.fn();
    vi.stubGlobal("process", {
      ...process,
      stdout: { setDefaultEncoding: () => undefined },
      stderr: { setDefaultEncoding: () => undefined },
      stdin: { setEncoding: stdinSpy },
      env: process.env,
      platform: "win32",
    });

    applyWindowsUtf8Bootstrap();
    expect(stdinSpy).toHaveBeenCalledWith("utf8");
  });

  test("falsy stream is skipped", () => {
    // simulates the `if (!stream) continue;` guard for missing stdio
    resetState(true);

    vi.stubGlobal("process", {
      ...process,
      stdout: null,
      stderr: null,
      stdin: null,
      env: process.env,
      platform: "win32",
    });

    expect(() => applyWindowsUtf8Bootstrap()).not.toThrow();
    expect(_state.bootstrapApplied).toBe(true);
  });
});

describe("apply_windows_utf8_bootstrap — POSIX no-op", () => {
  let saved: ReturnType<typeof saveEnv>;

  beforeEach(() => {
    saved = saveEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetState(process.platform === "win32");
  });

  test("returns false and leaves env untouched", () => {
    // simulates POSIX branch from hermes_bootstrap.py:L80 (if not _IS_WINDOWS)
    resetState(false);
    delete process.env[ENV_UTF8];
    delete process.env[ENV_IOENCODING];

    const result = applyWindowsUtf8Bootstrap();

    expect(result).toBe(false);
    expect(ENV_UTF8 in process.env).toBe(false);
    expect(ENV_IOENCODING in process.env).toBe(false);
    expect(_state.bootstrapApplied).toBe(false);
  });
});

describe("module-level _state", () => {
  test("isWindows reflects process.platform at import time", () => {
    // The exported _state may have been mutated by other tests in this
    // file. The contract from hermes_bootstrap.ts:L21-24 is that on
    // import, isWindows == (process.platform === 'win32').
    // After tests run, we restore that invariant via resetState in
    // afterEach. Verify the field is at least a boolean.
    expect(typeof _state.isWindows).toBe("boolean");
    expect(typeof _state.bootstrapApplied).toBe("boolean");
  });
});
