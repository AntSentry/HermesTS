/**
 * Stub interfaces for sibling sub-tasks (#5a–#5o) that have not yet landed in main.
 *
 * The aux client porter (#5j) cannot wait for #5g (auth + credentials),
 * #5h (anthropic + bedrock), #5i (gemini + codex + copilot), the upstream
 * `tools` package (#6), or `hermes_cli` (#14) to merge — all are mid-flight
 * in parallel worktrees. This module gives the aux client a typed, injectable
 * contract for each external surface it touches, so the body of the port can
 * be written and tested in isolation.
 *
 * The integrator sub-task (#5o) is responsible for replacing these stubs with
 * imports from the real sibling packages once they land. Every export here
 * is marked with the upstream call site it represents.
 *
 * FIXME(#5o): replace each provider below with an import from the matching
 * sibling package when it merges.
 */

import type { OpenAIClient } from "./openai-client-shape.js";

// ─── agent.credential_pool (#5g) ──────────────────────────────────────────────
//
// Aux client uses two surfaces from the pool: `load_pool(provider)` returns a
// CredentialPool, and `PooledCredential` instances are inspected for
// `runtime_api_key`, `access_token`, `runtime_base_url`, `inference_base_url`,
// `base_url`. The aux client never mutates these; it only reads them.
//

/** Subset of `agent.credential_pool.PooledCredential` aux client reads. */
export interface PooledCredentialLike {
  readonly runtime_api_key?: string;
  readonly access_token?: string;
  readonly runtime_base_url?: string;
  readonly inference_base_url?: string;
  readonly base_url?: string;
}

/** Subset of `agent.credential_pool.CredentialPool` aux client reads. */
export interface CredentialPoolLike {
  has_credentials(): boolean;
  select(): PooledCredentialLike | null;
  current?(): PooledCredentialLike | null;
  peek?(): PooledCredentialLike | null;
}

/** `load_pool(provider)` injection — defaults to throwing. */
export type LoadPoolFn = (provider: string) => CredentialPoolLike | null;

let _loadPool: LoadPoolFn = (provider) => {
  throw new Error(
    `agent/credential_pool.load_pool stub: no implementation registered for provider=${provider}`,
  );
};

/** Override the load_pool implementation. Integrator wires the real one. */
export function setLoadPool(fn: LoadPoolFn): void {
  _loadPool = fn;
}

/** Reset the load_pool injection to the throwing default. Test-only helper. */
export function resetLoadPool(): void {
  _loadPool = (provider) => {
    throw new Error(
      `agent/credential_pool.load_pool stub: no implementation registered for provider=${provider}`,
    );
  };
}

/** Internal accessor — aux client calls this in place of `load_pool(...)`. */
export function loadPool(provider: string): CredentialPoolLike | null {
  return _loadPool(provider);
}

// ─── providers.get_provider_profile (#3 — already landed) ────────────────────
//
// `providers` package is landed (#3) but the aux client only uses one field:
// `profile.default_aux_model`. Define a narrow shape here and let the
// integrator wire to the real provider profile object via `setProviderProfileResolver`.
//

/** Subset of provider profile fields aux client reads. */
export interface ProviderProfileLike {
  readonly default_aux_model?: string;
}

export type GetProviderProfileFn = (providerId: string) => ProviderProfileLike | null;

/** Default — no provider profiles registered. */
function _defaultGetProviderProfile(): ProviderProfileLike | null {
  return null;
}

let _getProviderProfile: GetProviderProfileFn = _defaultGetProviderProfile;

/** Override the provider-profile resolver. Integrator wires the real one. */
export function setProviderProfileResolver(fn: GetProviderProfileFn): void {
  _getProviderProfile = fn;
}

/** Reset the provider-profile resolver. Test-only helper. */
export function resetProviderProfileResolver(): void {
  _getProviderProfile = _defaultGetProviderProfile;
}

/** Internal accessor — aux client calls this in place of `get_provider_profile(...)`. */
export function getProviderProfile(providerId: string): ProviderProfileLike | null {
  return _getProviderProfile(providerId);
}

// ─── hermes_cli.config (#14f) ────────────────────────────────────────────────
//
// Aux client reads `load_config()` (full YAML config) and `get_hermes_home()`
// (path to `~/.hermes`). Both are stubbed here so the integrator can wire to
// the real cli config module when it lands.
//

/** Subset of `hermes_cli.config.load_config()` return type aux client reads. */
export type HermesConfigDict = Record<string, unknown>;

export type LoadConfigFn = () => HermesConfigDict;
export type GetHermesHomeFn = () => string;

/** Default — empty config. */
function _defaultLoadConfig(): HermesConfigDict {
  return {};
}

/** Default — placeholder hermes-home path until the cli config module lands. */
function _defaultGetHermesHome(): string {
  return "/tmp/.hermes-stub";
}

let _loadConfig: LoadConfigFn = _defaultLoadConfig;
let _getHermesHome: GetHermesHomeFn = _defaultGetHermesHome;

/** Override the config loader. Integrator wires the real one. */
export function setLoadConfig(fn: LoadConfigFn): void {
  _loadConfig = fn;
}

