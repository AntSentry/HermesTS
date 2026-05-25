# Python → TypeScript Dependency Mapping

Canonical reference. Every porter consults this before pulling a new JS dep.

## Mapping principles
- Prefer Node built-ins (fs/promises, crypto, dns, etc.) over third-party JS libs.
- Prefer zero-dep ports of small Python libs over adding a JS dep.
- A JS dep is only added when it materially reduces work without changing semantics.

## By category

### HTTP / networking

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| httpx | 0.28.1 | async HTTP in agent adapters and providers | undici | Use `fetch`/`Agent` patterns; streaming response handling must be ported explicitly. |
| requests | 2.33.0 | sync HTTP in metadata and auth helpers | undici | Prefer one HTTP stack; replace blocking calls with async helpers. |
| aiohttp | 3.13.3 | async HTTP server/client in gateway platforms | undici | For servers use the chosen web framework; keep client code on `fetch`. |
| aiohttp-socks | 0.11.0 | SOCKS connectors in gateway base and Matrix | socks-proxy-agent | Wire through `undici` dispatcher support; proxy behavior needs integration tests. |
| aiohttp-retry | 2.9.0 | retry helper pulled by HTTP platform clients | p-retry | Centralize retry policy rather than adding a second HTTP abstraction. |
| tenacity | 9.1.4 | retry policy in provider and network calls | p-retry | Preserve retryable error classification and backoff jitter. |
| python-socks | 2.8.1 | SOCKS transport beneath HTTP extras | socks-proxy-agent | Treat as implementation detail of proxy-capable agents. |
| websockets | 15.0.1 | Feishu/Yuanbao and realtime websocket clients | ws | Bun has WebSocket support, but `ws` keeps Node compatibility predictable. |
| sse-starlette | 3.3.2 | SSE response helper for MCP/web streaming | hono/streaming | Use framework-native streaming responses; no standalone dependency needed if Express is chosen. |
| httpx-sse | 0.4.3 | SSE client support from provider SDKs | eventsource | Only add where a provider requires client-side SSE outside `fetch` streams. |
| python-multipart | 0.0.27 | FastAPI multipart upload parsing | @fastify/multipart | Only needed on upload endpoints; otherwise use built-in request body parsing. |
| brotlicffi | 1.2.0.1 | brotli support for messaging/web clients | Node built-in: node:zlib | Use built-in Brotli codecs. |
| httplib2 | 0.31.2 | Google Chat API HTTP transport | googleapis | Do not port directly; the Google JS client owns transport. |

### Async / concurrency

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| anyio | 4.12.1 | async helpers in agent runtime | Node built-in: async primitives | Map task groups/cancellation carefully with `AbortController` and promises. |
| nest-asyncio | 1.6.0 | nested event loop compatibility transitively | rewrite from scratch — no equivalent | Node has a single event loop; avoid nested-loop adaptation. |
| synchronicity | 0.11.0 | sync/async bridging via Modal stack | rewrite from scratch — no equivalent | Greenfield TS should expose explicit async APIs. |
| tornado | 6.5.5 | async server transitive from Modal/tooling | rewrite from scratch — no equivalent | Do not port; web/runtime frameworks replace it. |

### LLM clients

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| openai | 2.24.0 | chat completions in agent/client helpers | openai | Streaming events differ slightly; normalize through provider adapters. |
| anthropic | 0.86.0 | Anthropic adapter in `agent/anthropic_adapter.py` | @anthropic-ai/sdk | Keep provider-specific streaming and tool-call normalization at adapter boundary. |
| jiter | 0.13.0 | streaming JSON parser under OpenAI client | rewrite from scratch — no equivalent | Use SDK event objects; avoid exposing parser internals. |
| distro | 1.9.0 | environment metadata under provider SDKs | rewrite from scratch — no equivalent | Not needed for runtime behavior. |

