import { critiqueSchema, type Critique } from "../core/schemas.js";
import { resolveEvidenceFindings, type ClaimEvidenceRef } from "../research/evidenceFindings.js";
import type { EvidenceBundle } from "../research/schemas.js";
import { normalizeStringList } from "./proposalNormalize.js";
import { resolveCritiqueTargetAgentId } from "./critiqueNormalize.js";
import {
  recoverStructuredOutput,
  type NormalizationNote,
  type OutputRepairRequest,
  type OutputTrace,
  type PreparedOutput,
  type ValidationIssue
} from "./outputRecovery.js";

export const critiqueFieldGuide = {
  targetAgentId: "a plain string naming one seat: gpt, claude, or grok",
  challengedClaimIds: "an array of up to 4 claim id strings",
  usefulAgreements: "an array of up to 3 plain strings, not objects",
  concerns: "an array of 1 to 4 plain strings, not objects",
  recommendation: "a non-empty string",
  severity: "one of low, medium, or high",
  evidenceFindings: "an array of up to 6 objects with claimId, evidenceId (a string copied from the bundle), and relation (supports, contradicts, or unrelated). Use an empty array when no bundle is present. Do not set evidenceId to null"
} as const;

export const critiqueFieldLines = [
  "Required fields and constraints:",
  ...Object.entries(critiqueFieldGuide).map(([name, expected]) => `${name}: ${expected}.`)
] as const;

const refusal = [
  "Do not fabricate claims, evidence ids, assumptions, risks, or confidence.",
  "Do not invent an evidenceId or a seat id that was not assigned.",
  "If you cannot supply a failed field, omit that key."
].join(" ");

export type CritiqueRecoveryContext = {
  evidence?: EvidenceBundle;
  claims: ClaimEvidenceRef[];
  targetAgentId?: string;
  question?: string;
  onTrace?: (trace: OutputTrace) => void;
};

export async function recoverCritique(
  agentId: string,
  modelName: string,
  raw: Record<string, unknown>,
  context: CritiqueRecoveryContext,
  repair: (request: OutputRepairRequest) => Promise<unknown>
): Promise<Critique> {
  const bundleEmpty = !context.evidence || context.evidence.items.length === 0;

  return recoverStructuredOutput<Critique>({
    stage: "critique",
    stageLabel: "Critique",
    schema: critiqueSchema,
    raw,
    seat: agentId,
    model: modelName,
    identity: { agentId },
    fieldGuide: critiqueFieldGuide,
    normalize: (record) => normalizeCritique(record, context.targetAgentId),
    prepare: (record) => prepareEvidence(record, agentId, modelName, context),
    repair,
    onTrace: context.onTrace,
    contextLines: [
      context.question ? `Question: ${context.question}` : "",
      bundleEmpty
        ? "No evidence bundle is present. evidenceFindings must be an empty array. A null evidenceId is not a finding."
        : "Copy evidenceId from the bundle. Do not set evidenceId to null."
    ].filter(Boolean),
    refusal,
    describeFailure: (_phase, issues) => issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ")
  });
}

function normalizeCritique(raw: Record<string, unknown>, critiquedSeat?: string): PreparedOutput {
  const notes: NormalizationNote[] = [];
  const issues: ValidationIssue[] = [];
  const record: Record<string, unknown> = { ...raw };
  record.concerns = renderList("concerns", raw.concerns, notes);
  record.usefulAgreements = renderList("usefulAgreements", raw.usefulAgreements, notes);

  try {
    const resolved = resolveCritiqueTargetAgentId(raw.targetAgentId, critiquedSeat);
    if (resolved !== raw.targetAgentId) {
      notes.push({
        field: "targetAgentId",
        action: raw.targetAgentId == null || (typeof raw.targetAgentId === "string" && !raw.targetAgentId.trim())
          ? "filled targetAgentId from the critiqued seat"
          : "trimmed targetAgentId"
      });
    }
    record.targetAgentId = resolved;
  } catch (error) {
    issues.push({
      path: "targetAgentId",
      code: "invalid_target",
      expected: critiqueFieldGuide.targetAgentId,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  return { record, notes, issues };
}

function prepareEvidence(
  record: Record<string, unknown>,
  seat: string,
  model: string,
  context: CritiqueRecoveryContext
): PreparedOutput {
  try {
    const resolved = resolveEvidenceFindings(record.evidenceFindings, context.evidence, {
      seat,
      model,
      claims: context.claims
    });
    if (resolved === undefined) return { record, notes: [], issues: [] };
    const changed = JSON.stringify(resolved) !== JSON.stringify(record.evidenceFindings);
    return {
      record: { ...record, evidenceFindings: resolved },
      notes: changed ? [{ field: "evidenceFindings", action: "resolved evidenceId from a unique known source" }] : [],
      issues: []
    };
  } catch (error) {
    return {
      record,
      notes: [],
      issues: [{
        path: "evidenceFindings",
        code: "unresolved_evidence",
        expected: critiqueFieldGuide.evidenceFindings,
        message: error instanceof Error ? error.message : String(error)
      }]
    };
  }
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
