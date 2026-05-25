# @hermests/providers

Registry and base class for every inference provider HermesTS knows about.

Each provider is declared once as a `ProviderProfile`. Every other layer —
auth resolution, transport kwargs, model listing, runtime routing — reads
from these profiles instead of maintaining its own parallel data.

## Modules

| Upstream `.py` | TS file | Surface |
|---|---|---|
| `providers/base.py` (185 LOC) | `src/base.ts` | `ProviderProfile`, `OMIT_TEMPERATURE`, `setUserAgentProvider`, `resetUserAgentProvider`, `_profileUserAgent`, types `ProviderProfileOptions`, `AuthType`, `ApiMode`, `ApiKwargsExtras`, `BuildApiKwargsContext`, `BuildExtraBodyContext`, `OmitTemperature`, `UserAgentProvider` |
| `providers/__init__.py` (192 LOC) | `src/registry.ts` | `registerProvider`, `getProviderProfile`, `listProviders`, `_resetRegistry`, `_getRegistry`, `_getAliases`, `_setBundledPluginsDirForTesting` |

## Layout

```
providers/
├── base.ts        ProviderProfile class + OMIT_TEMPERATURE sentinel
├── registry.ts    Registry: registerProvider(), getProviderProfile(), listProviders()
└── index.ts       Barrel export
```

The **profiles themselves** live as plugins under
`packages/plugins/model-providers/<name>/` (bundled in this repo, ported in
task #8) and `$HERMES_HOME/plugins/model-providers/<name>/` (per-user
overrides). The registry in `src/registry.ts` lazily discovers them the
first time any consumer calls `getProviderProfile()` or `listProviders()`.

## Faithful divergences

This package is a faithful port of upstream `providers/`. Where Python has
no direct Node equivalent, the divergence is below; the upstream `file:line`
reference makes it easy to audit.

| Upstream construct | TS port | Reason |
|---|---|---|
| `OMIT_TEMPERATURE = object()` (base py:L21) | `Symbol("OMIT_TEMPERATURE")` (unique symbol) | Identity-comparable sentinel; same `===` semantics as `is` against a unique object. |
| `@dataclass` (base py:L38-78) | Class with `readonly` public fields, constructor takes `ProviderProfileOptions` with per-field defaults | TS has no dataclass; class fields preserve the public surface and per-instance overridability. |
| `field(default_factory=dict)` for `default_headers` (base py:L69) | Constructor option falls back to `{}` per instance | Matches upstream "fresh dict per instance" semantics — no aliasing across profiles. |
| `_profile_user_agent` lazy `from hermes_cli import __version__` (base py:L24-35) | Injectable `UserAgentProvider` callback via `setUserAgentProvider` | Cross-package dep — `@hermests/cli` ported in task #14 wires in `hermes-cli/<ver>`. Default returns `"hermes-cli"`. |
| `urllib.request` synchronous fetch (base py:L163-184) | Async `fetch` + `AbortController` with timeout | Node has no synchronous HTTP. `fetchModels` becomes async. |
| `urlparse(self.base_url).hostname or ""` (base py:L91-93) | `new URL(...).hostname` inside `try/catch` returning `""` on parse failure | Node's `new URL` throws on unparseable input; the catch matches Python's "tolerant" behavior. |
| Sync `get_provider_profile`, `list_providers` (init py:L65-88) | Async — `Promise<ProviderProfile \| null>` and `Promise<ProviderProfile[]>` | ESM dynamic `import()` is async. Lazy discovery cannot be synchronous in TS. |
| Implicit single-threaded import serialization (init py:L140-191) | Explicit cached `_discoveryPromise` so concurrent first-callers share the same async discovery run | Python's sync `import` serializes naturally; async TS callers can race past the `_discovered` flag check and see a half-populated registry. The cached Promise restores the upstream invariant. |
| `importlib.util.spec_from_file_location` for plugin loading (init py:L102-137) | `await import(pathToFileURL(entry).href)` | ESM dynamic import is the direct analogue; URL caching is what `sys.modules` provides upstream. |
| Plugin entry file: `__init__.py` (init py:L107) | `index.js`, `index.mjs`, or `index.ts` (priority order) | Same convention, TS file extensions. Supports both compiled JS and TS-native runtimes (Bun). |
| Legacy `pkgutil.iter_modules` over `providers/*.py` (init py:L176-191) | **Not ported** | No editable-install + hot-import of bare `.ts` files in TS; the plugin-directory layout is the only supported form. New profiles must use the plugin layout (which upstream already recommends — see init py:L21 "New profiles should prefer the plugin layout."). |
| `$HERMES_HOME` resolution via `get_hermes_home` (init py:L94-96) | `getHermesHome` from `@hermests/core` | Direct call to the ported core API. |