### Validation / parsing / serialization

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| pydantic | 2.13.4 | request models in web server and tools | zod | Choose `zod` as the canonical runtime schema layer; no TypeBox split. |
| pydantic-core | 2.46.4 | validation engine under Pydantic | zod | Subsumed by `zod`; do not depend on a separate validator. |
| pydantic-settings | 2.13.1 | settings models from provider SDKs | zod | Pair schemas with explicit env loaders. |
| pyyaml | 6.0.3 | YAML config and skill metadata parsing | yaml | One YAML package only; keep parse/stringify behavior centralized. |
| ruamel.yaml | 0.18.17 | YAML comment-preserving edits in CLI retirement tools | yaml | `yaml` supports CST/comment retention better than minimal parsers. |
| jsonschema | 4.26.0 | plugin LLM schema validation | ajv | Use only for JSON Schema interop; prefer `zod` internally. |
| marshmallow | 4.2.2 | env/config schema transitive from environs | zod | Do not port marshmallow-style decorators. |
| environs | 14.6.0 | environment config parsing from SDK stack | dotenv | Combine `dotenv` with `zod` validation. |
| cbor2 | 5.8.0 | binary serialization transitive from ACP/MCP stack | cbor-x | Only add if protocol fixtures prove CBOR is used. |
| msgpack | 1.1.2 | binary serialization transitive from Modal/Daytona | msgpackr | Keep at adapter boundary; most app code should use JSON. |
| toml | 0.10.2 | TOML parsing in tooling | smol-toml | Use for config files only; Node has no built-in TOML parser. |
| defusedxml | 0.7.1 | safe XML parsing in Google/platform clients | fast-xml-parser | Avoid XML unless platform APIs require it; disable entity expansion. |

### CLI / TUI

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| fire | 0.7.1 | small CLI wrapper in sample scripts | rewrite from scratch — no equivalent | Implement explicit command handlers; avoids magic reflection. |
| rich | 14.3.3 | CLI tables, panels, and styled output | picocolors + cli-table3 | Rich has no exact equivalent; build a small renderer for panels/progress. |
| prompt-toolkit | 3.0.52 | interactive input and prompt extras | @inquirer/prompts | Advanced terminal editing may need custom readline handling. |
| simple-term-menu | 1.6.6 | terminal selection menus in CLI auth/main | rewrite from scratch — no equivalent | Small enough to port with raw key handling or Inquirer select. |
| typer | 0.24.1 | CLI framework transitive from Modal/MCP | commander | Prefer one explicit command framework. |
| typer-slim | 0.24.0 | slim CLI framework transitive | commander | Same as above; do not map separately in code. |
| click | 8.3.1 | CLI internals from Typer/SDKs | commander | Treat as framework plumbing, not direct API surface. |
| colorama | 0.4.6 | ANSI compatibility in terminal deps | picocolors | Windows ANSI handling is native enough in modern terminals. |
| termcolor | 3.3.0 | colored output in helper scripts | picocolors | Keep all coloring through one utility. |
| tabulate | 0.9.0 | table rendering transitive/utility | cli-table3 | Use only where fixed-width tables are needed. |
| pygments | 2.19.2 | syntax highlighting under Rich | shiki | Only add for code highlighting surfaces; not for plain logs. |
| markdown-it-py | 4.0.0 | Markdown rendering under Rich | markdown-it | Use in UI/docs rendering only. |
| shellingham | 1.5.4 | shell detection under CLI tooling | rewrite from scratch — no equivalent | Detect shell from env vars where necessary. |
| ipython | <10 | Termux pinned interactive shell dependency | rewrite from scratch — no equivalent | Node REPL or app CLI replaces Python shell tooling. |
| jedi | >=0.18.1,<0.20 | Termux pinned completion engine | rewrite from scratch — no equivalent | TypeScript language service replaces Python completion. |
| parso | >=0.8.4,<0.9 | parser under Jedi Termux pin | rewrite from scratch — no equivalent | TypeScript parser tooling replaces it. |
| stack-data | >=0.6,<0.7 | traceback formatting under IPython | rewrite from scratch — no equivalent | Node stack traces and source maps replace it. |
| pexpect | >4.3,<5 | Termux pseudo-terminal automation pin | node-pty | Use only in terminal subsystem tests or bridges. |
| matplotlib-inline | >=0.1.7,<0.2 | IPython inline display support | rewrite from scratch — no equivalent | No notebook display surface in the TS port. |
| asttokens | >=2.1,<3 | Python AST token helper under IPython | rewrite from scratch — no equivalent | Not relevant outside Python tracebacks. |

