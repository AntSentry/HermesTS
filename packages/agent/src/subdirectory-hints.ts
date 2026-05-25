/**
 * Progressive subdirectory hint discovery.
 *
 * Faithful port of upstream `agent/subdirectory_hints.py`.
 *
 * As the agent navigates into subdirectories via tool calls
 * (read_file, terminal, search_files, etc.), this module discovers and
 * loads project context files (AGENTS.md, CLAUDE.md, .cursorrules)
 * from those directories. Discovered hints are appended to the tool
 * result so the model gets relevant context at the moment it starts
 * working in a new area of the codebase.
 *
 * Faithful divergence:
 *   - Upstream imports `_scan_context_content` from
 *     `agent.prompt_builder`. The prompt-builder port lives in
 *     sub-task #5f. Until that lands, we inject the scanner via
 *     `setContextScanner(fn)` so this module compiles standalone. The
 *     default is identity (no scan). The #5f porter will wire the
 *     real scanner in their package init.
 *   - Upstream uses `shlex.split` for shell-style command parsing. TS
 *     gets the equivalent via a small parser that handles single and
 *     double quotes (the only forms shlex.split treats specially for
 *     POSIX shells). Tokens that fail to parse fall back to whitespace
 *     split, matching upstream's `except ValueError` branch.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

import { getLogger } from "@hermests/core";

const logger = getLogger("agent.subdirectory_hints");

// Context files to look for in subdirectories, in priority order.
const HINT_FILENAMES = ["AGENTS.md", "agents.md", "CLAUDE.md", "claude.md", ".cursorrules"];

// Maximum chars per hint file to prevent context bloat.
const MAX_HINT_CHARS = 8_000;

const PATH_ARG_KEYS: ReadonlySet<string> = new Set(["path", "file_path", "workdir"]);

const COMMAND_TOOLS: ReadonlySet<string> = new Set(["terminal"]);

const MAX_ANCESTOR_WALK = 5;

/** DI seam for the prompt-builder scanner (ported in sub-task #5f). */
export type ContextScanner = (content: string, filename: string) => string;

const _identityScanner: ContextScanner = (content, _filename) => content;
let _contextScanner: ContextScanner = _identityScanner;

/**
 * Override the context-content scanner used to sanitize discovered
 * hint files. Upstream uses `agent.prompt_builder._scan_context_content`.
 * Setting `null` restores the identity default.
 */
export function setContextScanner(fn: ContextScanner | null): void {
  _contextScanner = fn ?? _identityScanner;
}

function expandUser(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function tryIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function tryIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function hasExtension(path: string): boolean {
  // Match Python's `Path.suffix` semantics — non-empty when the
  // basename has a non-leading dot.
  return Boolean(parse(path).ext);
}

export class SubdirectoryHintTracker {
  readonly workingDir: string;
  private readonly loadedDirs: Set<string> = new Set();

  constructor(workingDir?: string | null) {
    const wd = workingDir ?? process.cwd();
    this.workingDir = resolve(wd);
    this.loadedDirs.add(this.workingDir);
  }

  /**
   * Check tool call arguments for new directories and load any hint
   * files. Returns formatted hint text to append to the tool result,
   * or `null`.
   */
  checkToolCall(toolName: string, toolArgs: Record<string, unknown>): string | null {
    const dirs = this.extractDirectories(toolName, toolArgs);
    if (dirs.length === 0) {
      return null;
    }

    const allHints: string[] = [];
    for (const d of dirs) {
      const hints = this.loadHintsForDirectory(d);
      if (hints !== null) {
        allHints.push(hints);
      }
    }

    if (allHints.length === 0) {
      return null;
    }

    return `\n\n${allHints.join("\n\n")}`;
  }

  private extractDirectories(toolName: string, args: Record<string, unknown>): string[] {
    const candidates = new Set<string>();

    for (const key of PATH_ARG_KEYS) {
      const val = args[key];
      if (typeof val === "string" && val.trim()) {
        this.addPathCandidate(val, candidates);
      }
    }

    if (COMMAND_TOOLS.has(toolName)) {
      const cmd = args.command;
      if (typeof cmd === "string") {
        this.extractPathsFromCommand(cmd, candidates);
      }
    }

    return [...candidates];
  }

  private addPathCandidate(rawPath: string, candidates: Set<string>): void {
    let p = expandUser(rawPath);
    if (!isAbsolute(p)) {
      p = join(this.workingDir, p);
    }
    p = resolve(p);
    // Use parent if it's a file path (has extension or exists as file).
    if (hasExtension(p) || (existsSync(p) && tryIsFile(p))) {
      p = parse(p).dir;
    }
    for (let step = 0; step < MAX_ANCESTOR_WALK; step += 1) {
      if (this.loadedDirs.has(p)) {
        break;
      }
      if (this.isValidSubdir(p)) {
        candidates.add(p);
      }
      const parent = parse(p).dir;
      if (parent === p) {
        break;
      }
      p = parent;
    }
  }

  private extractPathsFromCommand(cmd: string, candidates: Set<string>): void {
    // Whitespace split is enough for path discovery — quoted paths that
    // contain spaces are rare in agent-emitted commands and the worst
    // case is missing a hint, not crashing. Upstream `shlex.split` is
    // wrapped in `except ValueError` for the same reason; the simpler
    // implementation matches the upstream fall-through branch.
    const tokens = cmd.split(/\s+/).filter((t) => t.length > 0);

    for (const token of tokens) {
      if (token.startsWith("-")) {
        continue;
      }
      if (!token.includes("/") && !token.includes(".")) {
        continue;
      }
      if (
        token.startsWith("http://") ||
        token.startsWith("https://") ||
        token.startsWith("git@")
      ) {
        continue;
      }
      this.addPathCandidate(token, candidates);
    }
  }

  private isValidSubdir(path: string): boolean {
    // `addPathCandidate` already checks `loadedDirs.has(path)` before
    // we get here, so we only need the dir-stat probe.
    return tryIsDir(path);
  }

  private loadHintsForDirectory(directory: string): string | null {
    this.loadedDirs.add(directory);

    const found: Array<[string, string]> = [];
    for (const filename of HINT_FILENAMES) {
      const hintPath = join(directory, filename);
      if (!tryIsFile(hintPath)) {
        continue;
      }
      try {
        let content = readFileSync(hintPath, "utf-8").trim();
        if (!content) {
          continue;
        }
        content = _contextScanner(content, filename);
        if (content.length > MAX_HINT_CHARS) {
          content =
            content.slice(0, MAX_HINT_CHARS) +
            `\n\n[...truncated ${filename}: ${content.length.toLocaleString("en-US")} chars total]`;
        }
        // Display the hint location relative to the working directory.
        // Walked-up ancestors always satisfy `!rel.startsWith("..")`
        // because we resolved them by ascending from inside workingDir.
        const rel = relative(this.workingDir, hintPath);
        const relPath = rel && !rel.startsWith("..") ? rel : hintPath;
        found.push([relPath, content]);
        // First match wins per directory.
        break;
      } catch (exc) {
        logger.debug(`Could not read ${hintPath}: ${(exc as Error).message}`);
      }
    }

    if (found.length === 0) {
      return null;
    }

    const sections = found.map(
      ([relPath, content]) => `[Subdirectory context discovered: ${relPath}]\n${content}`,
    );

    logger.debug(`Loaded subdirectory hints from ${directory}: ${found.map((h) => h[0]).join(", ")}`);
    return sections.join("\n\n");
  }
}
