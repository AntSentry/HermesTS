// Ported from upstream secret_sources/__init__.py (package marker only).

import { describe, expect, test } from "vitest";

import { SECRET_SOURCES_DESCRIPTION } from "../src/secret-sources/index.js";

describe("SECRET_SOURCES_DESCRIPTION", () => {
  test("documents the non-destructive loading contract", () => {
    expect(SECRET_SOURCES_DESCRIPTION).toContain("AFTER ~/.hermes/.env loads");
    expect(SECRET_SOURCES_DESCRIPTION).toContain("Non-destructive");
  });
});
