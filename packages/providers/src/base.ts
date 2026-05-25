/**
 * Provider profile base class.
 *
 * Faithful port of upstream `providers/base.py`.
 *
 * A ProviderProfile declares everything about an inference provider in one
 * place: auth, endpoints, client quirks, request-time quirks. The transport
 * reads this instead of receiving 20+ boolean flags.
 *
 * Provider profiles are DECLARATIVE — they describe the provider's behavior.
 * They do NOT own client construction, credential rotation, or streaming.
 */

import { getLogger } from "@hermests/core";

const logger = getLogger("providers.base");

/**
 * Sentinel for "omit temperature entirely" (Kimi: server manages it).
 *
 * Upstream uses `object()` (a unique object identity). In TS we use a
 * unique Symbol — same identity semantics, comparable with `===`.
 */
export const OMIT_TEMPERATURE: unique symbol = Symbol("OMIT_TEMPERATURE");
export type OmitTemperature = typeof OMIT_TEMPERATURE;

/**
 * Injection point for the User-Agent string used by `fetchModels`.
 *
 * Upstream lazy-imports `hermes_cli.__version__` to build a
 * `hermes-cli/<ver>` UA, falling back to `hermes-cli`. In TS the cli
 * package is downstream — porters wire in a real provider once it lands.
 * Default returns the static fallback.
 */
export type UserAgentProvider = () => string;

let _userAgentProvider: UserAgentProvider | null = null;

/** Override the User-Agent provider used by `ProviderProfile.fetchModels`. */
export function setUserAgentProvider(provider: UserAgentProvider): void {
  _userAgentProvider = provider;
}

/** Reset the User-Agent provider to the built-in fallback. Test-only helper. */
export function resetUserAgentProvider(): void {
  _userAgentProvider = null;
}

/** Internal: read the current User-Agent string. */
export function _profileUserAgent(): string {
  if (_userAgentProvider === null) {
    return "hermes-cli";
  }
  try {
    return _userAgentProvider();
  } catch {
    return "hermes-cli";
  }
}

/** Auth scheme — matches upstream `auth_type` discriminator. */
export type AuthType = "api_key" | "oauth_device_code" | "oauth_external" | "copilot" | "aws_sdk";

/** API surface dialect — matches upstream `api_mode`. */
export type ApiMode = string;

/** Construction-time options for ProviderProfile. */
export interface ProviderProfileOptions {
  // Identity
  name: string;
  apiMode?: ApiMode;
  aliases?: readonly string[];

  // Human-readable metadata
  displayName?: string;
  description?: string;
  signupUrl?: string;

  // Auth & endpoints
  envVars?: readonly string[];
  baseUrl?: string;
  modelsUrl?: string;
  authType?: AuthType;
  supportsHealthCheck?: boolean;

  // Model catalog
  fallbackModels?: readonly string[];
  hostname?: string;

  // Client-level quirks
  defaultHeaders?: Record<string, string>;

  // Request-level quirks
  fixedTemperature?: number | OmitTemperature | null;
  defaultMaxTokens?: number | null;
  defaultAuxModel?: string;
}

/** Return tuple of `buildApiKwargsExtras` — `[extraBodyAdditions, topLevelKwargs]`. */
export type ApiKwargsExtras = [Record<string, unknown>, Record<string, unknown>];

/** Context for `buildApiKwargsExtras` — arbitrary provider-specific kwargs. */
export interface BuildApiKwargsContext {
  reasoningConfig?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** Context for `buildExtraBody` — `sessionId` is the only well-known field. */
export interface BuildExtraBodyContext {
  sessionId?: string | null;
  [key: string]: unknown;
}

/**
 * Provider profile — instantiate directly or extend to override hooks.
 *
 * Field names mirror the upstream dataclass attributes, transliterated to
 * camelCase. All fields are public (matches dataclass semantics) and
 * settable from the constructor options.
 */
export class ProviderProfile {
  // Identity
  readonly name: string;
  readonly apiMode: ApiMode;
  readonly aliases: readonly string[];

  // Human-readable metadata
  readonly displayName: string;
  readonly description: string;
  readonly signupUrl: string;

  // Auth & endpoints
  readonly envVars: readonly string[];
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly authType: AuthType;
  readonly supportsHealthCheck: boolean;

  // Model catalog
  readonly fallbackModels: readonly string[];
  readonly hostname: string;

  // Client-level quirks
  readonly defaultHeaders: Record<string, string>;

