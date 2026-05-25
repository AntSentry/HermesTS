// Ported tests for upstream `agent/i18n.py` (no dedicated upstream
// test file — covered by gateway/CLI integration tests).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  getLanguage,
  resetLanguageCache,
  setConfigLanguageProvider,
  setLocalesDirOverride,
  t,
} from "../src/i18n.js";

let localesDir: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  localesDir = mkdtempSync(join(tmpdir(), "hermests-i18n-"));
  setLocalesDirOverride(localesDir);
  delete process.env.HERMES_LANGUAGE;
  resetLanguageCache();
});

afterEach(() => {
  setLocalesDirOverride(null);
  resetLanguageCache();
  try {
    rmSync(localesDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.env = { ...originalEnv };
});

describe("SUPPORTED_LANGUAGES constants", () => {
  test("includes the documented base set", () => {
    for (const lang of ["en", "zh", "ja", "de", "es", "fr"]) {
      expect(SUPPORTED_LANGUAGES).toContain(lang);
    }
    expect(DEFAULT_LANGUAGE).toBe("en");
  });
});

describe("default localesDir (no override)", () => {
  test("uses repo-root locales path when override is null", () => {
    // Clearing the override forces the import.meta.url path resolution
    // — pin that branch even though the dir likely doesn't exist in the
    // test workspace yet.
    setLocalesDirOverride(null);
    // Catalog miss for "en" → returns the key verbatim (default loader
    // sees a non-existent dir and emits an empty catalog).
    expect(t("never.exists.in.repo")).toBe("never.exists.in.repo");
  });
});

describe("getLanguage", () => {
  test("defaults to 'en' when no env or config set", () => {
    expect(getLanguage()).toBe("en");
  });

  test("respects HERMES_LANGUAGE env var", () => {
    process.env.HERMES_LANGUAGE = "fr";
    expect(getLanguage()).toBe("fr");
  });

  test("normalizes unknown env var to default", () => {
    process.env.HERMES_LANGUAGE = "klingon";
    expect(getLanguage()).toBe("en");
  });

  test("config provider takes effect when env unset", () => {
    setConfigLanguageProvider(() => "ja");
    expect(getLanguage()).toBe("ja");
  });

  test("env wins over config provider", () => {
    setConfigLanguageProvider(() => "ja");
    process.env.HERMES_LANGUAGE = "de";
    expect(getLanguage()).toBe("de");
  });

  test("config provider returning null falls back to default", () => {
    setConfigLanguageProvider(() => null);
    expect(getLanguage()).toBe("en");
  });

  test("config provider throwing falls back to default", () => {
    setConfigLanguageProvider(() => {
      throw new Error("boom");
    });
    expect(getLanguage()).toBe("en");
  });

  test("aliases map: 'chinese' → 'zh'", () => {
    process.env.HERMES_LANGUAGE = "chinese";
    expect(getLanguage()).toBe("zh");
  });

  test("aliases map: 'zh-TW' → 'zh-hant' (case insensitive)", () => {
    process.env.HERMES_LANGUAGE = "zh-TW";
    expect(getLanguage()).toBe("zh-hant");
  });

  test("empty string env var falls through to default", () => {
    process.env.HERMES_LANGUAGE = "";
    expect(getLanguage()).toBe("en");
  });

  test("whitespace-only env var normalizes to default", () => {
    process.env.HERMES_LANGUAGE = "   ";
    expect(getLanguage()).toBe("en");
  });

  test("config provider returning whitespace string also normalizes to default", () => {
    setConfigLanguageProvider(() => "   ");
    expect(getLanguage()).toBe("en");
  });

  test("region-only suffix strips to base if supported", () => {
    process.env.HERMES_LANGUAGE = "ru-XX";
    expect(getLanguage()).toBe("ru");
  });

  test("region-only suffix returns default if base unsupported", () => {
    process.env.HERMES_LANGUAGE = "xx-YY";
    expect(getLanguage()).toBe("en");
  });
});

describe("t (translation lookup)", () => {
  test("missing catalog returns the key itself", () => {
    expect(t("nonexistent.key")).toBe("nonexistent.key");
  });

  test("looks up flattened key from YAML catalog", () => {
    writeFileSync(join(localesDir, "en.yaml"), "approval:\n  choose: Choose\n");
    expect(t("approval.choose")).toBe("Choose");
  });

  test("formats kwargs placeholders", () => {
    writeFileSync(join(localesDir, "en.yaml"), 'gateway:\n  drain: "Draining {count} sessions"\n');
    expect(t("gateway.drain", null, { count: 3 })).toBe("Draining 3 sessions");
  });

  test("fallback to English when target language missing the key", () => {
    writeFileSync(join(localesDir, "en.yaml"), "alpha: english\n");
    writeFileSync(join(localesDir, "fr.yaml"), "beta: francais\n");
    expect(t("alpha", "fr")).toBe("english");
  });

  test("explicit lang overrides env/config", () => {
    process.env.HERMES_LANGUAGE = "fr";
    writeFileSync(join(localesDir, "en.yaml"), "hello: hi\n");
    writeFileSync(join(localesDir, "fr.yaml"), "hello: salut\n");
    expect(t("hello")).toBe("salut");
    expect(t("hello", "en")).toBe("hi");
  });

  test("format failure returns the unformatted template", () => {
    writeFileSync(join(localesDir, "en.yaml"), 'item: "There are {count} items"\n');
    // Missing kwarg `count` raises during format → caller falls back to template.
    expect(t("item", null, { other: 1 })).toBe("There are {count} items");
  });

  test("non-string YAML leaves are ignored (treated as missing)", () => {
    writeFileSync(localesDir + "/en.yaml", "answer: 42\n");
    expect(t("answer")).toBe("answer");
  });

  test("nested map flattens to dotted keys", () => {
    writeFileSync(
      localesDir + "/en.yaml",
      "level1:\n  level2:\n    level3: deep\n",
    );
    expect(t("level1.level2.level3")).toBe("deep");
  });

  test("malformed YAML logs warning and treats catalog as empty", () => {
    writeFileSync(localesDir + "/en.yaml", ": : :\n");
    expect(t("anything")).toBe("anything");
  });

  test("empty YAML body treated as empty catalog", () => {
    writeFileSync(localesDir + "/en.yaml", "");
    expect(t("any.key")).toBe("any.key");
  });

  test("catalog cached across calls (write after first miss is invisible until reset)", () => {
    expect(t("a.b")).toBe("a.b");
    writeFileSync(localesDir + "/en.yaml", "a:\n  b: value\n");
    expect(t("a.b")).toBe("a.b");
    resetLanguageCache();
    expect(t("a.b")).toBe("value");
  });

  test("formatKwargs with null value substitutes empty string", () => {
    writeFileSync(localesDir + "/en.yaml", 'greet: "Hello {name}"\n');
    expect(t("greet", null, { name: null })).toBe("Hello ");
  });

  test("non-string lang arg falls to default (no throw)", () => {
    writeFileSync(localesDir + "/en.yaml", "x: one\n");
    expect(t("x", 42 as unknown as string)).toBe("one");
  });

  test("non-object reasoning_config-shaped lang arg returns default catalog miss", () => {
    expect(t("missing", "unknown-lang-tag")).toBe("missing");
  });

  test("YAML keys with null value are flattened as missing", () => {
    writeFileSync(localesDir + "/en.yaml", "a:\n  empty_key:\nb: value\n");
    expect(t("a.empty_key")).toBe("a.empty_key");
    expect(t("b")).toBe("value");
  });
});
