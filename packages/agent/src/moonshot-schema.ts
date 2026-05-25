/**
 * Helpers for translating OpenAI-style tool schemas to Moonshot's schema subset.
 *
 * Faithful port of upstream `agent/moonshot_schema.py`.
 *
 * Moonshot (Kimi) accepts a stricter subset of JSON Schema than standard
 * OpenAI tool calling. Five known rejection modes are repaired here:
 *
 * 1. Every property schema must carry a `type`.
 * 2. When `anyOf` is used, `type` must be on the children, not the parent.
 * 3. `enum` arrays on scalar-typed nodes may not contain null or empty
 *    strings.
 * 4. `$ref` nodes may not carry sibling keywords.
 * 5. `items` may not be a tuple-style array; collapse to the first
 *    element schema.
 */

const SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
]);

const SCHEMA_LIST_KEYS: ReadonlySet<string> = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

const SCHEMA_NODE_KEYS: ReadonlySet<string> = new Set([
  "items",
  "contains",
  "not",
  "additionalProperties",
  "propertyNames",
]);

const SCALAR_TYPES_FOR_ENUM_CLEANUP: ReadonlySet<string> = new Set([
  "string",
  "integer",
  "number",
  "boolean",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepCloneJson<T>(value: T): T {
  // structuredClone keeps Date/Map/Set/etc. — for JSON-schema-shaped
  // input we accept the slight overhead in exchange for never mutating
  // caller-owned objects (matches upstream `copy.deepcopy`).
  return structuredClone(value);
}

/**
 * Recursively apply Moonshot repairs to a schema node. Upstream's
 * `is_schema=False` branch is reached only from the public wrapper
 * with True; we drop it as dead code in this faithful divergence.
 *
 * All recursive call sites filter via `isPlainObject` or `Array.isArray`
 * before invoking us, so the input is always a record.
 */
function repairSchema(node: Record<string, unknown>): Record<string, unknown> {
  // Walk the dict, deciding per-key whether recursion is into a schema
  // node, a container map, or a scalar.
  let repaired: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
      const inner: Record<string, unknown> = {};
      for (const [subKey, subVal] of Object.entries(value)) {
        inner[subKey] = isPlainObject(subVal) ? repairSchema(subVal) : subVal;
      }
      repaired[key] = inner;
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      repaired[key] = value.map((v) => (isPlainObject(v) ? repairSchema(v) : v));
    } else if (key === "items" && Array.isArray(value)) {
      // Rule 5: tuple-style `items` arrays are not accepted by
      // Moonshot. Collapse to the first element schema if present, else
      // to `{}`. Mirrors upstream `moonshot_schema.py:81-90`.
      const first = value.length > 0 ? value[0] : {};
      if (isPlainObject(first)) {
        repaired[key] = repairSchema(first);
      } else {
        repaired[key] = first;
      }
    } else if (SCHEMA_NODE_KEYS.has(key)) {
      if (isPlainObject(value)) {
        repaired[key] = repairSchema(value);
      } else {
        repaired[key] = value;
      }
    } else {
      repaired[key] = value;
    }
  }

  // Rule 2: when anyOf is present, type belongs only on the children.
  // Additionally Moonshot rejects null-type branches inside anyOf.
  // Collapse the anyOf to the non-null branches; if exactly one
  // remains, promote it and fall through to Rules 1/3 so nullable/enum
  // cleanup still applies. Matches `moonshot_schema.py:109-128`.
  const anyOfRaw = repaired.anyOf;
  if (Array.isArray(anyOfRaw)) {
    delete repaired.type;
    const anyOf = anyOfRaw;
    const nonNull = anyOf.filter(
      (b): b is Record<string, unknown> =>
        isPlainObject(b) && (b as Record<string, unknown>).type !== "null",
    );
    if (nonNull.length > 0 && nonNull.length < anyOf.length) {
      if (nonNull.length === 1) {
        const merge: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(repaired)) {
          if (k !== "anyOf") {
            merge[k] = v;
          }
        }
        const sole = nonNull[0] as Record<string, unknown>;
        for (const [k, v] of Object.entries(sole)) {
          merge[k] = v;
        }
        repaired = merge;
      } else {
        repaired.anyOf = nonNull;
        return repaired;
      }
    } else {
      return repaired;
    }
  }

  // Moonshot also rejects non-standard keywords like `nullable` on
  // parameter schemas — strip it. `moonshot_schema.py:132`.
  delete repaired.nullable;

  // Rule 1: property schemas without type need one. `$ref` nodes are
  // exempt — their type comes from the referenced definition. Fill
  // missing type BEFORE Rule 3 so enum cleanup can check the type.
  if (!("$ref" in repaired)) {
    repaired = fillMissingType(repaired);
  }

  // Rule 3: Moonshot rejects null/empty-string enum entries on scalar
  // types. Strip them, drop the enum if it becomes empty.
  if (Array.isArray(repaired.enum)) {
    const nodeType = repaired.type;
    if (typeof nodeType === "string" && SCALAR_TYPES_FOR_ENUM_CLEANUP.has(nodeType)) {
      const cleaned = (repaired.enum as unknown[]).filter((v) => v !== null && v !== "");
      if (cleaned.length > 0) {
        repaired.enum = cleaned;
      } else {
        delete repaired.enum;
      }
    }
  }

  // Rule 4: `$ref` nodes must not have sibling keywords. Strip every
  // sibling so only `{"$ref": "..."}` survives. `moonshot_schema.py:161-162`.
  if ("$ref" in repaired) {
    return { $ref: repaired.$ref };
  }

  return repaired;
}

