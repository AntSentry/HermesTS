/**
 * Provider-config tables and model heuristics shared across the auxiliary
 * client. Faithful port of the corresponding section of upstream
 * `agent/auxiliary_client.py` (lines 131-318).
 *
 * Nothing here performs I/O — these are pure lookup tables and string
 * heuristics. The provider-resolution chain that *uses* them lives in
 * `./resolution.ts` (later slice).
 */

import { getLogger } from "@hermests/core";
import { getProviderProfile } from "../_internal/sibling-stubs.js";

const logger = getLogger("agent.auxiliary_client.provider_config");

/**
 * Sentinel: when returned by `fixedTemperatureForModel()`, callers must strip
 * the `temperature` key from API kwargs entirely so the provider's
 * server-side default applies. Kimi/Moonshot models manage temperature
 * internally — sending *any* value (even the "correct" one) can conflict with
 * gateway-side mode selection (thinking → 1.0, non-thinking → 0.6).
 *
 * Upstream uses `object()` for identity; TS uses a unique Symbol.
 */
export const OMIT_TEMPERATURE: unique symbol = Symbol("OMIT_TEMPERATURE");
export type OmitTemperature = typeof OMIT_TEMPERATURE;

/**
 * Provider-name aliases. Maps user-facing labels to canonical provider IDs.
 * Faithful to `_PROVIDER_ALIASES` upstream (py:L131-162).
 */
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  google: "gemini",
  "google-gemini": "gemini",
  "google-ai-studio": "gemini",
  "x-ai": "xai",
  "x.ai": "xai",
  grok: "xai",
  glm: "zai",
  "z-ai": "zai",
  "z.ai": "zai",
  zhipu: "zai",
  kimi: "kimi-coding",
  moonshot: "kimi-coding",
  "kimi-cn": "kimi-coding-cn",
  "moonshot-cn": "kimi-coding-cn",
  "gmi-cloud": "gmi",
  gmicloud: "gmi",
  "minimax-china": "minimax-cn",
  minimax_cn: "minimax-cn",
  claude: "anthropic",
  "claude-code": "anthropic",
  github: "copilot",
  "github-copilot": "copilot",
  "github-model": "copilot",
  "github-models": "copilot",
  "github-copilot-acp": "copilot-acp",
  "copilot-acp-agent": "copilot-acp",
  tencent: "tencent-tokenhub",
  tokenhub: "tencent-tokenhub",
  "tencent-cloud": "tencent-tokenhub",
  tencentmaas: "tencent-tokenhub",
});

/**
 * Injectable read of the user's "main provider" config value. Upstream calls
 * a private `_read_main_provider()` whose body lives later in the file
 * (config-disk read). For provider-alias normalization the only behavior we
 * need is the string lookup — porters in later slices will wire the real read.
 *
 * Default returns the empty string (so "main" → "custom" in resolution).
 */
export type ReadMainProviderFn = () => string;

/** Default — returns empty so the `normalizeAuxProvider("main")` path collapses to "custom". */
function _defaultReadMainProvider(): string {
  return "";
}

let _readMainProvider: ReadMainProviderFn = _defaultReadMainProvider;

/** Override the main-provider reader. Wired by the resolution slice. */
export function setReadMainProvider(fn: ReadMainProviderFn): void {
  _readMainProvider = fn;
}

/** Reset the main-provider reader to the default. Test-only helper. */
export function resetReadMainProvider(): void {
  _readMainProvider = _defaultReadMainProvider;
}

/**
 * Internal accessor — invoked from `normalizeAuxProvider`. Public so that the
 * later resolution slice can reuse it without re-implementing the read.
 */
export function readMainProvider(): string {
  return _readMainProvider();
}

/**
 * Normalize a user-provided provider string to a canonical provider ID.
 * Faithful to `_normalize_aux_provider` (py:L165-182).
 *
 * - empty / null → `"auto"`
 * - `"custom:<name>"` → strip prefix, then alias-lookup
 * - `"codex"` → `"openai-codex"`
 * - `"main"` → resolved against the user's actual main provider
 * - anything else → alias-lookup or pass-through
 */
