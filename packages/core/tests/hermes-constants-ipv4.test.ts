// Ported from tests/test_ipv4_preference.py — TestApplyIPv4Preference only.
// TestConfigDefault depends on hermes_cli.config.DEFAULT_CONFIG and is
// deferred to task #14 per docs/deferred-tests.md.

import nodeDns from "node:dns";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyIpv4Preference } from "../src/hermes-constants.js";

const dns = nodeDns;
let originalLookup: typeof dns.lookup;

beforeEach(() => {
  originalLookup = dns.lookup;
});

afterEach(() => {
  Object.defineProperty(dns, "lookup", {
    configurable: true,
    writable: true,
    value: originalLookup,
  });
});

describe("applyIpv4Preference — Node dns.lookup patch", () => {
  test("force=false is a no-op", () => {
    const before = dns.lookup;
    applyIpv4Preference(false);
    expect(dns.lookup).toBe(before);
  });

  test("force=true patches dns.lookup with marker", () => {
    applyIpv4Preference(true);
    expect((dns.lookup as { _hermesIpv4Patched?: boolean })._hermesIpv4Patched).toBe(
      true,
    );
  });

  test("double-patch is safe (no re-wrap)", () => {
    applyIpv4Preference(true);
    const first = dns.lookup;
    applyIpv4Preference(true);
    expect(dns.lookup).toBe(first);
  });

  test("family-zero (unspecified) becomes family-4 in object form", () => {
    const observed: Array<number | string | undefined> = [];
    const stub = ((
      _h: string,
      opts: { family?: number | string },
      cb: (err: Error | null, addr: string, fam?: number) => void,
    ) => {
      observed.push(opts.family);
      cb(null, "127.0.0.1", 4);
    }) as unknown as typeof dns.lookup;
    Object.defineProperty(dns, "lookup", {
      configurable: true,
      writable: true,
      value: stub,
    });
    applyIpv4Preference(true);
    dns.lookup("example.com", { family: 0 }, () => undefined);
    expect(observed).toEqual([4]);
  });

  test("missing object family defaults to IPv4 preference", () => {
    const observed: Array<number | string | undefined> = [];
    const stub = ((
      _h: string,
      opts: { family?: number | string },
      cb: (err: Error | null, addr: string, fam?: number) => void,
    ) => {
      observed.push(opts.family);
      cb(null, "127.0.0.1", 4);
    }) as unknown as typeof dns.lookup;
    Object.defineProperty(dns, "lookup", {
      configurable: true,
      writable: true,
      value: stub,
    });
    applyIpv4Preference(true);
    // simulates AF_UNSPEC default-family call from hermes_constants.py:L393-432.
    dns.lookup("example.com", {}, () => undefined);
    expect(observed).toEqual([4]);
  });

  test("explicit AF_INET6 family is preserved (numeric form)", () => {
    const observed: number[] = [];
    const stub = ((
      _h: string,
      family: number,
      cb: (err: Error | null, addr: string, fam?: number) => void,
    ) => {
      observed.push(family);
      cb(null, "::1", 6);
    }) as unknown as typeof dns.lookup;
    Object.defineProperty(dns, "lookup", {
      configurable: true,
      writable: true,
      value: stub,
    });
    applyIpv4Preference(true);
    dns.lookup("example.com", 6, () => undefined);
    expect(observed).toEqual([6]);
  });

  test("explicit IPv4 string family is normalized and preserved", () => {
    const observed: Array<number | string | undefined> = [];
    const stub = ((
      _h: string,
      opts: { family?: number | string },
      cb: (err: Error | null, addr: string, fam?: number) => void,
    ) => {
      observed.push(opts.family);
      cb(null, "127.0.0.1", 4);
    }) as unknown as typeof dns.lookup;
    Object.defineProperty(dns, "lookup", {
      configurable: true,
      writable: true,
      value: stub,
    });
    applyIpv4Preference(true);
    // simulates Node string-family caller for hermes_constants.py:L393-432.
    dns.lookup("example.com", { family: "IPv4" }, () => undefined);
    expect(observed).toEqual(["IPv4"]);
  });

  test("fallback to original options on ENOTFOUND (pure-IPv6 host)", () => {
    const observedFamilies: Array<number | string | undefined> = [];
    const stub = ((
      _h: string,
      opts: { family?: number | string },
      cb: (
        err: NodeJS.ErrnoException | null,
        addr: string,
        fam?: number,
      ) => void,
    ) => {
      observedFamilies.push(opts.family);
      if (opts.family === 4) {
        const err = Object.assign(new Error("no A record"), {
          code: "ENOTFOUND",
        });
        cb(err as NodeJS.ErrnoException, "");
        return;
      }
      cb(null, "::1", 6);
    }) as unknown as typeof dns.lookup;
    Object.defineProperty(dns, "lookup", {
      configurable: true,
      writable: true,
      value: stub,
    });
    applyIpv4Preference(true);
    dns.lookup("ipv6only.example.com", { family: 0 }, () => undefined);
    expect(observedFamilies).toEqual([4, 0]);
  });
});
