/**
 * Lightweight internationalization (i18n) for Hermes static user-facing
 * messages.
 *
 * Faithful port of upstream `agent/i18n.py`.
 *
 * Catalog files live under `locales/<lang>.yaml` at the repo root. Each
 * catalog is a flat dict keyed by dotted paths (e.g. `approval.choose`
 * or `gateway.approval_expired`). Missing keys fall back to English; if
 * English is missing too, the key path itself is returned so a broken
 * catalog never crashes the agent.
 *
 * Language resolution order:
 *   1. Explicit `lang=` argument passed to `t`
 *   2. `HERMES_LANGUAGE` env var
 *   3. `display.language` from config.yaml (read via injected provider)
 *   4. `"en"` (baseline)
 *
 * Faithful divergences:
 *   - Upstream computes the locales directory as `Path(__file__).parent.parent
 *     / "locales"`. In TS the agent package lives at
 *     `packages/agent/src/i18n.ts`; the locales directory still lives at the
 *     repo root, so the climb is one more level. `setLocalesDirOverride`
 *     gives tests and downstream callers a seam to point at a fixture dir.
 *   - Upstream lazy-imports `from hermes_cli.config import load_config` to
 *     read `display.language`. The cli package is downstream, so we use a
 *     `ConfigLanguageProvider` callback set via
 *     `setConfigLanguageProvider`. Default: returns null.
 *   - Upstream uses `threading.Lock` to serialize cache writes. Node is
 *     single-threaded; the lock is dropped.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getLogger } from "@hermests/core";
import { parse as parseYaml } from "yaml";

const logger = getLogger("agent.i18n");

export const SUPPORTED_LANGUAGES: readonly string[] = [
  "en",
  "zh",
  "zh-hant",
  "ja",
  "de",
  "es",
  "fr",
  "tr",
  "uk",
  "af",
  "ko",
  "it",
  "ga",
  "pt",
  "ru",
  "hu",
];

export const DEFAULT_LANGUAGE = "en";

const SUPPORTED_SET = new Set(SUPPORTED_LANGUAGES);

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  english: "en",
  "en-us": "en",
  "en-gb": "en",
  chinese: "zh",
  mandarin: "zh",
  "zh-cn": "zh",
  "zh-hans": "zh",
  "zh-sg": "zh",
  "traditional-chinese": "zh-hant",
  traditional_chinese: "zh-hant",
  "zh-tw": "zh-hant",
  "zh-hk": "zh-hant",
  "zh-mo": "zh-hant",
  japanese: "ja",
  jp: "ja",
  "ja-jp": "ja",
  german: "de",
  deutsch: "de",
  "de-de": "de",
  "de-at": "de",
  "de-ch": "de",
  spanish: "es",
  español: "es",
  espanol: "es",
  "es-es": "es",
  "es-mx": "es",
  "es-ar": "es",
  french: "fr",
  français: "fr",
  france: "fr",
  "fr-fr": "fr",
  "fr-be": "fr",
  "fr-ca": "fr",
  "fr-ch": "fr",
  ukrainian: "uk",
  ukrainisch: "uk",
  українська: "uk",
  "uk-ua": "uk",
  ua: "uk",
  turkish: "tr",
  türkçe: "tr",
  "tr-tr": "tr",
  afrikaans: "af",
  "af-za": "af",
  korean: "ko",
  한국어: "ko",
  "ko-kr": "ko",
  italian: "it",
  italiano: "it",
  "it-it": "it",
  "it-ch": "it",
  irish: "ga",
  gaeilge: "ga",
  "ga-ie": "ga",
  portuguese: "pt",
  português: "pt",
  portugues: "pt",
  "pt-pt": "pt",
  "pt-br": "pt",
  brazilian: "pt",
  brasileiro: "pt",
  russian: "ru",
  русский: "ru",
  "ru-ru": "ru",
  hungarian: "hu",
  magyar: "hu",
  "hu-hu": "hu",
};

const _catalogCache: Map<string, Record<string, string>> = new Map();

// ── DI seams ────────────────────────────────────────────────────────────

export type ConfigLanguageProvider = () => string | null;

let _configLanguageProvider: ConfigLanguageProvider | null = null;
let _cachedConfigLang: string | null | undefined;

/**
 * Override the cli config language reader. The cli package wires
 * `cfg.display.language` here at load time; default returns null.
 */
export function setConfigLanguageProvider(fn: ConfigLanguageProvider): void {
  _configLanguageProvider = fn;
  _cachedConfigLang = undefined;
}

let _localesDirOverride: string | null = null;

/** Test-only: override the locales directory. Pass `null` to restore. */
export function setLocalesDirOverride(path: string | null): void {
  _localesDirOverride = path;
}