### Templating

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| jinja2 | 3.1.6 | templates in research skill scripts | nunjucks | Syntax is close enough; custom filters must be registered explicitly. |
| markupsafe | 3.0.3 | escaping engine under Jinja | nunjucks | Covered by template engine escaping; avoid direct use. |

### Auth / crypto

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| PyJWT | 2.12.1 | JWT signing in skills hub/tool auth | jose | `jose` handles JWT/JWK/JWE consistently across Node runtimes. |
| cryptography | 46.0.7 | WeCom/QQ crypto and JWT crypto extras | Node built-in: node:crypto | Use built-ins first; add `jose` only for JOSE formats. |
| pycryptodome | 3.23.0 | crypto primitives in platform SDK stack | Node built-in: node:crypto | Verify cipher modes used by gateway platforms before adding packages. |
| pynacl | 1.5.0 | Discord voice encryption support | libsodium-wrappers | Needed only if Discord voice is ported. |
| python-olm | 3.2.16 | Matrix end-to-end encryption | @matrix-org/olm | Native/WASM packaging risk; isolate behind Matrix adapter. |
| msal | 1.36.0 | Azure identity auth internals | @azure/msal-node | Mostly hidden by Azure SDKs. |
| msal-extensions | 1.3.1 | MSAL token cache extensions | @azure/msal-node | Use SDK cache hooks; avoid platform-specific cache plugins initially. |
| oauthlib | 3.3.1 | OAuth helpers under Google auth | google-auth-library | Prefer provider SDK OAuth flows. |
| requests-oauthlib | 2.0.0 | OAuth HTTP helpers under Google auth | google-auth-library | Do not port directly. |
| pyasn1 | 0.6.3 | ASN.1 support under Google crypto | jose | Hidden by SDKs or JOSE layer. |
| pyasn1-modules | 0.4.2 | ASN.1 schemas under Google crypto | jose | Hidden by SDKs or JOSE layer. |

### Filesystem / process

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| python-dotenv | 1.2.2 | env loading in gateway and CLI | dotenv | Keep dotenv loading at process entrypoints only. |
| psutil | 7.2.2 | gateway memory/process status and WhatsApp checks | pidusage | Combine with `node:os` for memory; process-tree behavior needs tests. |
| ptyprocess | 0.7.0 | POSIX PTY bridge and process registry | node-pty | Native module; isolate to terminal subsystem. |
| pywinpty | 2.0.15 | Windows PTY process registry | node-pty | Confirm Windows build support in CI before relying on it. |
| aiofiles | 24.1.0 | async file IO transitive from web stack | Node built-in: node:fs/promises | Node file APIs are already async. |
| filelock | 3.24.3 | lock files in SDK/tooling stack | proper-lockfile | Use sparingly for cross-process state. |
| fsspec | 2026.2.0 | filesystem abstraction from ML stack | Node built-in: node:fs/promises | Do not port broad virtual filesystem abstraction unless needed. |
| obstore | 0.8.2 | object-store support under Modal stack | @aws-sdk/client-s3 | Only add provider-specific clients when feature code needs them. |
| aiosqlite | 0.22.1 | Matrix async SQLite storage | better-sqlite3 | Use behind repository interface; async wrapper may be unnecessary. |
| asyncpg | 0.31.0 | Matrix async PostgreSQL storage | postgres | Pick one DB client if durable Matrix storage is retained. |

