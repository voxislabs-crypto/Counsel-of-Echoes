import type { EvidenceBundle } from "./schemas.js";

export type ClaimEvidenceRef = {
  id: string;
  evidenceIds: string[];
};

export type EvidenceFindingContext = {
  seat: string;
  model: string;
  claims: ClaimEvidenceRef[];
};

// Fills a null evidenceId only from a source the finding or its claim already
// names, or from the single loaded evidence item when the claim cites none.
// A null with no unique source throws. The schema still requires a string.
export function resolveEvidenceFindings(
  findings: unknown,
  bundle: EvidenceBundle | undefined,
  context: EvidenceFindingContext
): unknown {
  if (findings === undefined) return undefined;
  if (!Array.isArray(findings)) return findings;

  const sources = bundle?.items ?? [];
  const failures: string[] = [];
  const resolved = findings.map((finding, index) => {
    try {
      return resolveFinding(finding, index, sources, context);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      return finding;
    }
  });

  if (failures.length === 0) return resolved;

  const sourceText = sources.length === 0
    ? "none"
    : sources.map((item) => `${item.id} ${item.sourceUrl}`).join("; ");
  throw new Error(
    `Cannot resolve null evidenceId for ${context.seat} (${context.model}). Evidence sources: ${sourceText}. ${failures.join(" ")}`
  );
}

function resolveFinding(
  finding: unknown,
  index: number,
  sources: EvidenceBundle["items"],
  context: EvidenceFindingContext
): unknown {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    throw new Error(`finding[${index}] claimId=missing evidenceId was null and the finding was not an object.`);
  }

  const record = finding as Record<string, unknown>;
  if (typeof record.evidenceId === "string" && record.evidenceId.trim()) {
    return finding;
  }
  if (!missingEvidenceId(record.evidenceId)) {
    throw new Error(describe(index, record, `evidenceId was ${received(record.evidenceId)}`));
  }

  const fromUrl = matchSourceUrl(record, sources);
  if (fromUrl) return { ...record, evidenceId: fromUrl };

  const named = namedSources(record);
  if (named.length > 0) {
    throw new Error(describe(
      index,
      record,
      `evidenceId was ${missingLabel(record.evidenceId)} and no unique evidence source matched (finding named ${named.join(", ")})`
    ));
  }

  const claim = typeof record.claimId === "string"
    ? context.claims.find((item) => item.id === record.claimId)
    : undefined;

  if (claim && claim.evidenceIds.length === 1) {
    const evidenceId = claim.evidenceIds[0];
    if (evidenceId && (sources.length === 0 || sources.some((item) => item.id === evidenceId))) {
      return { ...record, evidenceId };
    }
    throw new Error(describe(
      index,
      record,
      `evidenceId was ${missingLabel(record.evidenceId)} and claim ${claim.id} cited ${evidenceId || "an empty id"} which is not in the evidence bundle`
    ));
  }

  if (claim && claim.evidenceIds.length > 1) {
    throw new Error(describe(
      index,
      record,
      `evidenceId was ${missingLabel(record.evidenceId)} and claim ${claim.id} cited ${claim.evidenceIds.join(", ")}`
    ));
  }

  if (sources.length === 1) {
    assertKnownClaim(record, index, context.claims);
    return { ...record, evidenceId: sources[0].id };
  }

  throw new Error(describe(
    index,
    record,
    `evidenceId was ${missingLabel(record.evidenceId)} and no unique evidence source matched`
  ));
}

function matchSourceUrl(record: Record<string, unknown>, sources: EvidenceBundle["items"]): string | undefined {
  const candidates = namedSources(record);
  if (candidates.length === 0) return undefined;

  const matches = sources.filter((item) => candidates.some((candidate) => candidate === item.id || candidate === item.sourceUrl));
  if (matches.length === 1) return matches[0].id;
  return undefined;
}

function namedSources(record: Record<string, unknown>): string[] {
  return [record.sourceUrl, record.url, record.source]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function assertKnownClaim(record: Record<string, unknown>, index: number, claims: ClaimEvidenceRef[]): void {
  if (typeof record.claimId !== "string" || !claims.some((claim) => claim.id === record.claimId)) {
    throw new Error(describe(index, record, "evidenceId was null and claimId did not match a proposal claim"));
  }
}

function missingEvidenceId(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function missingLabel(value: unknown): string {
  return value == null ? "null" : "blank";
}

function describe(index: number, record: Record<string, unknown>, detail: string): string {
  const claimId = typeof record.claimId === "string" ? record.claimId : "missing";
  return `finding[${index}] claimId=${claimId} ${detail}.`;
}

function received(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
