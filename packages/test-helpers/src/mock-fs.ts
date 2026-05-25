/**
 * MockFs — in-memory filesystem.
 *
 * Implements the subset of node:fs/promises that the HermesTS port uses:
 *   readFile, writeFile, mkdir, stat, access, readdir, unlink, rm, rename.
 *
 * Test code uses `seedFile(path, data)` / `readFile(path)` / `exists(path)` /
 * `reset()` as ergonomic helpers, and passes `mockFs.promises` into code
 * under test in place of `node:fs/promises`. Zero runtime dependencies.
 *
 * Paths are normalised (collapsed `.`/`..`, trailing slashes stripped) so
 * `/a/b` and `/a/b/` refer to the same node, and `/a/./b` matches `/a/b`.
 */

import { posix } from "node:path";

export type FileData = Buffer | string;

interface FileNode {
  type: "file";
  content: Buffer;
}

interface DirNode {
  type: "dir";
}

type Node = FileNode | DirNode;

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface StatResult {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
}

export class MockFs {
  private nodes = new Map<string, Node>();

  constructor() {
    this.nodes.set("/", { type: "dir" });
  }

  // ── Test-facing ergonomic helpers ─────────────────────────────────────

  /** Seed a file (creates parent directories as needed). */
  seedFile(path: string, data: FileData): void {
    const abs = normalise(path);
    this.ensureParent(abs);
    this.nodes.set(abs, { type: "file", content: toBuffer(data) });
  }

  /** Return true iff the path exists (file or directory). */
  exists(path: string): boolean {
    return this.nodes.has(normalise(path));
  }

  /** Wipe everything except the root. */
  reset(): void {
    this.nodes.clear();
    this.nodes.set("/", { type: "dir" });
  }

  /** Snapshot of all file paths currently present (sorted). */
  listFiles(): string[] {
    const out: string[] = [];
    for (const [p, n] of this.nodes) {
      if (n.type === "file") out.push(p);
    }
    return out.sort();
  }

  // ── node:fs/promises-compatible surface ────────────────────────────────