### Time / scheduling

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| croniter | 6.0.0 | cron schedule parsing in curator/gateway | cron-parser | Validate next-run semantics against Python fixtures. |
| apscheduler | 3.11.2 | scheduler transitive from cron stack | node-cron | Prefer a lightweight scheduler; persistent jobs need separate storage. |
| python-dateutil | 2.9.0.post0 | flexible date parsing from SDKs | date-fns | Avoid permissive parsing in core logic. |
| pytz | 2025.2 | timezone support from schedulers | luxon | Use IANA timezone names; avoid offset-only scheduling. |
| tzdata | 2025.3 | Windows timezone data for cron | luxon | Node ships ICU/tz support; keep Luxon for explicit zone math. |
| tzlocal | 5.3.1 | local timezone detection from schedulers | luxon | `Intl.DateTimeFormat().resolvedOptions().timeZone` covers most cases. |

### Audio / voice / media

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| edge-tts | 7.2.7 | Edge TTS in `tools/tts_tool.py` | edge-tts | Community JS package mirrors the unofficial service; treat as best-effort. |
| elevenlabs | 1.59.0 | premium TTS in `tools/tts_tool.py` | elevenlabs | Keep provider adapter thin for streaming audio. |
| faster-whisper | 1.2.1 | transcription in `tools/transcription_tools.py` | @xenova/transformers | Accuracy/performance differs; consider provider transcription fallback. |
| sounddevice | 0.5.5 | microphone/speaker IO in voice mode | naudiodon | Native module; keep optional and platform-gated. |
| av | 17.0.0 | audio/video decoding under faster-whisper | fluent-ffmpeg | Prefer external ffmpeg process for portability. |
| audioop-lts | 0.2.2 | audio codec compatibility for Discord voice | prism-media | Only needed for Discord voice path. |
| qrcode | 7.4.2 | login QR codes for messaging platforms | qrcode | Direct equivalent; use terminal/string output modes. |
| pypng | 0.20220715.0 | PNG writer under QR package | qrcode | Covered by JS QR package output helpers. |
| openpyxl | >=3.0.0 | Excel validation in DCF optional skill | exceljs | Skill-local dependency; keep outside core runtime. |

### Cloud SDKs

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| boto3 | 1.42.89 | Bedrock adapter and AWS auth doctor | @aws-sdk/client-bedrock-runtime | Use modular AWS SDK v3 clients only. |
| botocore | 1.42.89 | AWS low-level client under Bedrock | @aws-sdk/client-bedrock-runtime | SDK v3 owns signing/retry middleware. |
| s3transfer | 0.16.0 | AWS transfer helper transitive | @aws-sdk/lib-storage | Add only if multipart S3 transfers are ported. |
| azure-identity | 1.25.3 | Azure token adapter in `agent/azure_identity_adapter.py` | @azure/identity | Equivalent concepts; token caching/config differs. |
| azure-core | 1.41.0 | Azure SDK transport core | @azure/core-rest-pipeline | Usually transitive through Azure SDKs. |
| google-api-python-client | 2.194.0 | Google Chat adapter API calls | googleapis | Direct equivalent; generated surfaces differ by API version. |
| google-auth-oauthlib | 1.3.1 | Google OAuth browser flow | google-auth-library | Rebuild CLI OAuth flow around JS auth client. |
| google-auth-httplib2 | 0.3.1 | authorized Google HTTP transport | google-auth-library | Transport is internal to JS client. |
| google-auth | 2.49.2 | Google credential primitives | google-auth-library | Prefer one auth package. |
| google-api-core | 2.30.3 | Google API core transitive | googleapis | Hidden by JS generated client. |
| googleapis-common-protos | 1.73.0 | Google protobuf definitions | googleapis | Hidden by JS generated client. |
| proto-plus | 1.27.2 | Google proto message helpers | googleapis | Hidden by JS generated client. |
| protobuf | 6.33.5 | protocol buffers in Google/OTel stacks | protobufjs | Only add for direct proto handling outside SDKs. |

