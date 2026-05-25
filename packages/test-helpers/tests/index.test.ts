import { describe, it, expect } from "vitest";
import * as barrel from "../src/index.js";

describe("@hermests/test-helpers barrel", () => {
  it("re-exports every helper class", () => {
    expect(typeof barrel.MockLogger).toBe("function");
    expect(typeof barrel.MockClock).toBe("function");
    expect(typeof barrel.MockFs).toBe("function");
    expect(typeof barrel.MockProvider).toBe("function");
    expect(typeof barrel.MockSubprocess).toBe("function");
    expect(typeof barrel.AssertionError).toBe("function");
  });
});
