# @hermests/test-helpers

Shared test utilities (mocks and fixtures) for every HermesTS package.

All helpers are framework-agnostic: they don't depend on Vitest, Jest, or any
specific runner. They produce assertion errors that any test framework will
surface as failures.

## Helpers

### `MockLogger`

In-memory fake of the `@hermests/core` `Logger` surface
(`debug`/`info`/`warning`/`error`/`critical`).

```ts
import { MockLogger } from "@hermests/test-helpers";

const log = new MockLogger("svc");
log.info("connection opened", { host: "db1" });

log.assertLogged("info", "db1");           // substring match
log.assertLogged("info", /connection .*/); // RegExp match
log.assertLogged("info", (e) => e.args[0] && (e.args[0] as { host: string }).host === "db1");
log.assertCallCount("info", 1);
log.clear();
```

### `MockClock`

Deterministic clock that satisfies `{ now(): Date }` — drop-in replacement
for code that imports `now` from `@hermests/core/time`.

```ts
import { MockClock } from "@hermests/test-helpers";

const clock = new MockClock(new Date("2024-06-01T00:00:00Z"));
clock.advance(1500);                       // +1.5s, must be >= 0
clock.now();                               // 2024-06-01T00:00:01.500Z
clock.setNow(new Date("2025-01-01Z"));     // jump backward or forward
clock.reset();                             // back to construction-time value
```

### `MockFs`

In-memory filesystem with a `node:fs/promises`-compatible surface.

```ts
import { MockFs } from "@hermests/test-helpers";

const fs = new MockFs();
fs.seedFile("/etc/hermes/config.yaml", "timezone: Asia/Kolkata");

// Pass `fs.promises` anywhere `node:fs/promises` is accepted.
const text = await fs.promises.readFile("/etc/hermes/config.yaml", "utf-8");

await fs.promises.mkdir("/var/log/hermes", { recursive: true });
await fs.promises.writeFile("/var/log/hermes/agent.log", "boot ok");

fs.exists("/etc/hermes/config.yaml");      // true
fs.listFiles();                            // sorted file paths
fs.reset();                                // wipe back to empty root
```

Supported `promises` methods: `readFile`, `writeFile`, `mkdir`, `stat`,
`access`, `readdir`, `unlink`, `rm`, `rename`. Errors carry POSIX-style
`code` fields (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `EBUSY`).

### `MockProvider`

Fake LLM transport target. Tests pre-queue chat responses or errors; the
mock pops them in FIFO order.

```ts
import { MockProvider } from "@hermests/test-helpers";

const provider = new MockProvider();
provider.queueResponse("hi there!");                 // shorthand
provider.queueStream(["hel", "lo ", "world"]);       // streamed chunks
provider.queueError(new Error("rate limit"));

const r = await provider.complete({
  model: "claude-fake",
  messages: [{ role: "user", content: "ping" }],
});

for await (const chunk of provider.stream({ /* ... */ })) {
  // process chunk.choices[0].delta.content
}

provider.assertRequestMatches({ model: "claude-fake" });
provider.lastRequest();
provider.reset();
```

Coupling note: this mock fakes the **transport** (the call site that sends
a chat-completion request and reads the response), not the upstream
`ProviderProfile` config object from `@hermests/providers`. Tests that need
a real ProviderProfile should instantiate one directly — that class has no
behavior that needs mocking.

### `MockSubprocess`

Captures subprocess spawn calls and returns pre-registered stubbed output.

```ts
import { MockSubprocess } from "@hermests/test-helpers";

const sub = new MockSubprocess();
sub.stub("git", { stdout: "main\n" });
sub.stub(/^ffmpeg .*-i input\.mp4/, { stdout: "ok" });
sub.stub("flaky", () => ({ exitCode: Math.random() > 0.5 ? 0 : 1 }));
sub.setDefault({ exitCode: 0 });            // fall-through

const r = await sub.run("git", ["branch", "--show-current"]);

sub.assertSpawned("git");
sub.assertSpawned(/origin main/);
sub.assertSpawned((c) => c.options.cwd === "/work");
```

## Peer dependencies

`@hermests/core` and `@hermests/providers` are declared as optional peer
dependencies for documentation only — the helpers use **structural** types
(`LoggerSurface`, `ClockSurface`) so consumers don't need either package
installed to use `@hermests/test-helpers` standalone.
