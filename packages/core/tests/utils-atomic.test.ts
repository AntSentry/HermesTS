// Ported from tests/test_atomic_replace_symlinks.py

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  atomicJsonWrite,
  atomicReplace,
  atomicYamlWrite,
} from "../src/utils.js";

let tmp: string;

beforeEach(() => {
  // realpathSync resolves macOS's /var → /private/var firmlink so the
  // realpath atomicReplace returns matches what we assert against.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "hermests-atomic-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeTmp(dir: string, content: string): string {
  const p = join(dir, ".src.tmp");
  writeFileSync(p, content, "utf-8");
  return p;
}

describe("atomicReplace — direct helper", () => {
  test("preserves symlink", () => {
    const real = join(tmp, "real.yaml");
    const link = join(tmp, "link.yaml");
    writeFileSync(real, "original\n", "utf-8");
    symlinkSync(real, link);

    const src = writeTmp(tmp, "updated\n");
    const returned = atomicReplace(src, link);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf-8")).toBe("updated\n");
    expect(returned).toBe(real);
    // Following the symlink yields the new content.
    expect(readFileSync(link, "utf-8")).toBe("updated\n");
  });

  test("regular file", () => {
    const target = join(tmp, "plain.yaml");
    writeFileSync(target, "old\n", "utf-8");

    const src = writeTmp(tmp, "fresh\n");
    const returned = atomicReplace(src, target);

    expect(returned).toBe(target);
    expect(readFileSync(target, "utf-8")).toBe("fresh\n");
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
  });

  test("first-time create (target missing)", () => {
    const target = join(tmp, "new.yaml");
    expect(existsSync(target)).toBe(false);

    const src = writeTmp(tmp, "brand new\n");
    const returned = atomicReplace(src, target);

    expect(returned).toBe(target);
    expect(readFileSync(target, "utf-8")).toBe("brand new\n");
  });

  test("accepts string path inputs", () => {
    const target = join(tmp, "dual.json");
    writeFileSync(target, "{}", "utf-8");

    const src1 = writeTmp(tmp, "1");
    atomicReplace(src1, target);
    expect(readFileSync(target, "utf-8")).toBe("1");

    const src2 = writeTmp(tmp, "2");
    atomicReplace(src2, target);
    expect(readFileSync(target, "utf-8")).toBe("2");
  });
});

describe("atomicJsonWrite / atomicYamlWrite wiring", () => {
  test("atomicJsonWrite preserves symlink", () => {
    const real = join(tmp, "real.json");
    const link = join(tmp, "link.json");
    writeFileSync(real, "{}", "utf-8");
    symlinkSync(real, link);

    atomicJsonWrite(link, { hello: "world" });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const loaded = JSON.parse(readFileSync(real, "utf-8")) as Record<string, unknown>;
    expect(loaded).toEqual({ hello: "world" });
  });

  test("atomicYamlWrite preserves symlink", () => {
    const real = join(tmp, "real.yaml");
    const link = join(tmp, "link.yaml");
    writeFileSync(real, "placeholder: true\n", "utf-8");
    symlinkSync(real, link);

    atomicYamlWrite(link, { model: { provider: "openrouter" } });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(parseYaml(readFileSync(real, "utf-8"))).toEqual({
      model: { provider: "openrouter" },
    });
  });

  test("atomicJsonWrite preserves symlinked target permissions", () => {
    const real = join(tmp, "real.json");
    const link = join(tmp, "link.json");
    writeFileSync(real, "{}", "utf-8");
    chmodSync(real, 0o644);
    symlinkSync(real, link);

    atomicJsonWrite(link, { x: 1 });

    const mode = statSync(real).mode & 0o777;
    expect(mode).toBe(0o644);
  });
});

describe("broken-symlink edge case", () => {
  test("atomicReplace through broken symlink creates the missing target", () => {
    const missing = join(tmp, "does_not_exist_yet.yaml");
    const link = join(tmp, "link.yaml");
    symlinkSync(missing, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(missing)).toBe(false);

    const src = writeTmp(tmp, "created-through-link\n");
    atomicReplace(src, link);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(missing)).toBe(true);
    expect(readFileSync(missing, "utf-8")).toBe("created-through-link\n");
  });

  test("atomicReplace through broken symlink with relative link target", () => {
    // Use a relative link to exercise the dirname()-based path resolution
    // in atomicReplace's broken-symlink fallback.
    const missing = join(tmp, "rel-target.yaml");
    const link = join(tmp, "rel-link.yaml");
    symlinkSync("rel-target.yaml", link);

    const src = writeTmp(tmp, "from-relative-link\n");
    atomicReplace(src, link);

    expect(existsSync(missing)).toBe(true);
    expect(readFileSync(missing, "utf-8")).toBe("from-relative-link\n");
  });
});
