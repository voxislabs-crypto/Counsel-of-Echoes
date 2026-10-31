import { claimSchema } from "../core/schemas.js";

export function validClaims(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];

  const claims: Record<string, unknown>[] = [];
  for (const item of value) {
    const parsed = claimSchema.safeParse(item);
    if (parsed.success) claims.push(parsed.data);
  }
  return claims;
}

// Keeps claims that already passed claimSchema, then appends distinct claims
// from the repair response. Exact repeated statements are skipped. Nothing is
// added when the repair response has no new valid claim.
export function mergeRepairedClaims(original: Record<string, unknown>, repair: unknown): Record<string, unknown> {
  const existing = validClaims(original.claims);
  const incoming = validClaims(repairClaims(repair));
  const seen = new Set(existing.map(statementKey));
  const added: Record<string, unknown>[] = [];

  for (const claim of incoming) {
    const key = statementKey(claim);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(claim);
  }

  return {
    ...original,
    claims: [...existing, ...added]
  };
}

function repairClaims(repair: unknown): unknown {
  if (repair && typeof repair === "object" && !Array.isArray(repair) && "claims" in repair) {
    return (repair as { claims?: unknown }).claims;
  }
  return undefined;
}

function statementKey(claim: Record<string, unknown>): string {
  return typeof claim.statement === "string" ? claim.statement.trim().toLowerCase() : "";
}