### Messaging

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| python-telegram-bot | 22.6 | Telegram gateway and send-message tool | grammy | Good TS ergonomics; webhook semantics need adapter tests. |
| discord.py | 2.7.1 | Discord platform and voice integration | discord.js | Voice requires separate `@discordjs/voice` package if enabled. |
| slack-bolt | 1.27.0 | Slack gateway platform | @slack/bolt | Direct equivalent; request signing middleware differs. |
| slack-sdk | 3.40.1 | Slack Web API calls | @slack/web-api | Often transitive through Bolt, but direct Web API client is acceptable. |
| mautrix | 0.21.0 | Matrix gateway platform | matrix-js-sdk | Encryption support requires separate Olm setup. |
| dingtalk-stream | 0.24.3 | DingTalk gateway streaming client | rewrite from scratch — no equivalent | Use DingTalk HTTP/WebSocket APIs directly; no mature official TS peer. |
| alibabacloud-dingtalk | 2.2.42 | DingTalk API client in gateway | @alicloud/dingtalk | Generated package coverage may lag Python; isolate in adapter. |
| alibabacloud-credentials | 1.0.8 | Alibaba credentials for DingTalk | @alicloud/credentials | Use only inside DingTalk adapter. |
| alibabacloud-credentials-api | 1.0.0 | Alibaba credential interfaces | @alicloud/credentials | Hidden by SDK. |
| alibabacloud-endpoint-util | 0.0.4 | Alibaba endpoint resolver | @alicloud/openapi-client | Hidden by SDK. |
| alibabacloud-gateway-dingtalk | 1.0.2 | DingTalk gateway transport | rewrite from scratch — no equivalent | Recreate only the used streaming calls. |
| alibabacloud-gateway-spi | 0.0.3 | Alibaba gateway interfaces | rewrite from scratch — no equivalent | Internal SPI; avoid public dependency. |
| alibabacloud-openapi-util | 0.2.4 | Alibaba OpenAPI helpers | @alicloud/openapi-client | Hidden by SDK. |
| alibabacloud-tea | 0.4.3 | Alibaba Tea runtime | @alicloud/tea-typescript | Runtime concepts differ; contain to generated client. |
| alibabacloud-tea-openapi | 0.4.4 | Alibaba OpenAPI runtime | @alicloud/openapi-client | Use official TS OpenAPI client if needed. |
| alibabacloud-tea-util | 0.3.14 | Alibaba Tea utilities | @alicloud/tea-util | Hidden by SDK. |
| darabonba-core | 1.0.5 | Alibaba generated SDK core | @darabonba/typescript | Avoid unless generated SDK imports require it. |
| lark-oapi | 1.5.3 | Feishu gateway and document tools | @larksuiteoapi/node-sdk | Direct equivalent; webhook verification differs. |

### Web framework

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| fastapi | 0.133.1 | CLI web server and plugin dashboards | hono | Hono gives TS-first routing and schema middleware; no automatic Pydantic models. |
| starlette | 0.52.1 | ASGI primitives under FastAPI and TUI ws | hono | Covered by framework routing/middleware. |
| uvicorn | 0.41.0 | ASGI server for web endpoints | Node built-in: node:http | Bun/Node runtime hosts the server; no separate ASGI server. |
| httptools | 0.7.1 | HTTP parser under Uvicorn standard | Node built-in: node:http | Runtime-owned parser. |
| uvloop | 0.22.1 | event-loop accelerator under Uvicorn | rewrite from scratch — no equivalent | Node/Bun event loop is runtime-owned. |
| watchfiles | 1.1.1 | dev reload support under Uvicorn | chokidar | Dev-only reload helper if needed. |
| annotated-doc | 0.0.4 | FastAPI documentation metadata | @hono/zod-openapi | Generate OpenAPI from TS schemas instead. |