## API

### `class ProviderProfile`

```ts
import { ProviderProfile, OMIT_TEMPERATURE } from "@hermests/providers";

const profile = new ProviderProfile({
  name: "kimi-coding",
  aliases: ["kimi", "moonshot"],
  envVars: ["KIMI_API_KEY"],
  baseUrl: "https://api.moonshot.cn/v1",
  authType: "api_key",
  fixedTemperature: OMIT_TEMPERATURE,
  defaultMaxTokens: 32000,
});
```

Hooks overridable via subclass:

| Hook | Purpose |
|------|---------|
| `getHostname()` | URL-based detection — default derives from `baseUrl`. |
| `prepareMessages(msgs)` | Provider-specific message preprocessing. |
| `buildExtraBody(ctx)` | Provider-specific `extra_body`. |
| `buildApiKwargsExtras(ctx)` | `[extraBodyAdditions, topLevelKwargs]`. |
| `fetchModels({ apiKey, timeoutMs })` | Live catalog fetch — default hits `{modelsUrl or baseUrl}/models` with Bearer auth. |

### Registry

```ts
import { getProviderProfile, listProviders, registerProvider } from "@hermests/providers";

await getProviderProfile("kimi");        // ProviderProfile | null (resolves alias)
await listProviders();                   // ProviderProfile[]
registerProvider(new ProviderProfile({ name: "my-prov" }));
```

Discovery runs on the first call to `getProviderProfile` or
`listProviders` and is idempotent thereafter. To force re-discovery in
tests, call `_resetRegistry()`.

## Deferred tests

Upstream tests cross-import modules from packages that haven't been ported
yet. See `docs/deferred-tests.md` at the repo root for the current list.
Tests deferred from this package's scope:

| Upstream path | Deferred to task | Rationale |
|---|---|---|
| `tests/providers/test_provider_profiles.py` — provider-specific cases (`TestNvidiaProfile`, `TestKimiProfile`, `TestOpenRouterProfile`, `TestNousProfile`, `TestQwenProfile`) | #8 (plugins) | Each provider-specific case asserts the exact field values and overridden hooks of a bundled plugin profile — those profiles live under `plugins/model-providers/<name>/` and ship with the `@hermests/plugins` package. The base-dataclass and registry-mechanism cases (`TestRegistry`, `TestBaseProfile`) are ported in this package. |
| `tests/providers/test_plugin_discovery.py` — `test_bundled_plugins_discovered`, `test_all_34_profiles_register` | #8 (plugins) | Both assert that the real 34 bundled plugin directories exist and register. Fixture-driven equivalents are ported here (`plugin discovery — bundled path` describe block). |
| `tests/providers/test_plugin_discovery.py` — `test_general_plugin_manager_skips_model_provider_kind` | #14 (cli) | Asserts the `hermes_cli.plugins.PluginManager` ignores `kind: model-provider`. PluginManager lives in `@hermests/cli`. |
| `tests/providers/test_profile_wiring.py`, `test_e2e_wiring.py`, `test_transport_parity.py` | #5 (agent) + #8 (plugins) | All three import `agent.transports.chat_completions.ChatCompletionsTransport` and the bundled plugin profiles. They will be ported when both dependencies land. |

The non-deferred upstream cases (`TestRegistry`, `TestBaseProfile`, and the
plugin-override / discovery-error branches of `test_plugin_discovery.py`)
are ported in `tests/`.
