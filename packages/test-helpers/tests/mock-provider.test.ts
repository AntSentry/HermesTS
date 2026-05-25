import { describe, it, expect } from "vitest";
import {
  MockProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
} from "../src/mock-provider.js";

function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "gpt-fake",
    messages: [{ role: "user", content: "ping" }],
    ...overrides,
  };
}

describe("MockProvider", () => {
  describe("complete()", () => {
    it("returns the queued ChatResponse and captures the request", async () => {
      const p = new MockProvider();
      const canned: ChatResponse = {
        id: "x",
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "pong" },
            finish_reason: "stop",
          },
        ],
      };
      p.queueResponse(canned);
      const out = await p.complete(req({ model: "abc" }));
      expect(out).toBe(canned);
      expect(p.requests).toHaveLength(1);
      expect(p.requests[0]!.model).toBe("abc");
      expect(p.lastRequest()!.messages[0]!.content).toBe("ping");
    });

    it("accepts a shorthand string and synthesises a response", async () => {
      const p = new MockProvider();
      p.queueResponse("hi");
      const r = await p.complete(req());
      expect(r.choices[0]!.message.content).toBe("hi");
      expect(r.choices[0]!.finish_reason).toBe("stop");
      expect(r.usage!.completion_tokens).toBe(2);
      expect(r.usage!.total_tokens).toBe(2);
      expect(r.id).toMatch(/^mock-resp-/);
    });

    it("captures requests in FIFO order", async () => {
      const p = new MockProvider();
      p.queueResponse("a");
      p.queueResponse("b");
      const r1 = await p.complete(req({ model: "m1" }));
      const r2 = await p.complete(req({ model: "m2" }));
      expect(r1.choices[0]!.message.content).toBe("a");
      expect(r2.choices[0]!.message.content).toBe("b");
      expect(p.requests.map((r) => r.model)).toEqual(["m1", "m2"]);
    });

    it("clones messages so caller mutation doesn't affect captures", async () => {
      const p = new MockProvider();
      p.queueResponse("x");
      const original = req();
      await p.complete(original);
      original.messages[0]!.content = "MUTATED";
      expect(p.requests[0]!.messages[0]!.content).toBe("ping");
    });

    it("throws when the queue is empty", async () => {
      const p = new MockProvider();
      await expect(p.complete(req())).rejects.toThrow(/queue empty/);
    });

    it("throws the queued error", async () => {
      const p = new MockProvider();
      const boom = new Error("rate limit");
      p.queueError(boom);
      await expect(p.complete(req())).rejects.toBe(boom);
    });

    it("refuses to complete() when next entry is a stream", async () => {
      const p = new MockProvider();
      p.queueStream(["a"]);
      await expect(p.complete(req())).rejects.toThrow(/use stream/);
    });

    it("lastRequest() returns null when no requests captured", () => {
      const p = new MockProvider();
      expect(p.lastRequest()).toBeNull();
    });
  });

  describe("stream()", () => {
    it("yields the queued chunks in order", async () => {
      const p = new MockProvider();
      const chunks: ChatStreamChunk[] = [
        {
          id: "c1",
          model: "m",
          choices: [{ index: 0, delta: { content: "hel" }, finish_reason: null }],
        },
        {
          id: "c2",
          model: "m",
          choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
        },
      ];
      p.queueStream(chunks);
      const out: ChatStreamChunk[] = [];
      for await (const c of p.stream(req())) out.push(c);
      expect(out).toEqual(chunks);
      expect(p.requests).toHaveLength(1);
    });

    it("accepts string shorthand and marks the last chunk as stop", async () => {
      const p = new MockProvider();
      p.queueStream(["one", "two", "three"]);
      const out: ChatStreamChunk[] = [];
      for await (const c of p.stream(req())) out.push(c);
      expect(out).toHaveLength(3);
      expect(out[0]!.choices[0]!.delta.content).toBe("one");
      expect(out[0]!.choices[0]!.finish_reason).toBeNull();
      expect(out[2]!.choices[0]!.delta.content).toBe("three");
      expect(out[2]!.choices[0]!.finish_reason).toBe("stop");
      expect(out[0]!.id).toMatch(/^mock-chunk-/);
    });

    it("throws when the queue is empty", async () => {
      const p = new MockProvider();
      const it = p.stream(req());
      await expect(it.next()).rejects.toThrow(/queue empty/);
    });

    it("throws the queued error before yielding", async () => {
      const p = new MockProvider();
      const boom = new Error("net");
      p.queueError(boom);
      const it = p.stream(req());
      await expect(it.next()).rejects.toBe(boom);
    });

    it("refuses to stream() when next entry is a non-stream response", async () => {
      const p = new MockProvider();
      p.queueResponse("x");
      const it = p.stream(req());
      await expect(it.next()).rejects.toThrow(/use complete/);
    });
  });

  describe("reset()", () => {
    it("clears the queue, captures, and id counter", async () => {
      const p = new MockProvider();
      p.queueResponse("a");
      await p.complete(req());
      p.reset();
      expect(p.requests).toEqual([]);
      expect(p.lastRequest()).toBeNull();
      p.queueResponse("hi");
      const r = await p.complete(req());
      expect(r.id).toBe("mock-resp-0");
    });
  });

  describe("assertRequestMatches", () => {
    it("matches by partial object on top-level fields", async () => {
      const p = new MockProvider();
      p.queueResponse("a");
      p.queueResponse("b");
      await p.complete(req({ model: "alpha" }));
      await p.complete(req({ model: "beta" }));
      const hit = p.assertRequestMatches({ model: "beta" });
      expect(hit.model).toBe("beta");
    });

    it("matches by nested object on messages", async () => {
      const p = new MockProvider();
      p.queueResponse("x");
      await p.complete(req({ messages: [{ role: "user", content: "find me" }] }));
      const hit = p.assertRequestMatches({
        messages: [{ role: "user", content: "find me" }],
      });
      expect(hit.messages[0]!.content).toBe("find me");
    });

    it("matches by predicate function", async () => {
      const p = new MockProvider();
      p.queueResponse("a");
      await p.complete(req({ temperature: 0.7 }));
      const hit = p.assertRequestMatches((r) => r.temperature === 0.7);
      expect(hit.temperature).toBe(0.7);
    });

    it("matches null/undefined exactly via predicate", async () => {
      // The matchesPartial branch for null/undefined is exercised when the
      // matcher object contains an explicit null. Use a custom-shape extra
      // field (allowed by the [key: string]: unknown index signature).
      const p = new MockProvider();
      p.queueResponse("a");
      const reqWithExtras: import("../src/mock-provider.js").ChatRequest = {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        extra: null,
      };
      await p.complete(reqWithExtras);
      const hit = p.assertRequestMatches({ extra: null } as Partial<
        import("../src/mock-provider.js").ChatRequest
      >);
      expect(hit.model).toBe("m");
    });

    it("partial array matcher rejects on different length", async () => {
      const p = new MockProvider();
      p.queueResponse("a");
      await p.complete(req({ messages: [{ role: "user", content: "one" }] }));
      expect(() =>
        p.assertRequestMatches({
          messages: [
            { role: "user", content: "one" },
            { role: "user", content: "two" },
          ],
        }),
      ).toThrow(/no request matched/);
    });

    it("primitive mismatch in nested object fails", async () => {
      const p = new MockProvider();
      p.queueResponse("a");
      await p.complete(req({ messages: [{ role: "user", content: "ping" }] }));
      expect(() =>
        p.assertRequestMatches({ messages: [{ role: "user", content: "pong" }] }),
      ).toThrow(/no request matched/);
    });

    it("object matcher rejects when value isn't an object", async () => {
      const p = new MockProvider();
      p.queueResponse("a");
      await p.complete(req({ messages: [{ role: "user", content: "ping" }] }));
      // model is a string but matcher expects it to be an object — must fail.
      expect(() =>
        p.assertRequestMatches({ model: { name: "x" } } as unknown as Partial<ChatRequest>),
      ).toThrow(/no request matched/);
    });

    it("throws with a useful dump when nothing matches", async () => {
      const p = new MockProvider();
      p.queueResponse("a");
      p.queueResponse("b");
      await p.complete(req({ model: "m1" }));
      await p.complete(req({ model: "m2" }));
      try {
        p.assertRequestMatches({ model: "m3" });
        throw new Error("expected throw");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("model=m1");
        expect(msg).toContain("model=m2");
      }
    });
  });
});
