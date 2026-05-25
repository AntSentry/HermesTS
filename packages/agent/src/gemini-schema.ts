/**
 * Helpers for translating OpenAI-style tool schemas to Gemini's schema subset.
 *
 * Faithful port of upstream `agent/gemini_schema.py`.
 *
 * Gemini's `FunctionDeclaration.parameters` field accepts the `Schema`
 * object, which is only a subset of OpenAPI 3.0 / JSON Schema. Strip
 * fields outside that subset before sending Hermes tool schemas to Google.
 */

const GEMINI_SCHEMA_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
  "items",
  "minimum",
  "maximum",
]);

const GEMINI_DROP_ENUM_TYPES: ReadonlySet<string> = new Set(["integer", "number", "boolean"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return a Gemini-compatible copy of a tool parameter schema.
 *
 * Hermes tool schemas are OpenAI-flavored JSON Schema and may contain
 * keys such as `$schema` or `additionalProperties` that Google's Gemini
 * `Schema` object rejects. This helper preserves the documented Gemini
 * subset and recursively sanitizes nested `properties` / `items` /
 * `anyOf` definitions.
 */
export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> {
  if (!isPlainObject(schema)) {
    return {};
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_ALLOWED_KEYS.has(key)) {
      continue;
    }
    if (key === "properties") {
      if (!isPlainObject(value)) {
        continue;
      }
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        // Upstream guards `isinstance(prop_name, str)`. In TS object keys
        // are always strings — `Object.entries` guarantees this. The
        // upstream guard is therefore a no-op when ported faithfully.
        props[propName] = sanitizeGeminiSchema(propSchema);
      }
      cleaned[key] = props;
      continue;
    }
    if (key === "items") {
      cleaned[key] = sanitizeGeminiSchema(value);
      continue;
    }
    if (key === "anyOf") {
      if (!Array.isArray(value)) {
        continue;
      }
      const items: Record<string, unknown>[] = [];
      for (const item of value) {
        if (isPlainObject(item)) {
          items.push(sanitizeGeminiSchema(item));
        }
      }
      cleaned[key] = items;
      continue;
    }
    cleaned[key] = value;
  }

  // Gemini's Schema validator requires every `enum` entry to be a
  // string, even when the parent `type` is integer/number/boolean.
  // Drop the enum if it would collide. Upstream `gemini_schema.py:84-88`.
  const enumVal = cleaned.enum;
  const typeVal = cleaned.type;
  if (
    Array.isArray(enumVal) &&
    typeof typeVal === "string" &&
    GEMINI_DROP_ENUM_TYPES.has(typeVal)
  ) {
    if (enumVal.some((item) => typeof item !== "string")) {
      delete cleaned.enum;
    }
  }

  return cleaned;
}

/** Normalize tool parameters to a valid Gemini object schema. */
export function sanitizeGeminiToolParameters(parameters: unknown): Record<string, unknown> {
  const cleaned = sanitizeGeminiSchema(parameters);
  if (Object.keys(cleaned).length === 0) {
    return { type: "object", properties: {} };
  }
  return cleaned;
}