### Search providers

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| exa-py | 2.10.2 | Exa provider in `plugins/web/exa` | exa-js | Direct equivalent; normalize result shape. |
| firecrawl-py | 4.17.0 | Firecrawl provider and web tools | @mendable/firecrawl-js | Direct equivalent; API version compatibility must be checked at port time. |
| parallel-web | 0.4.2 | Parallel web provider plugin | parallel-web | If package coverage lags, wrap REST API with `undici`. |

### Image generation

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| fal-client | 0.13.1 | FAL video/image generation tools | @fal-ai/client | Direct equivalent; streaming/upload helpers differ. |

### Sandboxes

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| modal | 1.3.4 | Modal sandbox in terminal tools | modal | JS package maturity differs; keep behind sandbox interface. |
| daytona | 0.155.0 | Daytona sandbox in terminal tools | @daytonaio/sdk | Direct SDK equivalent; async client shapes differ. |
| daytona-api-client | 0.155.0 | Daytona generated sync client | @daytonaio/sdk | Hidden behind SDK. |
| daytona-api-client-async | 0.155.0 | Daytona generated async client | @daytonaio/sdk | Hidden behind SDK. |
| daytona-toolbox-api-client | 0.155.0 | Daytona toolbox sync client | @daytonaio/sdk | Hidden behind SDK. |
| daytona-toolbox-api-client-async | 0.155.0 | Daytona toolbox async client | @daytonaio/sdk | Hidden behind SDK. |
| vercel | 0.5.7 | Vercel sandbox provider | @vercel/sdk | Verify sandbox APIs exist in JS SDK; otherwise use REST. |
| vercel-workers | 0.0.16 | Vercel worker support transitive | @vercel/sdk | Treat as Vercel adapter internals. |

### Memory

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| honcho-ai | 2.0.1 | Honcho memory plugin client/session | honcho-ai | Use official JS client if available; otherwise REST wrapper. |
| hindsight-client | 0.6.1 | Hindsight memory plugin | rewrite from scratch — no equivalent | No stable npm peer identified; wrap service HTTP API. |

### Observability

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| opentelemetry-api | 1.39.1 | telemetry API transitive from Modal/web | @opentelemetry/api | Use only if tracing is first-class in TS port. |
| opentelemetry-sdk | 1.39.1 | telemetry SDK transitive from Modal/web | @opentelemetry/sdk-node | Keep configuration at process entrypoints. |
| opentelemetry-exporter-otlp-proto-common | 1.39.1 | OTLP exporter support | @opentelemetry/exporter-trace-otlp-http | Covered by JS exporter packages. |
| opentelemetry-exporter-otlp-proto-http | 1.39.1 | OTLP HTTP exporter | @opentelemetry/exporter-trace-otlp-http | Use HTTP exporter for Node compatibility. |
| opentelemetry-instrumentation | 0.60b1 | auto-instrumentation base | @opentelemetry/instrumentation | Add instrumentations intentionally, not wholesale. |
| opentelemetry-instrumentation-aiohttp-client | 0.60b1 | aiohttp client tracing | @opentelemetry/instrumentation-undici | Only if HTTP client tracing is required. |
| opentelemetry-proto | 1.39.1 | OTLP proto definitions | @opentelemetry/otlp-transformer | Usually hidden by exporter. |
| opentelemetry-semantic-conventions | 0.60b1 | span attribute constants | @opentelemetry/semantic-conventions | Direct equivalent. |
| opentelemetry-util-http | 0.60b1 | HTTP tracing utilities | @opentelemetry/core | Hidden by instrumentations. |

### MCP / ACP

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| mcp | 1.26.0 | MCP server/client tools and computer-use | @modelcontextprotocol/sdk | Direct equivalent; transport/event API differs. |
| agent-client-protocol | 0.9.0 | ACP adapter server and event models | @zed-industries/agent-client-protocol | If npm package is insufficient, generate types from protocol schema. |
| grpclib | 0.4.9 | gRPC async support under ACP/Modal stack | @grpc/grpc-js | Add only for actual gRPC endpoints. |

### YouTube

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| youtube-transcript-api | 1.2.4 | YouTube quiz transcript extraction skill | youtube-transcript | Unofficial APIs can break; isolate in optional skill. |

