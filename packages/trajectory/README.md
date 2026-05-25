# @hermests/trajectory

Faithful TypeScript port of `trajectory_compressor.py` — post-processes
completed agent trajectories to compress them within a target token budget
while preserving training signal quality.

## Compression strategy

1. Protect first turns (system, human, first gpt, first tool).
2. Protect last N turns (final actions and conclusions).
3. Compress MIDDLE turns only, starting from the 2nd tool response.
4. Compress only as much as needed to fit under the target.
5. Replace the compressed region with a single human summary message.
6. Keep remaining tool calls intact (model continues working after summary).

## Modules

| Upstream `.py` (single file) | TS file | Surface |
|---|---|---|
| `trajectory_compressor.py` lines 82-179 | `src/compression-config.ts` | `CompressionConfig`, `CompressionConfig.fromYaml`, `CompressionConfigInit` |
| `trajectory_compressor.py` lines 182-329 | `src/metrics.ts` | `TrajectoryMetrics`, `AggregateMetrics`, `TrajectoryMetricsDict`, `AggregateMetricsDict` |
| `trajectory_compressor.py` lines 435-462 | `src/provider-detection.ts` | `detectProvider` |
| `agent/retry_utils.py` (jittered_backoff) | `src/backoff.ts` | `jitteredBackoff`, `defaultSleep`, `_resetJitterCounter` |
| `trajectory_compressor.py` lines 332-973 | `src/trajectory-compressor.ts` | `TrajectoryCompressor`, `CompressionResult`, `ProcessEntryResult`, `TrajectoryCompressorOptions` |
| `trajectory_compressor.py` lines 975-1180 + `main()` | `src/directory-processor.ts` | `processDirectory`, `runCli`, `ProcessDirectoryOptions`, `RunCliOptions`, `RunCliResult`, `withTimeout`, `TimeoutError`, `ProgressEvent`, `StartEvent`, `DoneEvent`, `ErrorEvent`, `DirectoryProcessorEvent`, `ProgressReporter` |
| `trajectory_compressor.py` lines 1181-1287 (`_print_summary`) | `src/report.ts` | `formatCompressionReport`, `printCompressionReport` |
| n/a (TS surface types) | `src/types.ts` | `Turn`, `Entry`, `Tokenizer`, `OMIT_TEMPERATURE`, `OmitTemperature`, `EffectiveTemperature`, `TemperatureResolver`, `ChatMessage`, `ChatCompletionResponse`, `SyncLlmClient`, `AsyncLlmClient`, `LlmClientPair`, `BackoffFn`, `SleepFn`, `Logger` |

## Faithful divergences

This package is a faithful port — function names, semantics, and edge-case
behaviour match upstream. Where Python has no direct Node equivalent, the
divergence is below; the upstream `file:line` reference makes it easy to audit.

