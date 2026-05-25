/**
 * MockProvider — fake LLM provider for downstream tests.
 *
 * Captures the shape that agent-layer code expects from an OpenAI-compatible
 * chat-completion provider: `complete(request)` returns a full response, and
 * `stream(request)` yields chunks. Tests pre-queue responses or errors and
 * the mock pops them in FIFO order. Every captured request is retained for
 * `assertRequestMatches`.
 *
 * Shape rationale: upstream `providers/base.py` declares ProviderProfile as
 * a DECLARATIVE config object — auth, endpoints, quirks. The transport
 * (agent layer) issues the actual HTTP calls. So `MockProvider` is NOT a
 * fake ProviderProfile; it is a fake transport target. Downstream tests
 * inject it in place of the openai client.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: string;
  name?: string;
  // tool/tool_use fields are passed through opaquely.
  [key: string]: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length" | "tool_calls";
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Streamed chunk — narrow shape used in tests; aligned with OpenAI streaming. */
export interface ChatStreamChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: "stop" | "length" | "tool_calls" | null;
  }>;
}

type QueueEntry =
  | { kind: "response"; response: ChatResponse }
  | { kind: "stream"; chunks: ChatStreamChunk[] }
  | { kind: "error"; error: Error };

export type RequestMatcher = Partial<ChatRequest> | ((req: ChatRequest) => boolean);

export class MockProvider {
  readonly requests: ChatRequest[] = [];
  private queue: QueueEntry[] = [];
  private nextId = 0;

  /** Queue a full (non-streamed) response. Accepts either a full ChatResponse or just an assistant content string. */
  queueResponse(response: ChatResponse | string): void {
    const full =
      typeof response === "string" ? this.simpleResponse(response) : response;
    this.queue.push({ kind: "response", response: full });
  }

  /** Queue a streamed response composed of *chunks*. Accepts content-only string deltas as shorthand. */
  queueStream(chunks: ChatStreamChunk[] | string[]): void {
    const built: ChatStreamChunk[] = chunks.map((c, i) =>
      typeof c === "string" ? this.deltaChunk(c, i === chunks.length - 1) : c,
    );
    this.queue.push({ kind: "stream", chunks: built });
  }

  /** Queue an error to be thrown on the next call. */
  queueError(error: Error): void {
    this.queue.push({ kind: "error", error });
  }

  /** Issue a non-streaming completion. Consumes the next queued entry. */
  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(cloneRequest(request));
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `MockProvider.complete: queue empty (request #${this.requests.length})`,
      );
    }
    if (next.kind === "error") throw next.error;
    if (next.kind === "stream") {
      throw new Error(
        `MockProvider.complete: next queued entry is a stream; use stream() instead`,
      );
    }
    return next.response;
  }

  /** Issue a streaming completion. Consumes the next queued entry. */
  async *stream(request: ChatRequest): AsyncIterableIterator<ChatStreamChunk> {
    this.requests.push(cloneRequest(request));
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `MockProvider.stream: queue empty (request #${this.requests.length})`,
      );
    }
    if (next.kind === "error") throw next.error;
    if (next.kind === "response") {
      throw new Error(
        `MockProvider.stream: next queued entry is a non-streamed response; use complete() instead`,
      );
    }
    for (const chunk of next.chunks) {
      yield chunk;
    }
  }

  /** Clear queued responses and captured requests. */
  reset(): void {
    this.queue.length = 0;
    this.requests.length = 0;
    this.nextId = 0;
  }

  /** Return the most recent captured request, or null when none. */
  lastRequest(): ChatRequest | null {
    return this.requests[this.requests.length - 1] ?? null;
  }

  /**
   * Assert at least one captured request matches *matcher*.
   *   - Object matcher: every key in the matcher must be deeply equal in the request.
   *   - Function matcher: must return true for at least one request.
   */
  assertRequestMatches(matcher: RequestMatcher): ChatRequest {
    const test =
      typeof matcher === "function"
        ? matcher
        : (req: ChatRequest) => matchesPartial(req, matcher);
    const hit = this.requests.find(test);
    if (!hit) {
      throw new Error(
        `MockProvider.assertRequestMatches: no request matched.\n` +
          `Captured (${this.requests.length}):\n` +
          this.requests
            .map((r, i) => `  [${i}] model=${r.model} msgs=${r.messages.length}`)
            .join("\n"),
      );
    }
    return hit;
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private simpleResponse(content: string): ChatResponse {
    const id = `mock-resp-${this.nextId++}`;
    return {
      id,
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: content.length,
        total_tokens: content.length,
      },
    };
  }

  private deltaChunk(content: string, isLast: boolean): ChatStreamChunk {
    const id = `mock-chunk-${this.nextId++}`;
    return {
      id,
      model: "mock-model",
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: isLast ? "stop" : null,
        },
      ],
    };
  }
}

function cloneRequest(req: ChatRequest): ChatRequest {
  // Shallow-clone messages and request envelope so test code that mutates
  // its outgoing request can't retroactively alter our capture.
  return {
    ...req,
    messages: req.messages.map((m) => ({ ...m })),
  };
}

function matchesPartial(value: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) {
    return value === expected;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(value) || value.length !== expected.length) return false;
    return expected.every((e, i) => matchesPartial(value[i], e));
  }
  if (typeof expected === "object") {
    if (typeof value !== "object" || value === null) return false;
    const rec = value as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
      matchesPartial(rec[k], v),
    );
  }
  return value === expected;
}