/** Infer a reasonable `type` if this schema node has none. */
function fillMissingType(node: Record<string, unknown>): Record<string, unknown> {
  const existing = node.type;
  if (existing !== undefined && existing !== null && existing !== "") {
    return node;
  }

  let inferred: string;
  if ("properties" in node || "required" in node || "additionalProperties" in node) {
    inferred = "object";
  } else if ("items" in node || "prefixItems" in node) {
    inferred = "array";
  } else if (Array.isArray(node.enum) && (node.enum as unknown[]).length > 0) {
    const sample = (node.enum as unknown[])[0];
    if (typeof sample === "boolean") {
      inferred = "boolean";
    } else if (typeof sample === "number") {
      // JS doesn't distinguish int vs float at the language level.
      // Match Python by routing whole-number JSON values to integer.
      inferred = Number.isInteger(sample) ? "integer" : "number";
    } else {
      inferred = "string";
    }
  } else {
    inferred = "string";
  }

  return { ...node, type: inferred };
}

/**
 * Normalize tool parameters to a Moonshot-compatible object schema.
 *
 * Returns a deep-copied schema with the five flavored-JSON-Schema
 * repairs applied. Input is not mutated.
 */
export function sanitizeMoonshotToolParameters(parameters: unknown): Record<string, unknown> {
  if (!isPlainObject(parameters)) {
    return { type: "object", properties: {} };
  }

  // `repairSchema` returns a fresh object; the cast against the
  // declared return type is sound because we already filtered.
  const repaired = repairSchema(deepCloneJson(parameters));

  if (repaired.type !== "object") {
    repaired.type = "object";
  }
  if (!("properties" in repaired)) {
    repaired.properties = {};
  }

  return repaired;
}

/** Tool surface: matches upstream `[{type, function: {name, parameters}}, ...]`. */
export type MoonshotTool = {
  function?: { parameters?: unknown; [key: string]: unknown };
  [key: string]: unknown;
};

/**
 * Apply `sanitizeMoonshotToolParameters` to every tool's parameters.
 *
 * Returns the original array when nothing changed (matches upstream
 * `return sanitized if any_change else tools`) so callers can do
 * identity-equality short-circuiting.
 */
export function sanitizeMoonshotTools(tools: readonly MoonshotTool[]): readonly MoonshotTool[] {
  if (tools.length === 0) {
    return tools;
  }

  const sanitized: MoonshotTool[] = [];
  let anyChange = false;
  for (const tool of tools) {
    if (!isPlainObject(tool)) {
      sanitized.push(tool);
      continue;
    }
    const fn = (tool as MoonshotTool).function;
    if (!isPlainObject(fn)) {
      sanitized.push(tool);
      continue;
    }
    // `sanitizeMoonshotToolParameters` always returns a fresh object,
    // so any tool reaching this branch contributes to `anyChange`.
    const params = (fn as Record<string, unknown>).parameters;
    const repaired = sanitizeMoonshotToolParameters(params);
    anyChange = true;
    const newFn: Record<string, unknown> = {
      ...(fn as Record<string, unknown>),
      parameters: repaired,
    };
    sanitized.push({ ...(tool as Record<string, unknown>), function: newFn });
  }

  return anyChange ? sanitized : tools;
}

/**
 * `true` for any Kimi / Moonshot model slug, regardless of aggregator
 * prefix. Detection by model name covers Nous / OpenRouter / other
 * aggregators that route to Moonshot's inference.
 */
export function isMoonshotModel(model: string | null | undefined): boolean {
  if (!model) {
    return false;
  }
  const bare = model.trim().toLowerCase();
  // Last path segment (covers aggregator-prefixed slugs).
  const slashIdx = bare.lastIndexOf("/");
  const tail = slashIdx === -1 ? bare : bare.slice(slashIdx + 1);
  if (tail.startsWith("kimi-") || tail === "kimi") {
    return true;
  }
  if (bare.includes("moonshot") || bare.includes("/kimi") || bare.startsWith("kimi")) {
    return true;
  }
  return false;
}