export function normalizeAuxProvider(provider: string | null | undefined): string {
  // Faithful to upstream `(provider or "auto")` — Python `or` is truthy-based,
  // so an empty string also falls through to "auto".
  let normalized = (provider || "auto").trim().toLowerCase();
  if (normalized.startsWith("custom:")) {
    const suffix = normalized.slice("custom:".length).trim();
    if (!suffix) {
      return "custom";
    }
    normalized = suffix;
  }
  if (normalized === "codex") {
    return "openai-codex";
  }
  if (normalized === "main") {
    const mainProv = readMainProvider().trim().toLowerCase();
    if (mainProv && mainProv !== "auto" && mainProv !== "main" && mainProv !== "") {
      normalized = mainProv;
    } else {
      return "custom";
    }
  }
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

/** True for any Kimi / Moonshot model. Faithful to `_is_kimi_model` (py:L193-196). */
export function isKimiModel(model: string | null | undefined): boolean {
  // `.split("/")` always returns at least one element so `.pop()` is always a string.
  const parts = (model ?? "").trim().toLowerCase().split("/");
  const bare = parts[parts.length - 1] as string;
  return bare.startsWith("kimi-") || bare === "kimi";
}

/**
 * True for Arcee Trinity Large Thinking, whether accessed directly or via
 * OpenRouter. Faithful to `_is_arcee_trinity_thinking` (py:L199-202).
 */
export function isArceeTrinityThinking(model: string | null | undefined): boolean {
  const parts = (model ?? "").trim().toLowerCase().split("/");
  const bare = parts[parts.length - 1] as string;
  return bare === "trinity-large-thinking";
}

/**
 * Return a temperature directive for models with strict contracts.
 * Faithful to `_fixed_temperature_for_model` (py:L205-224).
 *
 * Returns:
 *   - `OMIT_TEMPERATURE` — caller must remove the `temperature` key so the
 *     provider chooses its own default. Used for all Kimi / Moonshot models.
 *   - `number` — a specific value the caller must use (Arcee Trinity Thinking → 0.5).
 *   - `null` — no override; caller should use its own default.
 *
 * Note: the `baseUrl` parameter mirrors the upstream signature but is unused
 * — kept for future contracts that may key on the base URL.
 */
export function fixedTemperatureForModel(
  model: string | null | undefined,
  _baseUrl?: string | null,
): number | OmitTemperature | null {
  if (isKimiModel(model)) {
    logger.debug("Omitting temperature for Kimi model %s (server-managed)", model);
    return OMIT_TEMPERATURE;
  }
  if (isArceeTrinityThinking(model)) {
    return 0.5;
  }
  return null;
}

/**
 * Return a context-compression threshold override for specific models, or
 * `null` to leave the user's `compression.threshold` config value unchanged.
 *
 * Faithful to `_compression_threshold_for_model` (py:L227-239).
 */
export function compressionThresholdForModel(model: string | null | undefined): number | null {
  if (isArceeTrinityThinking(model)) {
    return 0.75;
  }
  return null;
}

/**
 * Fallback table for providers not yet migrated to
 * `ProviderProfile.default_aux_model`. New providers should set
 * `default_aux_model` on their profile instead of extending this map.
 *
 * Faithful to `_API_KEY_PROVIDER_AUX_MODELS_FALLBACK` (py:L261-278).
 */
export const API_KEY_PROVIDER_AUX_MODELS_FALLBACK: Readonly<Record<string, string>> = Object.freeze(
  {
    gemini: "gemini-3-flash-preview",
    zai: "glm-4.5-flash",
    "kimi-coding": "kimi-k2-turbo-preview",
    stepfun: "step-3.5-flash",
    "kimi-coding-cn": "kimi-k2-turbo-preview",
    gmi: "google/gemini-3.1-flash-lite-preview",
    minimax: "MiniMax-M2.7",
    "minimax-oauth": "MiniMax-M2.7-highspeed",
    "minimax-cn": "MiniMax-M2.7",
    anthropic: "claude-haiku-4-5-20251001",
    "ai-gateway": "google/gemini-3-flash",
    "opencode-zen": "gemini-3-flash",
    "opencode-go": "glm-5",
    kilocode: "google/gemini-3-flash-preview",
    "ollama-cloud": "nemotron-3-nano:30b",
    "tencent-tokenhub": "hy3-preview",
  },
);

/**
 * Legacy alias — callers that haven't been updated to
 * `getAuxModelForProvider` can still use this dict directly. Kept in sync
 * with the FALLBACK above.
 *
 * Faithful to `_API_KEY_PROVIDER_AUX_MODELS` (py:L282).
 */
export const API_KEY_PROVIDER_AUX_MODELS = API_KEY_PROVIDER_AUX_MODELS_FALLBACK;

/**
 * Return the cheap auxiliary model for a provider. Reads
 * `ProviderProfile.default_aux_model` first, falling back to the legacy
 * hardcoded dict for providers that predate the profiles system.
 *
 * Faithful to `_get_aux_model_for_provider` (py:L242-255).
 */
export function getAuxModelForProvider(providerId: string): string {
  try {
    const profile = getProviderProfile(providerId);
    if (profile?.default_aux_model) {
      return profile.default_aux_model;
    }
  } catch {
    // upstream silently swallows any exception from the provider profile
    // lookup and falls back to the legacy table.
  }
  return API_KEY_PROVIDER_AUX_MODELS_FALLBACK[providerId] ?? "";
}

/**
 * Vision-specific model overrides for direct providers. When the user's main
 * provider has a dedicated vision/multimodal model that differs from their
 * main chat model, map it here.
 *
 * Faithful to `_PROVIDER_VISION_MODELS` (py:L288-291).
 */
export const PROVIDER_VISION_MODELS: Readonly<Record<string, string>> = Object.freeze({
  xiaomi: "mimo-v2.5",
  zai: "glm-5v-turbo",
});

/**
 * Providers whose endpoint does not accept image input, even though the
 * provider's broader ecosystem has vision models available elsewhere. When
 * `auxiliary.vision.provider: auto` sees one of these as the main provider,
 * it must skip straight to the aggregator chain instead of returning a client
 * that will 404 on every vision request.
 *
 * - kimi-coding / kimi-coding-cn: the Kimi Coding Plan routes through
 *   api.kimi.com/coding (Anthropic Messages wire) which Kimi's own docs
 *   describe as having no image_in capability. Vision lives on the separate
 *   Kimi Platform (api.moonshot.ai, OpenAI-wire, pay-as-you-go). See #17076.
 *
 * Faithful to `_PROVIDERS_WITHOUT_VISION` (py:L303-306). Upstream uses a
 * `frozenset`; we use a `ReadonlySet` for the same semantics.
 */
export const PROVIDERS_WITHOUT_VISION: ReadonlySet<string> = new Set([
  "kimi-coding",
  "kimi-coding-cn",
]);

/**
 * Truthy values for boolean env-var parsing. Faithful to `_TRUTHY_ENV_VALUES`
 * (py:L318).
 */
export const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);
