// Turns model-shaped list items into the strings proposalSchema requires.
// Plain strings pass through. Objects keep every string, finite number, and
// boolean as "key: value", including one nested object level. Nulls and
// whitespace-only strings are empty and are left out. Anything else throws,
// so a nested value is never dropped or replaced with invented text.

export function normalizeProposalRecord(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    assumptions: normalizeStringList("assumptions", raw.assumptions),
    risks: normalizeStringList("risks", raw.risks)
  };
}

export function normalizeStringList(field: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }

  return value.map((item, index) => renderStringItem(field, index, item));
}

function renderStringItem(field: string, index: number, item: unknown): string {
  if (typeof item === "string") {
    const trimmed = item.trim();
    if (!trimmed) throw new Error(`${field}[${index}] was an empty string`);
    return trimmed;
  }

  if (typeof item === "number") {
    if (!Number.isFinite(item)) throw new Error(`${field}[${index}] was not a finite number`);
    return String(item);
  }

  if (typeof item === "boolean") return String(item);

  if (Array.isArray(item)) {
    throw new Error(`${field}[${index}] was an array, expected a string or object`);
  }

  if (item && typeof item === "object") {
    const parts = renderObject(item as Record<string, unknown>, field, index, "", 0);
    if (parts.length === 0) {
      throw new Error(`${field}[${index}] object contained no string, number, or boolean values`);
    }
    return parts.join("; ");
  }

  throw new Error(`${field}[${index}] was ${describeType(item)}, expected a string or object`);
}

function renderObject(
  value: Record<string, unknown>,
  field: string,
  index: number,
  path: string,
  depth: number
): string[] {
  const parts: string[] = [];

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (child == null) continue;

    if (typeof child === "string") {
      const trimmed = child.trim();
      if (trimmed) parts.push(`${childPath}: ${trimmed}`);
      continue;
    }

    if (typeof child === "number") {
      if (!Number.isFinite(child)) throw new Error(`${field}[${index}].${childPath} was not a finite number`);
      parts.push(`${childPath}: ${child}`);
      continue;
    }

    if (typeof child === "boolean") {
      parts.push(`${childPath}: ${child}`);
      continue;
    }

    if (Array.isArray(child)) {
      parts.push(`${childPath}: ${renderPrimitiveArray(child, field, index, childPath)}`);
      continue;
    }

    if (typeof child === "object") {
      if (depth >= 1) {
        throw new Error(`${field}[${index}].${childPath} was nested more than one level`);
      }
      parts.push(...renderObject(child as Record<string, unknown>, field, index, childPath, depth + 1));
      continue;
    }

    throw new Error(`${field}[${index}].${childPath} was ${describeType(child)}`);
  }

  return parts;
}

function renderPrimitiveArray(items: unknown[], field: string, index: number, path: string): string {
  if (items.length === 0) {
    throw new Error(`${field}[${index}].${path} was an empty array`);
  }

  return items.map((item, itemIndex) => {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) throw new Error(`${field}[${index}].${path}[${itemIndex}] was an empty string`);
      return trimmed;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error(`${field}[${index}].${path}[${itemIndex}] was not a finite number`);
      return String(item);
    }
    if (typeof item === "boolean") return String(item);
    throw new Error(`${field}[${index}].${path}[${itemIndex}] was ${describeType(item)}, expected a string, number, or boolean`);
  }).join(", ");
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}
