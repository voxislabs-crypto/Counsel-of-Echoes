import { proposalSchema, type Proposal } from "../core/schemas.js";
import { normalizeStringList } from "./proposalNormalize.js";
import { mergeRepairedClaims, validClaims } from "./proposalRepair.js";
import {
  recoverStructuredOutput,
  type NormalizationNote,
  type OutputRepairRequest,
  type OutputTrace,
  type PreparedOutput,
  type ValidationIssue
} from "./outputRecovery.js";

export const claimContractLines = [
  "claims must contain at least two distinct, substantive, independently assessable assertions.",
  "Do not split one assertion into two merely to meet the minimum.",
  "If evidence is limited, express uncertainty rather than inventing claims."
] as const;

export const proposalFieldGuide = {
  stance: "a non-empty string",
  summary: "a non-empty string",
  claims: "an array of 2 to 5 claims, each with id, statement, rationale, confidence (number from 0 to 1), risk, and evidenceIds (at most 3 strings copied from the bundle)",
  assumptions: "an array of 1 to 4 plain strings, not objects",
  risks: "an array of 1 to 4 plain strings, not objects",
  confidence: "a number from 0 to 1. Do not omit it and do not substitute a default"
} as const;

export const proposalFieldLines = [
  "Required fields and constraints:",
  ...Object.entries(proposalFieldGuide).map(([name, expected]) => `${name}: ${expected}.`)
] as const;

const refusal = [
  "Do not fabricate claims, evidence ids, assumptions, risks, or confidence.",
  "If you cannot supply a failed field from the question and your previous answer, omit that key."
].join(" ");

export async function recoverProposal(
  agentId: string,
  modelName: string,
  raw: Record<string, unknown>,
  repair: (request: OutputRepairRequest) => Promise<unknown>,
  options?: { question?: string; onTrace?: (trace: OutputTrace) => void }
): Promise<Proposal> {
  const claimCount = Array.isArray(raw.claims) ? raw.claims.length : 0;

  return recoverStructuredOutput<Proposal>({
    stage: "proposal",
    stageLabel: "Proposal",
    schema: proposalSchema,
    raw,
    seat: agentId,
    model: modelName,
    identity: { agentId, model: modelName },
    fieldGuide: proposalFieldGuide,
    normalize: normalizeProposal,
    mergeField: mergeProposalField,
    repair,
    onTrace: options?.onTrace,
    contextLines: options?.question ? [`Question: ${options.question}`] : [],
    refusal,
    extraLines: (issues, preserved) => claimRepairLines(issues, preserved),
    describeFailure: (phase, issues) => describeProposalFailure(phase, issues, claimCount)
  });
}

function normalizeProposal(raw: Record<string, unknown>): PreparedOutput {
  const notes: NormalizationNote[] = [];
  const record: Record<string, unknown> = { ...raw };
  record.assumptions = renderList("assumptions", raw.assumptions, notes);
  record.risks = renderList("risks", raw.risks, notes);
  record.confidence = renderConfidence("confidence", raw.confidence, notes);
  if (Array.isArray(raw.claims)) {
    record.claims = raw.claims.map((claim, index) => renderClaim(claim, index, notes));
  }
  return { record, notes, issues: [] };
}

function mergeProposalField(field: string, original: Record<string, unknown>, repair: Record<string, unknown>): unknown {
  if (field !== "claims") return repair[field];
  const base = { ...original, claims: validClaims(original.claims) };
  return mergeRepairedClaims(base, repair).claims;
}

function claimRepairLines(issues: ValidationIssue[], preserved: Record<string, unknown>): string[] {
  const claimsFailed = issues.some((issue) => issue.path === "claims" || issue.path.startsWith("claims."));
  if (!claimsFailed) return [];
  const existing = Array.isArray(preserved.claims) ? preserved.claims as Record<string, unknown>[] : [];
  const missing = Math.max(0, 2 - existing.length);
  if (missing === 0) {
    return [
      ...claimContractLines,
      "Fix only the claims that failed validation.",
      "Keep every claim that already passed.",
      "Do not invent extra claims to pad the list."
    ];
  }
  return [
    ...claimContractLines,
    `Return JSON with a claims array of exactly ${missing} new claim(s).`,
    "Each claim has id, statement, rationale, confidence 0-1, risk, and evidenceIds.",
    existing.length > 0
      ? `Preserve these existing claims and do not repeat them: ${JSON.stringify(existing)}`
      : "The first attempt had no valid claims.",
    "Do not invent extra claims to pad the list."
  ];
}

function describeProposalFailure(phase: "first" | "repair", issues: ValidationIssue[], claimCount: number): string {
  const body = issues.map((issue) => issue.path === "(root)" ? issue.message : `${issue.path}: ${issue.message}`).join("; ");
  const claimsFailed = issues.some((issue) => issue.path === "claims" || issue.path.startsWith("claims."));
  if (phase === "repair" && claimsFailed) {
    return `after repair (first attempt had ${claimCount} claim(s)): ${body}`;
  }
  if (phase === "repair") return `after repair: ${body}`;
  return `on the first attempt: ${body}`;
}

function renderList(field: string, value: unknown, notes: NormalizationNote[]): unknown {
  if (!Array.isArray(value)) return value;
  try {
    const rendered = normalizeStringList(field, value);
    if (JSON.stringify(rendered) !== JSON.stringify(value)) {
      notes.push({ field, action: "rendered list items as plain strings" });
    }
    return rendered;
  } catch (error) {
    notes.push({
      field,
      action: `left unchanged: ${error instanceof Error ? error.message : String(error)}`
    });
    return value;
  }
}

function renderClaim(claim: unknown, index: number, notes: NormalizationNote[]): unknown {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return claim;
  const copy = { ...(claim as Record<string, unknown>) };
  copy.confidence = renderConfidence(`claims.${index}.confidence`, copy.confidence, notes);
  return copy;
}

function renderConfidence(field: string, value: unknown, notes: NormalizationNote[]): unknown {
  if (typeof value === "number" || value == null) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      notes.push({ field, action: "parsed a numeric string" });
      return parsed;
    }
  }
  return value;
}