function localesDir(): string {
  if (_localesDirOverride !== null) {
    return _localesDirOverride;
  }
  // packages/agent/src/i18n.ts -> packages/agent/src -> packages/agent ->
  // packages -> <repo root>/locales
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "locales");
}

function normalizeLang(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_LANGUAGE;
  }
  const key = value.trim().toLowerCase();
  if (!key) {
    return DEFAULT_LANGUAGE;
  }
  if (SUPPORTED_SET.has(key)) {
    return key;
  }
  if (key in LANGUAGE_ALIASES) {
    return LANGUAGE_ALIASES[key]!;
  }
  const dashIdx = key.indexOf("-");
  if (dashIdx > 0) {
    const base = key.slice(0, dashIdx);
    if (SUPPORTED_SET.has(base)) {
      return base;
    }
  }
  return DEFAULT_LANGUAGE;
}

function flattenInto(node: unknown, prefix: string, out: Record<string, string>): void {
  if (node === null || node === undefined) {
    return;
  }
  if (typeof node === "object" && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childKey = prefix ? `${prefix}.${key}` : String(key);
      flattenInto(value, childKey, out);
    }
    return;
  }
  if (typeof node === "string") {
    out[prefix] = node;
  }
  // Non-string, non-dict leaves ignored — catalogs are text-only.
}

function loadCatalog(lang: string): Record<string, string> {
  const cached = _catalogCache.get(lang);
  if (cached !== undefined) {
    return cached;
  }

  const path = join(localesDir(), `${lang}.yaml`);
  if (!existsSync(path)) {
    logger.debug(`i18n catalog missing for ${lang} at ${path}`);
    _catalogCache.set(lang, {});
    return {};
  }

  let raw: unknown;
  try {
    const text = readFileSync(path, "utf-8");
    raw = parseYaml(text) ?? {};
  } catch (exc) {
    logger.warning(`Failed to load i18n catalog ${path}: ${(exc as Error).message}`);
    _catalogCache.set(lang, {});
    return {};
  }

  const flat: Record<string, string> = {};
  flattenInto(raw, "", flat);
  _catalogCache.set(lang, flat);
  return flat;
}

function configLanguage(): string | null {
  if (_cachedConfigLang !== undefined) {
    return _cachedConfigLang;
  }
  if (_configLanguageProvider === null) {
    _cachedConfigLang = null;
    return null;
  }
  try {
    const raw = _configLanguageProvider();
    if (raw) {
      _cachedConfigLang = normalizeLang(raw);
      return _cachedConfigLang;
    }
  } catch (exc) {
    logger.debug(`Could not read display.language from config: ${(exc as Error).message}`);
  }
  _cachedConfigLang = null;
  return null;
}

/** Invalidate cached language resolution and catalogs. */
export function resetLanguageCache(): void {
  _catalogCache.clear();
  _cachedConfigLang = undefined;
}

/** Resolve the active language using env > config > default order. */
export function getLanguage(): string {
  const envLang = process.env.HERMES_LANGUAGE;
  if (envLang) {
    return normalizeLang(envLang);
  }
  const cfgLang = configLanguage();
  if (cfgLang) {
    return cfgLang;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Translate a dotted key to the active language.
 *
 * `formatKwargs` mirrors Python's `str.format(**kwargs)` — substitutes
 * `{name}` placeholders in the catalog value. Format failures are
 * logged at WARNING and the unformatted string is returned, matching
 * upstream's behavior.
 */
export function t(
  key: string,
  lang: string | null = null,
  formatKwargs: Record<string, unknown> | null = null,
): string {
  const target = lang !== null ? normalizeLang(lang) : getLanguage();
  const catalog = loadCatalog(target);
  let value: string | undefined = catalog[key];

  if (value === undefined && target !== DEFAULT_LANGUAGE) {
    value = loadCatalog(DEFAULT_LANGUAGE)[key];
  }

  if (value === undefined) {
    logger.debug(`i18n miss: key=${JSON.stringify(key)} lang=${JSON.stringify(target)}`);
    value = key;
  }

  if (formatKwargs && Object.keys(formatKwargs).length > 0) {
    try {
      return formatString(value, formatKwargs);
    } catch (exc) {
      logger.warning(
        `i18n format failed for key=${JSON.stringify(key)} lang=${JSON.stringify(target)}` +
          ` kwargs=${JSON.stringify(formatKwargs)}: ${(exc as Error).message}`,
      );
      return value;
    }
  }
  return value;
}

/**
 * Substitute `{name}` placeholders. Unknown placeholders throw to match
 * Python's `str.format` raising `KeyError` — caught by `t()` and logged.
 */
function formatString(template: string, kwargs: Record<string, unknown>): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, raw: string) => {
    if (!(raw in kwargs)) {
      throw new Error(`KeyError: '${raw}'`);
    }
    const v = kwargs[raw];
    return v === null || v === undefined ? "" : String(v);
  });
}