### Markdown / docs

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| Markdown | 3.10.2 | Matrix/send-message Markdown conversion | markdown-it | Use one Markdown parser/renderer across docs and messaging. |
| mdurl | 0.1.2 | URL parser under Markdown stack | markdown-it | Internal to Markdown parser. |
| docstring-parser | 0.17.0 | tool/schema docs from SDK stack | doctrine | Only needed if parsing JSDoc or generated docs. |

### Numerics / ML runtime

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| numpy | 2.4.3 | voice mode arrays and holographic memory | ndarray | Use only where numeric arrays remain local; otherwise simplify. |
| onnxruntime | 1.24.4 | Whisper/ML inference runtime | onnxruntime-node | Native dependency; keep optional for voice/transcription. |
| ctranslate2 | 4.7.1 | faster-whisper inference engine | rewrite from scratch — no equivalent | Prefer ONNX/WebGPU or provider transcription in TS. |
| tokenizers | 0.22.2 | tokenizer runtime from HuggingFace stack | @huggingface/tokenizers | Native/WASM packaging risk; isolate behind tokenizer service. |
| huggingface-hub | 1.4.1 | model download/cache under Whisper stack | @huggingface/hub | Only needed for local model management. |
| hf-xet | 1.3.1 | HuggingFace large-file transport | @huggingface/hub | Hidden by hub client; do not add directly. |
| flatbuffers | 25.12.19 | ONNX/runtime serialization support | flatbuffers | Usually hidden by runtime packages. |
| sympy | 1.14.0 | symbolic math transitive from ONNX stack | nerdamer | Avoid unless feature code needs symbolic math. |
| mpmath | 1.3.0 | numeric math under SymPy | decimal.js | Avoid unless high-precision math is required. |

### Dev / test

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| pytest | 9.0.2 | Python unit/integration tests | vitest | TS repo already uses Vitest; keep one test runner. |
| pytest-asyncio | 1.3.0 | async Python tests | vitest | Vitest handles async tests natively. |
| pytest-timeout | 2.4.0 | Python test timeouts | vitest | Use per-test timeout options. |
| debugpy | 1.8.20 | Python debugger in dev extra | Node built-in: inspector | Use Node inspector and editor launch configs. |
| ty | 0.0.21 | Python type checker in dev extra | typescript | `tsc --noEmit` is the canonical checker. |
| ruff | 0.15.10 | Python lint/format in dev extra | @biomejs/biome | Repo already uses Biome. |
| iniconfig | 2.3.0 | pytest ini parser | vitest | Hidden by Vitest config. |
| pluggy | 1.6.0 | pytest plugin system | vitest | Hidden by Vitest. |
| packaging | 26.0 | version parsing in tests/plugins | semver | Use only for explicit version comparisons. |
| setuptools | 82.0.1 | Python packaging/build metadata | package.json | No runtime equivalent. |
| types-certifi | 2021.10.8.3 | Python type stubs | rewrite from scratch — no equivalent | TypeScript declarations come with packages or `@types/*`. |
| types-toml | 0.10.8.20240310 | Python type stubs | rewrite from scratch — no equivalent | TypeScript declarations come with packages or `@types/*`. |

### Transitives — handled by JS stack

