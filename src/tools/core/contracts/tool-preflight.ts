/**
 * Small JSON-Schema subset used by the Phase B preflight.
 *
 * The project already exposes tool schemas to the model, but it did not
 * validate those schemas before entering handlers. This validator deliberately
 * covers the object/array/primitive constraints used by the built-in tools
 * without introducing a second schema dependency.
 */
export interface ToolValidationResult {
  ok: boolean;
  errors: string[];
  normalizedInput?: unknown;
}

export function validateToolSchema(
  schema: Record<string, unknown>,
  input: unknown,
): ToolValidationResult {
  const errors: string[] = [];
  validateValue(schema, input, "$", errors);
  return { ok: errors.length === 0, errors };
}

function validateValue(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  const type = schema.type;
  if (type !== undefined && !matchesType(type, value)) {
    errors.push(`${path} must be ${formatType(type)}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
    return;
  }

  if (typeof value === "string") {
    const minLength = asFiniteNumber(schema.minLength);
    if (minLength !== undefined && value.length < minLength) {
      errors.push(`${path} must contain at least ${minLength} characters`);
    }
  }

  if (typeof value === "number") {
    const minimum = asFiniteNumber(schema.minimum);
    const maximum = asFiniteNumber(schema.maximum);
    if (minimum !== undefined && value < minimum) {
      errors.push(`${path} must be >= ${minimum}`);
    }
    if (maximum !== undefined && value > maximum) {
      errors.push(`${path} must be <= ${maximum}`);
    }
  }

  if (Array.isArray(value)) {
    const items = asRecord(schema.items);
    if (items) {
      value.forEach((item, index) => validateValue(items, item, `${path}[${index}]`, errors));
    }
    return;
  }

  if (!isRecord(value)) return;

  const properties = asRecord(schema.properties) ?? {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (!(key in value) || value[key] === undefined) {
      errors.push(`${path}.${key} is required`);
    }
  }

  const additionalProperties = schema.additionalProperties;
  for (const [key, item] of Object.entries(value)) {
    const propertySchema = asRecord(properties[key]);
    if (propertySchema) {
      validateValue(propertySchema, item, `${path}.${key}`, errors);
      continue;
    }
    if (additionalProperties === false) {
      errors.push(`${path}.${key} is not allowed`);
      continue;
    }
    const additionalSchema = asRecord(additionalProperties);
    if (additionalSchema) {
      validateValue(additionalSchema, item, `${path}.${key}`, errors);
    }
  }
}

function matchesType(type: unknown, value: unknown): boolean {
  if (Array.isArray(type)) {
    return type.some((item) => typeof item === "string" && matchesType(item, value));
  }
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function formatType(type: unknown): string {
  return Array.isArray(type) ? type.join(" or ") : String(type);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