| Upstream construct | TS port | Reason |
|---|---|---|
| `transformers.AutoTokenizer.from_pretrained(...)` (`trajectory_compressor.py` L362-372) | `tokenizer` injected via `TrajectoryCompressorOptions.tokenizer` | No bundled JS HF tokenizer; the trajectory package stays runtime-agnostic. Callers wrap `tiktoken`/`tokenizers`/remote service into the `Tokenizer` interface (`encode(text) -> number[] \| {length: number}`). |
| `openai.OpenAI` + `openai.AsyncOpenAI` (`trajectory_compressor.py` L405-433) | `LlmClientPair` injected via `TrajectoryCompressorOptions.llmClient` | The concrete OpenAI/router bindings live in `@hermests/agent` (still pending). Trajectory consumes only the `SyncLlmClient` / `AsyncLlmClient` interface — `createChatCompletion({model, messages, temperature, maxTokens})`. |
| `agent.auxiliary_client.call_llm` / `async_call_llm` provider routing (`trajectory_compressor.py` L382-396, L608-616, L677-685) | Folded into the injected `LlmClientPair`. The compressor still exposes `llmProvider` and `useCallLlm` so the injected client can branch the same way upstream does. | Same cross-package reason — keeps trajectory free of agent deps. |
| `agent.auxiliary_client._fixed_temperature_for_model` (`trajectory_compressor.py` L59-79) | `temperatureResolver` injected via `TrajectoryCompressorOptions.temperatureResolver`; default returns the requested temperature unchanged | Matches the upstream `except ImportError: return requested_temperature` branch verbatim. |
| `OMIT_TEMPERATURE` sentinel (Python `object()`) | Exported `OMIT_TEMPERATURE: unique symbol` plus the convention that `EffectiveTemperature === null` means "omit the field" | TS doesn't have `is`-identity for arbitrary objects across package boundaries, so the convention is encoded in the type alias. |
| `agent.retry_utils.jittered_backoff` (`agent/retry_utils.py`) | Duplicated locally in `src/backoff.ts` | Importing from `@hermests/agent` would create a cyclic dep. The agent porter (task #5) can re-export from there or hoist to `@hermests/core`. |
| `time.sleep(seconds)` (sync) (`trajectory_compressor.py` L635) | `syncSleep` injection; default uses `Atomics.wait` on a `SharedArrayBuffer` | Node has no blocking sleep primitive; `Atomics.wait` blocks without burning CPU. Production callers should prefer the async path. |
| `asyncio.sleep(seconds)` (`trajectory_compressor.py` L704) | `sleep` injection; default is `setTimeout`-backed | Standard JS async sleep. |
| `asyncio.run(...)` + per-call event loop binding for `AsyncOpenAI` (`trajectory_compressor.py` L419-433) | Not needed — Node's event loop is process-wide, so the upstream lazy-create-per-loop concern doesn't apply. The async client is whatever the caller injected. | Architectural difference between Python's per-`asyncio.run` loop semantics and Node's single global loop. The upstream `_get_async_client()` method has no TS analogue; consumers of `LlmClientPair.async` get the same instance every time. |
| `random.sample(seed=42)` (`trajectory_compressor.py` L1392, L1473) | `seededSample` (Fisher-Yates with mulberry32 PRNG) | Deterministic seeded sampling without bundling Python's CPython-specific RNG semantics. |
| `tempfile.TemporaryDirectory()` (`trajectory_compressor.py` L1404, L1451) | `fs.mkdtempSync(tmpdir())` + `fs.rmSync({recursive: true, force: true})` in a `try/finally` | Node has no exact context-manager equivalent; the `try/finally` matches the cleanup-on-exception semantics. |
| `rich.progress.Progress` + console-rendered progress bar (`trajectory_compressor.py` L1112-1146) | `onProgress?: ProgressReporter` callback — events `start`, `progress`, `error`, `done` | Trajectory package stays UI-agnostic. The CLI binding (`@hermests/cli` task #14) wires this to an interactive progress library. |
| `logging.basicConfig` + module logger inside `__init__` (`trajectory_compressor.py` L355-360) | `logger` injection via `TrajectoryCompressorOptions.logger`; default is no-op | Trajectory doesn't touch global logger config — that's `@hermests/core/logging`'s job; we accept a `Logger` interface instead. |
| `fire.Fire(main)` (`trajectory_compressor.py` L1508) | `runCli(options)` — accepts a typed `RunCliOptions` object | The Fire-based CLI surface is wired up in `@hermests/cli` (task #14). |
| `print(...)` console output in `_print_summary` (`trajectory_compressor.py` L1202-1287) | `formatCompressionReport` returns lines; `printCompressionReport` prints them | Lets callers route the report to any sink (CLI, log file, tests). |

## Deferred tests

The upstream `test_trajectory_compressor.py::test_import_loads_env_from_hermes_home`
case depends on `hermes_cli.env_loader.load_hermes_dotenv` being called at
module-import time. The TS port moves env loading out of the trajectory package
entirely (it's a CLI concern, not a library concern); that test is deferred
to `@hermests/cli` (task #14). See `docs/deferred-tests.md` for the full list.

## Usage

```ts
import {
  CompressionConfig,
  TrajectoryCompressor,
  processDirectory,
} from "@hermests/trajectory";

const config = new CompressionConfig({ targetMaxTokens: 16000 });
const compressor = new TrajectoryCompressor(config, {
  tokenizer: myTokenizer,            // your Tokenizer impl
  llmClient: { sync: ..., async: ... }, // your LlmClientPair impl
});

await processDirectory(compressor, "./input", "./output", {
  onProgress: (event) => console.log(event),
});
```