  /** Promise-style API mirroring node:fs/promises shape. */
  readonly promises = {
    readFile: async (path: string, encoding?: BufferEncoding): Promise<Buffer | string> => {
      const node = this.requireFile(path);
      return encoding ? node.content.toString(encoding) : Buffer.from(node.content);
    },

    writeFile: async (path: string, data: FileData): Promise<void> => {
      const abs = normalise(path);
      this.ensureParent(abs);
      this.nodes.set(abs, { type: "file", content: toBuffer(data) });
    },

    mkdir: async (path: string, options: MkdirOptions = {}): Promise<void> => {
      const abs = normalise(path);
      if (this.nodes.has(abs)) {
        const existing = this.nodes.get(abs) as Node;
        if (existing.type === "file") {
          throw fsError("EEXIST", `EEXIST: file already exists, mkdir '${abs}'`);
        }
        if (!options.recursive) {
          throw fsError("EEXIST", `EEXIST: directory already exists, mkdir '${abs}'`);
        }
        return;
      }
      if (options.recursive) {
        this.ensureDir(abs);
      } else {
        const parent = posix.dirname(abs);
        if (!this.nodes.has(parent)) {
          throw fsError("ENOENT", `ENOENT: no such file or directory, mkdir '${abs}'`);
        }
        if ((this.nodes.get(parent) as Node).type !== "dir") {
          throw fsError("ENOTDIR", `ENOTDIR: not a directory, mkdir '${abs}'`);
        }
        this.nodes.set(abs, { type: "dir" });
      }
    },

    stat: async (path: string): Promise<StatResult> => {
      const node = this.requireNode(path);
      const size = node.type === "file" ? node.content.length : 0;
      return {
        isFile: () => node.type === "file",
        isDirectory: () => node.type === "dir",
        size,
      };
    },

    access: async (path: string): Promise<void> => {
      this.requireNode(path);
    },

    readdir: async (path: string): Promise<string[]> => {
      const abs = normalise(path);
      const node = this.requireNode(abs);
      if (node.type !== "dir") {
        throw fsError("ENOTDIR", `ENOTDIR: not a directory, scandir '${abs}'`);
      }
      const prefix = abs === "/" ? "/" : `${abs}/`;
      const children: string[] = [];
      for (const p of this.nodes.keys()) {
        if (p === abs) continue;
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (!rest.includes("/")) children.push(rest);
      }
      return children.sort();
    },

    unlink: async (path: string): Promise<void> => {
      const abs = normalise(path);
      const node = this.nodes.get(abs);
      if (!node) {
        throw fsError("ENOENT", `ENOENT: no such file or directory, unlink '${abs}'`);
      }
      if (node.type === "dir") {
        throw fsError("EISDIR", `EISDIR: illegal operation on a directory, unlink '${abs}'`);
      }
      this.nodes.delete(abs);
    },

    rm: async (path: string, options: RmOptions = {}): Promise<void> => {
      const abs = normalise(path);
      if (!this.nodes.has(abs)) {
        if (options.force) return;
        throw fsError("ENOENT", `ENOENT: no such file or directory, rm '${abs}'`);
      }
      const node = this.nodes.get(abs) as Node;
      if (node.type === "file") {
        this.nodes.delete(abs);
        return;
      }
      if (!options.recursive) {
        throw fsError("EISDIR", `EISDIR: illegal operation on a directory, rm '${abs}'`);
      }
      const prefix = abs === "/" ? "/" : `${abs}/`;
      for (const p of [...this.nodes.keys()]) {
        if (p === abs || p.startsWith(prefix)) this.nodes.delete(p);
      }
      if (abs === "/") this.nodes.set("/", { type: "dir" });
    },

    rename: async (oldPath: string, newPath: string): Promise<void> => {
      const oldAbs = normalise(oldPath);
      const newAbs = normalise(newPath);
      if (oldAbs === "/" || newAbs === "/") {
        throw fsError("EBUSY", `EBUSY: cannot rename root, rename '${oldAbs}' -> '${newAbs}'`);
      }
      const node = this.nodes.get(oldAbs);
      if (!node) {
        throw fsError("ENOENT", `ENOENT: no such file or directory, rename '${oldAbs}'`);
      }
      this.ensureParent(newAbs);
      if (node.type === "file") {
        this.nodes.delete(oldAbs);
        this.nodes.set(newAbs, node);
        return;
      }
      // directory rename — move the dir and every descendant.
      const prefix = `${oldAbs}/`;
      const moved: Array<[string, Node]> = [];
      for (const [p, n] of this.nodes) {
        if (p === oldAbs) {
          moved.push([newAbs, n]);
          continue;
        }
        if (p.startsWith(prefix)) {
          const tail = p.slice(prefix.length);
          moved.push([`${newAbs}/${tail}`, n]);
        }
      }
      for (const [p] of this.nodes) {
        if (p === oldAbs || p.startsWith(prefix)) this.nodes.delete(p);
      }
      for (const [p, n] of moved) this.nodes.set(p, n);
    },
  };

  // Convenience pass-throughs for test code that imports MockFs directly.
  async readFile(path: string, encoding?: BufferEncoding): Promise<Buffer | string> {
    return this.promises.readFile(path, encoding);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private requireNode(path: string): Node {
    const abs = normalise(path);
    const node = this.nodes.get(abs);
    if (!node) {
      throw fsError("ENOENT", `ENOENT: no such file or directory, '${abs}'`);
    }
    return node;
  }

  private requireFile(path: string): FileNode {
    const node = this.requireNode(path);
    if (node.type !== "file") {
      throw fsError("EISDIR", `EISDIR: illegal operation on a directory, read '${normalise(path)}'`);
    }
    return node;
  }

  private ensureParent(abs: string): void {
    const parent = posix.dirname(abs);
    if (parent === abs) return;
    this.ensureDir(parent);
  }

  private ensureDir(abs: string): void {
    if (abs === "/") return;
    if (this.nodes.has(abs)) {
      const existing = this.nodes.get(abs) as Node;
      if (existing.type === "file") {
        throw fsError("ENOTDIR", `ENOTDIR: not a directory, '${abs}'`);
      }
      return;
    }
    this.ensureDir(posix.dirname(abs));
    this.nodes.set(abs, { type: "dir" });
  }
}

function normalise(input: string): string {
  if (!input) {
    throw fsError("ENOENT", `ENOENT: invalid empty path`);
  }
  const abs = posix.normalize(input.startsWith("/") ? input : `/${input}`);
  // posix.normalize keeps a trailing slash for inputs like '/' and '/foo/';
  // strip everything except the root marker so '/foo' and '/foo/' are equal.
  if (abs.length > 1 && abs.endsWith("/")) return abs.slice(0, -1);
  return abs;
}

function toBuffer(data: FileData): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
}

interface FsError extends Error {
  code: string;
}

function fsError(code: string, message: string): FsError {
  const err = new Error(message) as FsError;
  err.code = code;
  return err;
}
