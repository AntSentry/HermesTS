import { afterEach, describe, expect, it } from "vitest";
import type { OpenAIClient } from "../../src/_internal/openai-client-shape.js";
import {
  registerOpenAIClient,
  resetOpenAIClientFactory,
  setOpenAIClientFactory,
} from "../../src/_internal/sibling-stubs.js";
import { OpenAI, isOpenAIClient } from "../../src/auxiliary-client/openai-proxy.js";

afterEach(() => {
  resetOpenAIClientFactory();
});

function makeFakeClient(): OpenAIClient {
  return {
    chat: { completions: { create: () => ({ choices: [], model: "fake" }) } },
    api_key: "fake-key",
    base_url: "https://fake.example/v1",
  };
}

describe("OpenAI proxy", () => {
  it("throws when no factory is registered", () => {
    expect(() => OpenAI()).toThrow(/factory not registered/);
  });

  it("forwards options to the registered factory and returns its client", () => {
    let received: unknown;
    const fake = makeFakeClient();
    setOpenAIClientFactory((opts) => {
      received = opts;
      return fake;
    });
    const client = OpenAI({ api_key: "k", base_url: "https://b" });
    expect(client).toBe(fake);
    expect(received).toEqual({ api_key: "k", base_url: "https://b" });
  });

  it("isOpenAIClient is true for clients minted by OpenAI()", () => {
    setOpenAIClientFactory(() => makeFakeClient());
    const a = OpenAI();
    expect(isOpenAIClient(a)).toBe(true);
  });

  it("isOpenAIClient is false for unregistered objects", () => {
    setOpenAIClientFactory(() => makeFakeClient());
    expect(isOpenAIClient({})).toBe(false);
    expect(isOpenAIClient(null)).toBe(false);
    expect(isOpenAIClient(undefined)).toBe(false);
    expect(isOpenAIClient("string")).toBe(false);
    expect(isOpenAIClient(42)).toBe(false);
  });

  it("registerOpenAIClient lets tests mark an existing object as OpenAI-shaped", () => {
    const adopted = makeFakeClient();
    expect(isOpenAIClient(adopted)).toBe(false);
    registerOpenAIClient(adopted);
    expect(isOpenAIClient(adopted)).toBe(true);
  });

  it("reset clears the identity registry AND restores the throwing default", () => {
    setOpenAIClientFactory(() => makeFakeClient());
    const a = OpenAI();
    expect(isOpenAIClient(a)).toBe(true);
    resetOpenAIClientFactory();
    expect(isOpenAIClient(a)).toBe(false);
    // After reset, calling OpenAI() must throw the same error as a fresh
    // module load — verifies the reset lambda body is exercised.
    expect(() => OpenAI()).toThrow(/factory not registered/);
  });

  it("factory returns non-object values without registering identity", () => {
    setOpenAIClientFactory(() => null as unknown as OpenAIClient);
    const v = OpenAI();
    expect(v).toBeNull();
    expect(isOpenAIClient(v)).toBe(false);
  });
});