/** Reset the config loader. Test-only helper. */
export function resetLoadConfig(): void {
  _loadConfig = _defaultLoadConfig;
}

/** Override `get_hermes_home`. Integrator wires the real one. */
export function setGetHermesHome(fn: GetHermesHomeFn): void {
  _getHermesHome = fn;
}

/** Reset `get_hermes_home`. Test-only helper. */
export function resetGetHermesHome(): void {
  _getHermesHome = _defaultGetHermesHome;
}

/** Internal accessor — aux client calls this in place of `load_config()`. */
export function loadConfig(): HermesConfigDict {
  return _loadConfig();
}

/** Internal accessor — aux client calls this in place of `get_hermes_home()`. */
export function getHermesHome(): string {
  return _getHermesHome();
}

// ─── agent.portal_tags (#5a) ─────────────────────────────────────────────────
//
// `nous_portal_tags()` returns a list of attribution tags computed from the
// current hermes_cli version. Stubbed to a constant; integrator wires the real
// function.
//

export type NousPortalTagsFn = () => string[];

/** Default — placeholder attribution tag until the portal_tags module lands. */
function _defaultNousPortalTags(): string[] {
  return ["client=hermes-cli-stub"];
}

let _nousPortalTags: NousPortalTagsFn = _defaultNousPortalTags;

/** Override `nous_portal_tags`. Integrator wires the real one. */
export function setNousPortalTags(fn: NousPortalTagsFn): void {
  _nousPortalTags = fn;
}

/** Reset `nous_portal_tags`. Test-only helper. */
export function resetNousPortalTags(): void {
  _nousPortalTags = _defaultNousPortalTags;
}

/** Internal accessor — aux client calls this in place of `nous_portal_tags()`. */
export function nousPortalTags(): string[] {
  return _nousPortalTags();
}

// ─── hermes_cli.__version__ (#14) ────────────────────────────────────────────

export type HermesVersionFn = () => string;

/** Default — placeholder version until hermes_cli lands. */
function _defaultHermesVersion(): string {
  return "0.0.0-stub";
}

let _hermesVersion: HermesVersionFn = _defaultHermesVersion;

/** Override the hermes-cli version provider. */
export function setHermesVersion(fn: HermesVersionFn): void {
  _hermesVersion = fn;
}

/** Reset the hermes-cli version provider. Test-only helper. */
export function resetHermesVersion(): void {
  _hermesVersion = _defaultHermesVersion;
}

/** Internal accessor — replaces upstream `hermes_cli.__version__`. */
export function hermesVersion(): string {
  return _hermesVersion();
}

// ─── openai client constructor (third-party `openai` npm package) ────────────
//
// Aux client constructs OpenAI-compatible clients at 15+ call sites. Upstream
// uses a module-level `_OpenAIProxy` so tests can patch
// `agent.auxiliary_client.OpenAI`. We mirror that pattern with a registerable
// constructor function and an identity sentinel for `isOpenAIClient(...)`.
//

export type OpenAIClientFactory = (
  options?: import("./openai-client-shape.js").OpenAIClientOptions,
) => OpenAIClient;

let _openAIClientFactory: OpenAIClientFactory = () => {
  throw new Error(
    "OpenAI client factory not registered — integrator (#5o) must call setOpenAIClientFactory().",
  );
};

let _openAIClientIdentity: WeakSet<object> = new WeakSet();

/** Override the OpenAI client factory. Integrator wires the real one. */
export function setOpenAIClientFactory(fn: OpenAIClientFactory): void {
  _openAIClientFactory = (options) => {
    const inst = fn(options);
    if (inst !== null && typeof inst === "object") {
      _openAIClientIdentity.add(inst);
    }
    return inst;
  };
}

/** Reset the OpenAI client factory. Test-only helper. */
export function resetOpenAIClientFactory(): void {
  _openAIClientFactory = () => {
    throw new Error(
      "OpenAI client factory not registered — integrator (#5o) must call setOpenAIClientFactory().",
    );
  };
  _openAIClientIdentity = new WeakSet();
}

/** Aux client calls this in place of `OpenAI(...)`. */
export function createOpenAIClient(
  options?: import("./openai-client-shape.js").OpenAIClientOptions,
): OpenAIClient {
  return _openAIClientFactory(options);
}

/**
 * Identity check — replaces `isinstance(obj, OpenAI)` upstream.
 *
 * An object is considered an OpenAI client if it was minted through
 * `createOpenAIClient()`. The integrator may swap this out with a real
 * `instanceof` check against the `openai` npm package's `OpenAI` class.
 */
export function isOpenAIClient(obj: unknown): boolean {
  return obj !== null && typeof obj === "object" && _openAIClientIdentity.has(obj as object);
}

/**
 * Test-only — register an existing client object as OpenAI-shaped. Mirrors
 * upstream `patch("agent.auxiliary_client.OpenAI", FakeOpenAI)` plus
 * `isinstance(some_fake_instance, OpenAI)` returning True because the patched
 * class's `__instancecheck__` matches it.
 */
export function registerOpenAIClient(obj: object): void {
  _openAIClientIdentity.add(obj);
}