| python_lib | version | usage_summary | js_equivalent | divergence_notes |
|---|---:|---|---|---|
| aiohappyeyeballs | 2.6.1 | connector internals | undici | Subsumed by JS HTTP stack. |
| aiosignal | 1.4.0 | aiohttp signal internals | undici | Subsumed by JS HTTP stack. |
| annotated-types | 0.7.0 | Pydantic type metadata | zod | Subsumed by schema layer. |
| attrs | 25.4.0 | SDK data-class helper | zod | Use TS types and schemas. |
| base58 | 2.1.1 | encoding helper from protocol stack | Node built-in: Buffer | Add tiny local codec only if required by tests. |
| certifi | 2026.2.25 | CA bundle | Node built-in: TLS trust store | Subsumed by runtime TLS. |
| cffi | 2.0.0 | native FFI support | Node built-in: N-API | Hidden by native packages. |
| charset-normalizer | 3.4.4 | requests charset detection | undici | Subsumed by JS HTTP/body decoding. |
| deprecated | 1.3.1 | deprecation decorator | rewrite from scratch — no equivalent | Do not port decorator plumbing. |
| frozenlist | 1.8.0 | aiohttp immutable list internals | undici | Subsumed by JS HTTP stack. |
| h11 | 0.16.0 | HTTP/1 protocol internals | Node built-in: node:http | Runtime-owned. |
| h2 | 4.3.0 | HTTP/2 protocol internals | Node built-in: node:http2 | Runtime-owned. |
| hpack | 4.1.0 | HTTP/2 header compression | Node built-in: node:http2 | Runtime-owned. |
| httpcore | 1.0.9 | httpx transport core | undici | Subsumed by JS HTTP stack. |
| hyperframe | 6.1.0 | HTTP/2 frame internals | Node built-in: node:http2 | Runtime-owned. |
| idna | 3.15 | IDNA URL encoding | Node built-in: URL | Subsumed by runtime URL handling. |
| importlib-metadata | 8.7.1 | Python package metadata | package.json | Subsumed by JS package metadata. |
| jmespath | 1.1.0 | AWS query helper | @aws-sdk/client-bedrock-runtime | Hidden by AWS SDK. |
| jsonschema-specifications | 2025.9.1 | JSON Schema metaschemas | ajv | Hidden by validator. |
| multidict | 6.7.1 | aiohttp multidict internals | undici | Subsumed by Headers/URLSearchParams. |
| propcache | 0.4.1 | aiohttp cache internals | undici | Subsumed by JS HTTP stack. |
| pycparser | 3.0 | C parser for cffi | Node built-in: N-API | Hidden by native packages. |
| pyparsing | 3.3.2 | parser helper under packaging | semver | Avoid direct parser dependency. |
| referencing | 0.37.0 | JSON Schema reference resolver | ajv | Hidden by validator. |
| requests-toolbelt | 1.0.0 | requests multipart helpers | undici | Subsumed by FormData/fetch. |
| rpds-py | 0.30.0 | immutable structures under jsonschema | ajv | Hidden by validator. |
| ruamel-yaml-clib | 0.2.15 | YAML native accelerator | yaml | JS package has its own implementation. |
| six | 1.17.0 | Python compatibility shim | rewrite from scratch — no equivalent | No TS equivalent needed. |
| sniffio | 1.3.1 | async library detection | Node built-in: async primitives | No multi-async-runtime split in TS. |
| socksio | 1.0.0 | SOCKS protocol internals | socks-proxy-agent | Hidden by proxy agent. |
| tqdm | 4.67.3 | progress bars from SDKs/scripts | cli-progress | Add only for user-visible long operations. |
| typing-extensions | 4.15.0 | Python typing backports | typescript | Subsumed by TypeScript. |
| typing-inspection | 0.4.2 | Pydantic typing introspection | zod | Subsumed by schema layer. |
| unpaddedbase64 | 2.1.0 | Matrix/base64 helper | Node built-in: Buffer | Local helper is enough if needed. |
| uritemplate | 4.2.0 | Google URI templates | googleapis | Hidden by Google SDK. |
| urllib3 | 2.6.3 | requests/botocore transport | undici | Subsumed by JS HTTP stack. |
| wcwidth | 0.6.0 | terminal width calculation | string-width | Add only for table alignment. |
| wrapt | 1.17.3 | decorator helper under SDKs | rewrite from scratch — no equivalent | Do not port decorator plumbing. |
| yarl | 1.22.0 | aiohttp URL type | Node built-in: URL | Subsumed by runtime URL handling. |
| zipp | 3.23.0 | importlib metadata helper | package.json | Subsumed by JS package metadata. |
