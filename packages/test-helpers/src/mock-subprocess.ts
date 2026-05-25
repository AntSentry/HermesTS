/**
 * MockSubprocess — captures subprocess spawn calls.
 *
 * Tests that exercise code which shells out (git, ffmpeg, custom CLIs)
 * register stub outputs keyed by command, then inspect captured invocations
 * after the system-under-test runs.
 *
 * Command matching:
 *   - exact string match on the command, OR
 *   - a RegExp tested against `command + ' ' + args.join(' ')`.
 *
 * Returned `SpawnResult` is shaped like the resolved value of
 * `child_process.exec` (stdout/stderr/exitCode) so most call sites need
 * only thin adapters.
 */

export interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  timestamp: Date;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  timeoutMs?: number;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type StubKey = string | RegExp;

interface Stub {
  key: StubKey;
  result: SpawnResult | (() => SpawnResult);
}

export class MockSubprocess {
  readonly calls: SpawnCall[] = [];
  private stubs: Stub[] = [];
  private defaultResult: SpawnResult | null = null;

  /**
   * Stub the result for a command.
   * If *result* is a function, it's called per invocation (allows generated outputs).
   */
  stub(command: StubKey, result: Partial<SpawnResult> | (() => Partial<SpawnResult>)): void {
    const normalise = (r: Partial<SpawnResult>): SpawnResult => ({
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? 0,
    });
    if (typeof result === "function") {
      this.stubs.push({ key: command, result: () => normalise(result()) });
    } else {
      this.stubs.push({ key: command, result: normalise(result) });
    }
  }

  /** Result returned when no stub matches. Defaults to throwing. */
  setDefault(result: Partial<SpawnResult>): void {
    this.defaultResult = {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    };
  }

  /** Wipe stubs, captured calls, and the default. */
  reset(): void {
    this.stubs.length = 0;
    this.calls.length = 0;
    this.defaultResult = null;
  }

  /**
   * Run *command* (capturing the call and returning the stubbed result).
   * If no stub matches and no default is set, throws.
   */
  async run(command: string, args: string[] = [], options: SpawnOptions = {}): Promise<SpawnResult> {
    this.calls.push({ command, args: [...args], options: { ...options }, timestamp: new Date() });
    const composite = args.length ? `${command} ${args.join(" ")}` : command;
    for (const stub of this.stubs) {
      const matched =
        typeof stub.key === "string" ? stub.key === command : stub.key.test(composite);
      if (matched) {
        return typeof stub.result === "function" ? stub.result() : stub.result;
      }
    }
    if (this.defaultResult) return this.defaultResult;
    throw new Error(`MockSubprocess: no stub matched '${composite}'`);
  }

  /**
   * Assert at least one captured call matches *matcher*.
   *   - String: matched against the command name (args ignored).
   *   - RegExp: matched against `command + ' ' + args.join(' ')`.
   *   - Function: predicate over SpawnCall.
   */
  assertSpawned(matcher: string | RegExp | ((c: SpawnCall) => boolean)): SpawnCall {
    const test = (c: SpawnCall): boolean => {
      if (typeof matcher === "function") return matcher(c);
      const composite = c.args.length ? `${c.command} ${c.args.join(" ")}` : c.command;
      if (typeof matcher === "string") return c.command === matcher;
      return matcher.test(composite);
    };
    const hit = this.calls.find(test);
    if (!hit) {
      const dump = this.calls.length
        ? this.calls
            .map((c, i) => `  [${i}] ${c.command} ${c.args.join(" ")}`)
            .join("\n")
        : "no calls captured";
      throw new Error(`MockSubprocess.assertSpawned: no match. Calls:\n${dump}`);
    }
    return hit;
  }
}
