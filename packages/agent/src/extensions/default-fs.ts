/**
 * Default `AgentFsHooks` implementation backed by `node:fs`.
 *
 * Used when no override is installed via `setAgentFsHooks`. The skill
 * plumbing reads disk synchronously to match upstream's `Path.read_text`
 * semantics — these helpers preserve that contract while keeping the
 * filesystem accesses behind one swappable interface so tests can run
 * fully in-memory without touching the real FS.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync as fsStatSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";

import type { AgentFsHooks } from "./index.js";

function readTextSync(path: string): string {
  return readFileSync(path, "utf-8");
}

function writeTextSync(path: string, data: string): void {
  writeFileSync(path, data, "utf-8");
}

function statSync(path: string): Stats {
  return fsStatSync(path);
}

function mkdirRecursiveSync(path: string): void {
  mkdirSync(path, { recursive: true });
}

function touchSync(path: string): void {
  const now = new Date();
  utimesSync(path, now, now);
}

function* walkSync(
  root: string,
  options: { followLinks: boolean },
): IterableIterator<{ root: string; dirs: string[]; files: string[] }> {
  const stack: string[] = [resolve(root)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else if (entry.isFile()) {
        files.push(entry.name);
      } else if (options.followLinks && entry.isSymbolicLink()) {
        const fullPath = join(current, entry.name);
        try {
          const st = fsStatSync(fullPath);
          if (st.isDirectory()) dirs.push(entry.name);
          else if (st.isFile()) files.push(entry.name);
        } catch {
          // Broken symlink — silently skip, matches upstream os.walk behaviour.
        }
      }
    }
    // Mirror Python's os.walk: yield first so the consumer can mutate the
    // dirs array (prune unwanted subtrees) BEFORE we descend into them.
    yield { root: current, dirs, files };
    // After the consumer has had a chance to mutate `dirs`, push remaining
    // children onto the stack in reverse order so popping yields them
    // alphabetically (top-down traversal, matching os.walk's default).
    for (let i = dirs.length - 1; i >= 0; i--) {
      stack.push(join(current, dirs[i]!));
    }
  }
}

function globDir(dir: string, patterns: string[]): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const matchers = patterns.map((p) => globToRegExp(p));
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (matchers.some((m) => m.test(entry.name))) {
      out.push(join(dir, entry.name));
    }
  }
  return out.sort();
}

function globToRegExp(pattern: string): RegExp {
  // Minimal glob translation — only `*` and literal chars are used by the
  // callers (the skill bundles glob is `*.yaml` / `*.yml`). We don't
  // support `?`, `[...]`, `**` because upstream doesn't either.
  let body = "";
  for (const ch of pattern) {
    if (ch === "*") body += "[^/]*";
    else if ("\\^$.|?+()[]{}".includes(ch)) body += `\\${ch}`;
    else body += ch;
  }
  return new RegExp(`^${body}$`);
}

export const defaultFsHooks: AgentFsHooks = {
  readTextSync,
  writeTextSync,
  existsSync,
  statSync,
  walkSync,
  globDir,
  mkdirRecursiveSync,
  unlinkSync,
  touchSync,
};