  // Request-level quirks
  readonly fixedTemperature: number | OmitTemperature | null;
  readonly defaultMaxTokens: number | null;
  readonly defaultAuxModel: string;

  constructor(options: ProviderProfileOptions) {
    this.name = options.name;
    this.apiMode = options.apiMode ?? "chat_completions";
    this.aliases = options.aliases ?? [];

    this.displayName = options.displayName ?? "";
    this.description = options.description ?? "";
    this.signupUrl = options.signupUrl ?? "";

    this.envVars = options.envVars ?? [];
    this.baseUrl = options.baseUrl ?? "";
    this.modelsUrl = options.modelsUrl ?? "";
    this.authType = options.authType ?? "api_key";
    this.supportsHealthCheck = options.supportsHealthCheck ?? true;

    this.fallbackModels = options.fallbackModels ?? [];
    this.hostname = options.hostname ?? "";

    this.defaultHeaders = options.defaultHeaders ?? {};

    this.fixedTemperature = options.fixedTemperature ?? null;
    this.defaultMaxTokens = options.defaultMaxTokens ?? null;
    this.defaultAuxModel = options.defaultAuxModel ?? "";
  }

  /**
   * Return the provider's base hostname for URL-based detection.
   *
   * Uses `this.hostname` if set explicitly, otherwise derives it from
   * `baseUrl`. Returns `""` when neither is available — matches upstream
   * `urlparse(self.base_url).hostname or ""`.
   */
  getHostname(): string {
    if (this.hostname) {
      return this.hostname;
    }
    if (this.baseUrl) {
      try {
        return new URL(this.baseUrl).hostname || "";
      } catch {
        return "";
      }
    }
    return "";
  }

  /**
   * Provider-specific message preprocessing.
   *
   * Called AFTER codex field sanitization, BEFORE developer role swap.
   * Default: pass-through (returns same reference to match upstream identity).
   */
  prepareMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return messages;
  }

  /**
   * Provider-specific `extra_body` fields. Merged into the API kwargs
   * `extra_body`. Default: empty object.
   */
  buildExtraBody(_context: BuildExtraBodyContext = {}): Record<string, unknown> {
    return {};
  }

  /**
   * Provider-specific kwargs split between `extra_body` and top-level
   * api_kwargs.
   *
   * Returns `[extraBodyAdditions, topLevelKwargs]`. The transport merges
   * `extraBodyAdditions` into `extra_body`, and `topLevelKwargs` directly
   * into api_kwargs.
   *
   * Default: `[{}, {}]`.
   */
  buildApiKwargsExtras(_context: BuildApiKwargsContext = {}): ApiKwargsExtras {
    return [{}, {}];
  }

  /**
   * Fetch the live model list from the provider's models endpoint.
   *
   * Returns a list of model ID strings, or `null` if the fetch failed or
   * the provider does not support live model listing.
   *
   * Resolution order for the endpoint URL:
   *   1. `this.modelsUrl`  (explicit override)
   *   2. `this.baseUrl + "/models"`  (standard OpenAI-compat fallback)
   *
   * Sends Bearer auth when `apiKey` is given, forwards `defaultHeaders`,
   * and sets a non-default `User-Agent` to defeat WAF UA blocks.
   *
   * Override for providers that need a custom catalog path or no REST
   * catalog at all.
   */
  async fetchModels(
    options: { apiKey?: string | null; timeoutMs?: number } = {},
  ): Promise<string[] | null> {
    const { apiKey = null, timeoutMs = 8000 } = options;

    let url = this.modelsUrl.trim();
    if (!url) {
      if (!this.baseUrl) {
        return null;
      }
      url = `${this.baseUrl.replace(/\/+$/, "")}/models`;
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": _profileUserAgent(),
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    for (const [k, v] of Object.entries(this.defaultHeaders)) {
      headers[k] = v;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(url, { headers, signal: controller.signal });
    } catch (exc) {
      clearTimeout(timer);
      logger.debug(`fetchModels(${this.name}): ${String(exc)}`);
      return null;
    }
    clearTimeout(timer);

    if (!resp.ok) {
      logger.debug(`fetchModels(${this.name}): HTTP ${resp.status}`);
      return null;
    }

    let data: unknown;
    try {
      data = await resp.json();
    } catch (exc) {
      logger.debug(`fetchModels(${this.name}): ${String(exc)}`);
      return null;
    }

    const items: unknown[] = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.data)
        ? data.data
        : [];
    const result: string[] = [];
    for (const item of items) {
      if (isRecord(item) && typeof item.id === "string") {
        result.push(item.id);
      }
    }
    return result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
