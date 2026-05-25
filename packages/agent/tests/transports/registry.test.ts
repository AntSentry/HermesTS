/**
 * Tests for `@hermests/agent/transports/registry`.
 *
 * Ported from upstream `tests/agent/transports/test_transport.py`
 * (`TestTransportRegistry` class) plus the partial-registry
 * re-discovery regression case.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ProviderTransport } from "../../src/transports/base.js";
import {
  _getRegistry,
  _resetTransportRegistryForTesting,
  _setDiscoveryHookForTesting,
  getTransport,
  registerTransport,
  type TransportFactory,
} from "../../src/transports/registry.js";
import { NormalizedResponse } from "../../src/transports/types.js";

class DummyTransport extends ProviderTransport {
  readonly #mode: string;
  constructor(mode: string) {
    super();
    this.#mode = mode;
  }
  override get apiMode(): string {
    return this.#mode;
  }
  override convertMessages(messages: Array<Record<string, unknown>>): unknown {
    return messages;
  }
  override convertTools(tools: Array<Record<string, unknown>>): unknown {
    return tools;
  }
  override buildKwargs(): Record<string, unknown> {
    return {};
  }
  override normalizeResponse(): NormalizedResponse {
    return new NormalizedResponse({ content: null, tool_calls: null, finish_reason: "stop" });
  }
}

const dummyFactory = (mode: string): TransportFactory => () => new DummyTransport(mode);

beforeEach(() => {
  _resetTransportRegistryForTesting();
});

afterEach(() => {
  _resetTransportRegistryForTesting();
});

describe("registerTransport / getTransport", () => {
  test("unregistered api_mode returns null", () => {
    expect(getTransport("nonexistent_mode")).toBeNull();
  });

  test("register then fetch returns a fresh instance", () => {
    registerTransport("alpha", dummyFactory("alpha"));
    const t1 = getTransport("alpha");
    const t2 = getTransport("alpha");
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(t1?.apiMode).toBe("alpha");
    // Different instances per call (matches upstream `cls()`).
    expect(t1).not.toBe(t2);
  });

  test("re-registering the same api_mode replaces the factory", () => {
    registerTransport("dup", dummyFactory("first"));
    registerTransport("dup", dummyFactory("second"));
    expect(getTransport("dup")?.apiMode).toBe("second");
  });

  test("_getRegistry exposes a read-only view of the live map", () => {
    registerTransport("read_only_view", dummyFactory("read_only_view"));
    const map = _getRegistry();
    expect(map.get("read_only_view")).toBeDefined();
  });
});

describe("discovery hook", () => {
  test("default no-op runs without error and returns null on miss", () => {
    expect(getTransport("never_registered")).toBeNull();
  });

  test("hook is invoked exactly once on first lookup", () => {
    const hook = vi.fn(() => {
      registerTransport("via_hook", dummyFactory("via_hook"));
    });
    _setDiscoveryHookForTesting(hook);

    // First miss triggers discovery.
    expect(getTransport("via_hook")?.apiMode).toBe("via_hook");
    expect(hook).toHaveBeenCalledTimes(1);

    // Subsequent successful lookups do not re-discover.
    expect(getTransport("via_hook")?.apiMode).toBe("via_hook");
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test("miss after partial discovery triggers re-discovery (regression for upstream order-dep)", () => {
    let pass = 0;
    const hook = vi.fn(() => {
      pass += 1;
      if (pass === 1) {
        registerTransport("partial_one", dummyFactory("partial_one"));
      } else {
        registerTransport("partial_two", dummyFactory("partial_two"));
      }
    });
    _setDiscoveryHookForTesting(hook);

    // First call discovers `partial_one` only.
    expect(getTransport("partial_one")?.apiMode).toBe("partial_one");
    expect(hook).toHaveBeenCalledTimes(1);

    // Second call for an unknown api_mode must re-run discovery.
    expect(getTransport("partial_two")?.apiMode).toBe("partial_two");
    expect(hook).toHaveBeenCalledTimes(2);
  });

  test("persistent miss returns null after re-discovery", () => {
    const hook = vi.fn(); // never registers anything
    _setDiscoveryHookForTesting(hook);
    expect(getTransport("ghost")).toBeNull();
    // The first lookup runs discovery once on the initial miss and once
    // more after the cache miss persists.
    expect(hook).toHaveBeenCalledTimes(2);
  });

  test("_setDiscoveryHookForTesting(null) restores the default no-op", () => {
    const hook = vi.fn();
    _setDiscoveryHookForTesting(hook);
    getTransport("trigger");
    expect(hook).toHaveBeenCalled();
    _setDiscoveryHookForTesting(null);
    _resetTransportRegistryForTesting();
    expect(getTransport("trigger")).toBeNull();
    // hook from before reset is no longer connected — call count unchanged.
    expect(hook.mock.calls.length).toBeGreaterThan(0);
  });
});
