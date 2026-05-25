import { describe, it, expect } from "vitest";
import { MockSubprocess } from "../src/mock-subprocess.js";

describe("MockSubprocess", () => {
  describe("run() with stubs", () => {
    it("returns the exact stubbed result for a string command match", async () => {
      const sub = new MockSubprocess();
      sub.stub("git", { stdout: "main", exitCode: 0 });
      const r = await sub.run("git", ["branch", "--show-current"]);
      expect(r).toEqual({ stdout: "main", stderr: "", exitCode: 0 });
    });

    it("returns the stubbed result for a RegExp match against command+args", async () => {
      const sub = new MockSubprocess();
      sub.stub(/^ffmpeg .*-i input\.mp4/, { stdout: "ok" });
      const r = await sub.run("ffmpeg", ["-y", "-i", "input.mp4", "-o", "out.mp4"]);
      expect(r.stdout).toBe("ok");
      expect(r.exitCode).toBe(0);
    });

    it("function stub is invoked per call (allows generated outputs)", async () => {
      const sub = new MockSubprocess();
      let n = 0;
      sub.stub("echo", () => ({ stdout: `n=${++n}` }));
      const a = await sub.run("echo", ["a"]);
      const b = await sub.run("echo", ["b"]);
      expect(a.stdout).toBe("n=1");
      expect(b.stdout).toBe("n=2");
    });

    it("partial stub result fills missing fields with defaults", async () => {
      const sub = new MockSubprocess();
      sub.stub("git", {});
      const r = await sub.run("git");
      expect(r).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    });

    it("falls through to setDefault when no stub matches", async () => {
      const sub = new MockSubprocess();
      sub.setDefault({ stdout: "default", exitCode: 3 });
      const r = await sub.run("unknown", ["arg"]);
      expect(r).toEqual({ stdout: "default", stderr: "", exitCode: 3 });
    });

    it("setDefault with no fields uses zeros/empties", async () => {
      const sub = new MockSubprocess();
      sub.setDefault({});
      const r = await sub.run("anything");
      expect(r).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    });

    it("throws when no stub matches and no default is set", async () => {
      const sub = new MockSubprocess();
      await expect(sub.run("nope", ["arg"])).rejects.toThrow(/no stub matched 'nope arg'/);
      await expect(sub.run("alone")).rejects.toThrow(/no stub matched 'alone'/);
    });

    it("uses the first matching stub when multiple match", async () => {
      const sub = new MockSubprocess();
      sub.stub(/^git/, { stdout: "first" });
      sub.stub("git", { stdout: "second" });
      const r = await sub.run("git", ["status"]);
      expect(r.stdout).toBe("first");
    });
  });

  describe("call capture", () => {
    it("records command, args (defensively copied), and options", async () => {
      const sub = new MockSubprocess();
      sub.setDefault({});
      const args = ["a", "b"];
      const opts = { cwd: "/tmp", env: { K: "v" } };
      await sub.run("cmd", args, opts);
      const c = sub.calls[0]!;
      expect(c.command).toBe("cmd");
      expect(c.args).toEqual(["a", "b"]);
      expect(c.args).not.toBe(args);
      expect(c.options).toEqual(opts);
      expect(c.options).not.toBe(opts);
      expect(c.timestamp).toBeInstanceOf(Date);
    });

    it("defaults args to [] and options to {}", async () => {
      const sub = new MockSubprocess();
      sub.setDefault({});
      await sub.run("cmd");
      expect(sub.calls[0]!.args).toEqual([]);
      expect(sub.calls[0]!.options).toEqual({});
    });
  });

  describe("reset()", () => {
    it("clears stubs, calls, and the default", async () => {
      const sub = new MockSubprocess();
      sub.stub("a", { stdout: "x" });
      sub.setDefault({ stdout: "d" });
      await sub.run("a");
      sub.reset();
      expect(sub.calls).toEqual([]);
      await expect(sub.run("a")).rejects.toThrow(/no stub matched/);
    });
  });

  describe("assertSpawned", () => {
    it("matches by command name (string)", async () => {
      const sub = new MockSubprocess();
      sub.setDefault({});
      await sub.run("git", ["status"]);
      const hit = sub.assertSpawned("git");
      expect(hit.command).toBe("git");
    });

    it("matches by RegExp over command + args", async () => {
      const sub = new MockSubprocess();
      sub.setDefault({});
      await sub.run("git", ["push", "origin", "main"]);
      const hit = sub.assertSpawned(/origin main/);
      expect(hit.args).toContain("origin");
    });

    it("matches by predicate", async () => {
      const sub = new MockSubprocess();
      sub.setDefault({});
      await sub.run("ffmpeg", [], { cwd: "/work" });
      const hit = sub.assertSpawned((c) => c.options.cwd === "/work");
      expect(hit.command).toBe("ffmpeg");
    });

    it("RegExp matches command alone when there are no args", async () => {
      const sub = new MockSubprocess();
      sub.setDefault({});
      await sub.run("solo");
      const hit = sub.assertSpawned(/^solo$/);
      expect(hit.command).toBe("solo");
    });

    it("throws with a dump when nothing matches", async () => {
      const sub = new MockSubprocess();
      sub.setDefault({});
      await sub.run("git", ["status"]);
      await sub.run("ls", ["-l"]);
      try {
        sub.assertSpawned("npm");
        throw new Error("should throw");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("git status");
        expect(msg).toContain("ls -l");
      }
    });

    it("throws with 'no calls captured' when nothing has been spawned", () => {
      const sub = new MockSubprocess();
      expect(() => sub.assertSpawned("anything")).toThrow(/no calls captured/);
    });
  });
});
