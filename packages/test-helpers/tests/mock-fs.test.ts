import { describe, it, expect } from "vitest";
import { MockFs } from "../src/mock-fs.js";

interface FsErrorLike extends Error {
  code: string;
}

function codeOf(e: unknown): string {
  return (e as FsErrorLike).code;
}

describe("MockFs", () => {
  describe("seedFile/readFile/exists/reset", () => {
    it("seeds a file with string content and reads it back", async () => {
      const fs = new MockFs();
      fs.seedFile("/a/b/c.txt", "hello");
      expect(fs.exists("/a/b/c.txt")).toBe(true);
      expect(fs.exists("/a/b")).toBe(true);
      expect(fs.exists("/a")).toBe(true);

      const buf = await fs.readFile("/a/b/c.txt");
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect((buf as Buffer).toString("utf-8")).toBe("hello");
    });

    it("seeds a file with Buffer content", async () => {
      const fs = new MockFs();
      fs.seedFile("/bin", Buffer.from([1, 2, 3]));
      const buf = (await fs.readFile("/bin")) as Buffer;
      expect([...buf]).toEqual([1, 2, 3]);
    });

    it("reads with an encoding argument", async () => {
      const fs = new MockFs();
      fs.seedFile("/x", "héllo");
      const text = await fs.readFile("/x", "utf-8");
      expect(text).toBe("héllo");
    });

    it("normalises trailing slash, leading slash, and '.' segments", () => {
      const fs = new MockFs();
      fs.seedFile("/foo/bar.txt", "x");
      expect(fs.exists("/foo/bar.txt")).toBe(true);
      expect(fs.exists("foo/bar.txt")).toBe(true);
      expect(fs.exists("/foo/./bar.txt")).toBe(true);
      expect(fs.exists("/foo/bar.txt/")).toBe(true);
    });

    it("rejects empty path", () => {
      const fs = new MockFs();
      expect(() => fs.seedFile("", "x")).toThrow(/invalid empty path/);
    });

    it("reset wipes everything except root", async () => {
      const fs = new MockFs();
      fs.seedFile("/a/b", "x");
      fs.reset();
      expect(fs.exists("/a/b")).toBe(false);
      expect(fs.exists("/a")).toBe(false);
      expect(fs.exists("/")).toBe(true);
    });

    it("listFiles returns sorted file paths", () => {
      const fs = new MockFs();
      fs.seedFile("/z", "1");
      fs.seedFile("/a/b", "2");
      fs.seedFile("/a/a", "3");
      expect(fs.listFiles()).toEqual(["/a/a", "/a/b", "/z"]);
    });
  });

  describe("promises.readFile / writeFile", () => {
    it("writeFile creates parent dirs and overwrites existing content", async () => {
      const fs = new MockFs();
      await fs.promises.writeFile("/dir/new.txt", "first");
      await fs.promises.writeFile("/dir/new.txt", "second");
      const text = await fs.promises.readFile("/dir/new.txt", "utf-8");
      expect(text).toBe("second");
    });

    it("readFile on a missing path throws ENOENT", async () => {
      const fs = new MockFs();
      await expect(fs.promises.readFile("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("readFile on a directory throws EISDIR", async () => {
      const fs = new MockFs();
      fs.seedFile("/d/x", "1");
      const err = await fs.promises.readFile("/d").catch((e) => e);
      expect(codeOf(err)).toBe("EISDIR");
    });
  });

  describe("promises.mkdir", () => {
    it("creates a single directory under an existing parent", async () => {
      const fs = new MockFs();
      await fs.promises.mkdir("/d");
      expect(fs.exists("/d")).toBe(true);
    });

    it("throws ENOENT when parent does not exist and recursive is false", async () => {
      const fs = new MockFs();
      const err = await fs.promises.mkdir("/a/b/c").catch((e) => e);
      expect(codeOf(err)).toBe("ENOENT");
    });

    it("recursive: true creates the whole chain", async () => {
      const fs = new MockFs();
      await fs.promises.mkdir("/a/b/c", { recursive: true });
      expect(fs.exists("/a")).toBe(true);
      expect(fs.exists("/a/b")).toBe(true);
      expect(fs.exists("/a/b/c")).toBe(true);
    });

    it("recursive: true is a no-op when the directory already exists", async () => {
      const fs = new MockFs();
      await fs.promises.mkdir("/a", { recursive: true });
      await fs.promises.mkdir("/a", { recursive: true });
      expect(fs.exists("/a")).toBe(true);
    });

    it("non-recursive on an existing directory throws EEXIST", async () => {
      const fs = new MockFs();
      await fs.promises.mkdir("/a");
      const err = await fs.promises.mkdir("/a").catch((e) => e);
      expect(codeOf(err)).toBe("EEXIST");
      expect((err as Error).message).toMatch(/directory already exists/);
    });

    it("mkdir on a path that's already a file throws EEXIST", async () => {
      const fs = new MockFs();
      fs.seedFile("/x", "1");
      const err = await fs.promises.mkdir("/x").catch((e) => e);
      expect(codeOf(err)).toBe("EEXIST");
      expect((err as Error).message).toMatch(/file already exists/);
    });

    it("parent that is a file throws ENOTDIR (non-recursive)", async () => {
      const fs = new MockFs();
      fs.seedFile("/file", "1");
      const err = await fs.promises.mkdir("/file/sub").catch((e) => e);
      expect(codeOf(err)).toBe("ENOTDIR");
    });

    it("seedFile on a path whose parent is a file throws ENOTDIR", () => {
      const fs = new MockFs();
      fs.seedFile("/file", "1");
      expect(() => fs.seedFile("/file/under", "x")).toThrow(/ENOTDIR/);
    });
  });

  describe("promises.stat / access", () => {
    it("stat reports file/dir/size correctly", async () => {
      const fs = new MockFs();
      fs.seedFile("/f", "abcd");
      const s = await fs.promises.stat("/f");
      expect(s.isFile()).toBe(true);
      expect(s.isDirectory()).toBe(false);
      expect(s.size).toBe(4);

      const ds = await fs.promises.stat("/");
      expect(ds.isFile()).toBe(false);
      expect(ds.isDirectory()).toBe(true);
      expect(ds.size).toBe(0);
    });

    it("stat throws ENOENT for missing paths", async () => {
      const fs = new MockFs();
      const err = await fs.promises.stat("/missing").catch((e) => e);
      expect(codeOf(err)).toBe("ENOENT");
    });

    it("access resolves for existing and throws for missing", async () => {
      const fs = new MockFs();
      fs.seedFile("/p", "1");
      await expect(fs.promises.access("/p")).resolves.toBeUndefined();
      const err = await fs.promises.access("/q").catch((e) => e);
      expect(codeOf(err)).toBe("ENOENT");
    });
  });

  describe("promises.readdir", () => {
    it("lists immediate children only, sorted", async () => {
      const fs = new MockFs();
      fs.seedFile("/d/b.txt", "1");
      fs.seedFile("/d/a.txt", "2");
      fs.seedFile("/d/sub/deep.txt", "3");
      const entries = await fs.promises.readdir("/d");
      expect(entries).toEqual(["a.txt", "b.txt", "sub"]);
    });

    it("lists the root directory", async () => {
      const fs = new MockFs();
      fs.seedFile("/x", "1");
      fs.seedFile("/y", "2");
      const entries = await fs.promises.readdir("/");
      expect(entries).toEqual(["x", "y"]);
    });

    it("throws ENOENT for missing dir", async () => {
      const fs = new MockFs();
      const err = await fs.promises.readdir("/missing").catch((e) => e);
      expect(codeOf(err)).toBe("ENOENT");
    });

    it("throws ENOTDIR when target is a file", async () => {
      const fs = new MockFs();
      fs.seedFile("/file", "1");
      const err = await fs.promises.readdir("/file").catch((e) => e);
      expect(codeOf(err)).toBe("ENOTDIR");
    });
  });

  describe("promises.unlink", () => {
    it("removes a file", async () => {
      const fs = new MockFs();
      fs.seedFile("/f", "1");
      await fs.promises.unlink("/f");
      expect(fs.exists("/f")).toBe(false);
    });

    it("throws ENOENT for missing", async () => {
      const fs = new MockFs();
      const err = await fs.promises.unlink("/missing").catch((e) => e);
      expect(codeOf(err)).toBe("ENOENT");
    });

    it("throws EISDIR on a directory", async () => {
      const fs = new MockFs();
      fs.seedFile("/d/x", "1");
      const err = await fs.promises.unlink("/d").catch((e) => e);
      expect(codeOf(err)).toBe("EISDIR");
    });
  });

  describe("promises.rm", () => {
    it("removes a file", async () => {
      const fs = new MockFs();
      fs.seedFile("/f", "1");
      await fs.promises.rm("/f");
      expect(fs.exists("/f")).toBe(false);
    });

    it("recursive removes a directory tree", async () => {
      const fs = new MockFs();
      fs.seedFile("/d/a", "1");
      fs.seedFile("/d/sub/b", "2");
      await fs.promises.rm("/d", { recursive: true });
      expect(fs.exists("/d")).toBe(false);
      expect(fs.exists("/d/a")).toBe(false);
      expect(fs.exists("/d/sub/b")).toBe(false);
    });

    it("non-recursive on a directory throws EISDIR", async () => {
      const fs = new MockFs();
      await fs.promises.mkdir("/d");
      const err = await fs.promises.rm("/d").catch((e) => e);
      expect(codeOf(err)).toBe("EISDIR");
    });

    it("recursive on root preserves the root node", async () => {
      const fs = new MockFs();
      fs.seedFile("/x", "1");
      await fs.promises.rm("/", { recursive: true });
      expect(fs.exists("/")).toBe(true);
      expect(fs.exists("/x")).toBe(false);
    });

    it("force: true on missing is a no-op", async () => {
      const fs = new MockFs();
      await expect(fs.promises.rm("/missing", { force: true })).resolves.toBeUndefined();
    });

    it("missing without force throws ENOENT", async () => {
      const fs = new MockFs();
      const err = await fs.promises.rm("/missing").catch((e) => e);
      expect(codeOf(err)).toBe("ENOENT");
    });
  });

  describe("promises.rename", () => {
    it("renames a file", async () => {
      const fs = new MockFs();
      fs.seedFile("/a", "hi");
      await fs.promises.rename("/a", "/b");
      expect(fs.exists("/a")).toBe(false);
      expect(await fs.promises.readFile("/b", "utf-8")).toBe("hi");
    });

    it("renames a file across directories (creating parents)", async () => {
      const fs = new MockFs();
      fs.seedFile("/a", "x");
      await fs.promises.rename("/a", "/new/dir/b");
      expect(await fs.promises.readFile("/new/dir/b", "utf-8")).toBe("x");
      expect(fs.exists("/new/dir")).toBe(true);
    });

    it("renames a directory tree", async () => {
      const fs = new MockFs();
      fs.seedFile("/src/one.txt", "1");
      fs.seedFile("/src/sub/two.txt", "2");
      await fs.promises.rename("/src", "/dst");
      expect(fs.exists("/src")).toBe(false);
      expect(fs.exists("/dst")).toBe(true);
      expect(await fs.promises.readFile("/dst/one.txt", "utf-8")).toBe("1");
      expect(await fs.promises.readFile("/dst/sub/two.txt", "utf-8")).toBe("2");
    });

    it("renames a directory that contains only the dir node itself", async () => {
      const fs = new MockFs();
      await fs.promises.mkdir("/empty");
      await fs.promises.rename("/empty", "/moved");
      expect(fs.exists("/empty")).toBe(false);
      expect(fs.exists("/moved")).toBe(true);
    });

    it("missing source throws ENOENT", async () => {
      const fs = new MockFs();
      const err = await fs.promises.rename("/missing", "/x").catch((e) => e);
      expect(codeOf(err)).toBe("ENOENT");
    });

    it("renaming root throws EBUSY (either side)", async () => {
      const fs = new MockFs();
      fs.seedFile("/a", "1");
      const errSrc = await fs.promises.rename("/", "/x").catch((e) => e);
      expect(codeOf(errSrc)).toBe("EBUSY");
      const errDst = await fs.promises.rename("/a", "/").catch((e) => e);
      expect(codeOf(errDst)).toBe("EBUSY");
    });
  });

  describe("ensureParent edge cases", () => {
    it("seeding the root path is a no-op for parent creation", () => {
      // posix.dirname("/") === "/" — the parent-equals-self branch must
      // not recurse forever or corrupt anything.
      const fs = new MockFs();
      fs.seedFile("/", "root-content");
      expect(fs.exists("/")).toBe(true);
    });
  });
});
