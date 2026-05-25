// Ported from upstream process_bootstrap.py exercises.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  SafeWriter,
  getProxyForBaseUrl,
  getProxyFromEnv,
  installSafeStdio,
  uninstallSafeStdio,
} from "../src/process-bootstrap.js";

const ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
  uninstallSafeStdio();
});

describe("getProxyFromEnv", () => {
  test("returns null when no proxy set", () => {
    expect(getProxyFromEnv()).toBe(null);
  });

  test("reads HTTPS_PROXY first", () => {
    process.env.HTTPS_PROXY = "http://p:3128";
    process.env.HTTP_PROXY = "http://other:8080";
    expect(getProxyFromEnv()).toBe("http://p:3128");
  });

  test("falls back to HTTP_PROXY when HTTPS_PROXY unset", () => {
    process.env.HTTP_PROXY = "http://x:8080";
    expect(getProxyFromEnv()).toBe("http://x:8080");
  });

  test("checks ALL_PROXY last", () => {
    process.env.ALL_PROXY = "socks5://s:1080";
    expect(getProxyFromEnv()).toBe("socks5://s:1080");
  });

  test("trims whitespace from env value", () => {
    process.env.HTTPS_PROXY = "  http://p:3128  ";
    expect(getProxyFromEnv()).toBe("http://p:3128");
  });

  test("empty/whitespace env value falls through", () => {
    process.env.HTTPS_PROXY = "   ";
    process.env.HTTP_PROXY = "http://second:80";
    expect(getProxyFromEnv()).toBe("http://second:80");
  });

  test("lowercase variants also recognized", () => {
    process.env.https_proxy = "http://lower:3128";
    expect(getProxyFromEnv()).toBe("http://lower:3128");
  });
});

describe("getProxyForBaseUrl", () => {
  test("returns the env proxy when no NO_PROXY set", () => {
    process.env.HTTPS_PROXY = "http://p:3128";
    expect(getProxyForBaseUrl("https://example.com")).toBe("http://p:3128");
  });

  test("returns null when no proxy in env regardless of NO_PROXY", () => {
    process.env.NO_PROXY = "example.com";
    expect(getProxyForBaseUrl("https://example.com")).toBe(null);
  });

  test("returns null when no baseUrl supplied", () => {
    process.env.HTTPS_PROXY = "http://p:3128";
    expect(getProxyForBaseUrl(null)).toBe("http://p:3128");
    expect(getProxyForBaseUrl(undefined)).toBe("http://p:3128");
    expect(getProxyForBaseUrl("")).toBe("http://p:3128");
  });

  test("returns proxy when baseUrl has no parseable host", () => {
    process.env.HTTPS_PROXY = "http://p:3128";
    // Whitespace-only baseUrl makes baseUrlHostname return "" via the
    // early `!raw` branch, hitting the `!host` short-circuit.
    expect(getProxyForBaseUrl("   ")).toBe("http://p:3128");
  });

  test("'*' bypasses everything", () => {
    process.env.HTTPS_PROXY = "http://p:3128";
    process.env.NO_PROXY = "*";
    expect(getProxyForBaseUrl("https://example.com")).toBe(null);
  });

  test("leading-dot pattern matches suffix and exact base", () => {
    process.env.HTTPS_PROXY = "http://p:3128";
    process.env.NO_PROXY = ".example.com";
    expect(getProxyForBaseUrl("https://api.example.com")).toBe(null);
    expect(getProxyForBaseUrl("https://example.com")).toBe(null);
    expect(getProxyForBaseUrl("https://other.com")).toBe("http://p:3128");
  });

  test("plain-host pattern matches exact and subdomain", () => {
    process.env.HTTPS_PROXY = "http://p:3128";
    process.env.NO_PROXY = "example.com";
    expect(getProxyForBaseUrl("https://api.example.com")).toBe(null);
    expect(getProxyForBaseUrl("https://example.com")).toBe(null);
    expect(getProxyForBaseUrl("https://other.com")).toBe("http://p:3128");
  });

  test("comma-separated patterns each work", () => {
    process.env.HTTPS_PROXY = "http://p:3128";
    process.env.NO_PROXY = "foo.com, bar.com";
    expect(getProxyForBaseUrl("https://bar.com")).toBe(null);
  });

  test("no_proxy lowercase env recognized", () => {
    process.env.HTTPS_PROXY = "http://p:3128";
    process.env.no_proxy = "example.com";
    expect(getProxyForBaseUrl("https://example.com")).toBe(null);
  });

  test("NO_PROXY empty falls through (no bypass)", () => {
    process.env.HTTPS_PROXY = "http://p:3128";
    process.env.NO_PROXY = "   ";
    expect(getProxyForBaseUrl("https://example.com")).toBe("http://p:3128");
  });
});

describe("SafeWriter and installSafeStdio", () => {
  test("install/uninstall idempotent", () => {
    installSafeStdio();
    installSafeStdio();
    uninstallSafeStdio();
    uninstallSafeStdio();
  });

  test("SafeWriter.install is idempotent on a single instance", () => {
    const inner = {
      write: vi.fn((_d: string | Uint8Array, _cb?: (err?: Error | null) => void): boolean => true),
    };
    const safe = new SafeWriter(inner);
    safe.install();
    const wrapped = inner.write;
    safe.install(); // second install should no-op (early-return branch)
    expect(inner.write).toBe(wrapped);
    safe.uninstall();
  });

  test("swallows EPIPE on write", () => {
    const inner = {
      write: vi.fn((_data: string | Uint8Array, _cb?: (err?: Error | null) => void) => {
        const err = new Error("broken") as NodeJS.ErrnoException;
        err.code = "EPIPE";
        throw err;
      }),
    };
    const safe = new SafeWriter(inner);
    safe.install();
    const cb = vi.fn();
    expect(inner.write("hi", cb)).toBe(true);
    expect(cb).toHaveBeenCalledOnce();
    safe.uninstall();
  });

  test("propagates unrelated errors", () => {
    const inner = {
      write: vi.fn((_data: string | Uint8Array, _cb?: (err?: Error | null) => void): boolean => {
        throw new Error("totally different");
      }),
    };
    const safe = new SafeWriter(inner);
    safe.install();
    expect(() => inner.write("hi")).toThrow("totally different");
    safe.uninstall();
  });

  test("passes through successful writes", () => {
    const inner = {
      write: vi.fn((_data: string | Uint8Array, _cb?: (err?: Error | null) => void): boolean => true),
    };
    const safe = new SafeWriter(inner);
    safe.install();
    expect(inner.write("hi")).toBe(true);
    safe.uninstall();
  });

  test("uninstall restores original write", () => {
    const original = vi.fn(
      (_data: string | Uint8Array, _cb?: (err?: Error | null) => void): boolean => true,
    );
    const inner = { write: original };
    const safe = new SafeWriter(inner);
    safe.install();
    safe.uninstall();
    expect(inner.write).toBe(original);
  });

  test("uninstall is a no-op when not installed", () => {
    const inner = {
      write: vi.fn((_data: string | Uint8Array, _cb?: (err?: Error | null) => void): boolean => true),
    };
    const safe = new SafeWriter(inner);
    safe.uninstall(); // not installed yet — must not throw
    expect(inner.write).toBeDefined();
  });

  test("swallows write error without callback", () => {
    const inner = {
      write: vi.fn((_data: string | Uint8Array, _cb?: (err?: Error | null) => void): boolean => {
        const err = new Error("eio") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }),
    };
    const safe = new SafeWriter(inner);
    safe.install();
    expect(inner.write("hi")).toBe(true);
    safe.uninstall();
  });
});
