import {
  critiqueSchema,
  proposalSchema,
  synthesisSchema,
  type Critique,
  type Proposal,
  type Synthesis
} from "../core/schemas.js";
import { resolveEvidenceFindings } from "../research/evidenceFindings.js";
import { renderEvidenceData } from "../research/service.js";
import { requestOllamaChat } from "./ollamaChat.js";
import { normalizeProposalRecord } from "./proposalNormalize.js";
import { mergeRepairedClaims, validClaims } from "./proposalRepair.js";
import type { CouncilProvider, CritiqueInput, ProposalInput, SynthesisInput } from "./types.js";

export const claimContractLines = [
  "claims must contain at least two distinct, substantive, independently assessable assertions.",
  "Do not split one assertion into two merely to meet the minimum.",
  "If evidence is limited, express uncertainty rather than inventing claims."
] as const;

const MODEL_MAP = {
  gpt: "llama3.1:8b",
  claude: "mistral:7b",
  grok: "qwen2.5:7b"
} as const;

export const OLLAMA_NUM_CTX = 8192;

type OllamaSeat = keyof typeof MODEL_MAP;

type OllamaProviderConfig = {
  agentId: OllamaSeat;
  baseUrl: string;
  systemPrompt: string;
};

export function composeSeatPrompt(systemPrompt: string, voxisContext?: string): string {
  const block = String(voxisContext || "").trim();
  if (!block) return systemPrompt;
  return `${systemPrompt}\n\nPersona context:\n${block}`;
}

export function createOllamaProvider(config: OllamaProviderConfig): CouncilProvider {
  const modelName = MODEL_MAP[config.agentId];

  return {
    agentId: config.agentId,
    providerName: "ollama",
    modelName,
    mode: "ollama",
    propose: (input) => propose(config, modelName, input),
    critique: (input) => critique(config, modelName, input),
    synthesize: (input) => synthesize(config, modelName, input)
  };
}

async function propose(config: OllamaProviderConfig, modelName: string, input: ProposalInput): Promise<Proposal> {
  try {
    const systemPrompt = composeSeatPrompt(config.systemPrompt, input.voxisContext);
    const raw = await chat(config, modelName, systemPrompt, buildProposalPrompt(config.agentId, input));
    return await resolveOllamaProposal(config.agentId, modelName, raw, async ({ missing, existingClaims }) => {
      return chat(config, modelName, systemPrompt, buildClaimRepairPrompt({
        question: input.question,
        summary: typeof raw.summary === "string" ? raw.summary : undefined,
        missing,
        existingClaims
      }));
    });
  } catch (error) {
    throw proposalFailure(config.agentId, modelName, error);
  }
}

export function buildProposalPrompt(agentId: string, input: ProposalInput): string {
  return [
    "Task: propose.",
    "Return JSON with stance, summary, claims (2-4 items: id, statement, rationale, confidence 0-1, risk, evidenceIds), assumptions, risks, and confidence 0-1.",
    ...claimContractLines,
    "assumptions is an array of 1 to 4 plain strings. Each entry is one sentence, not an object.",
    "risks is an array of 1 to 4 plain strings. Each entry is one sentence, not an object.",
    `Claim ids look like ${agentId}:c1.`,
    "evidenceIds may list at most 3 ids copied from the evidence bundle.",
    `Question: ${input.question}`,
    input.context ? `Context: ${input.context}` : "Context: none provided",
    `Other seats: ${input.peers.join(", ") || "none"}`,
    renderEvidenceData(input.evidence),
    "You have no tools and cannot browse."
  ].join("\n");
}

export function buildClaimRepairPrompt(input: {
  question: string;
  summary?: string;
  missing: number;
  existingClaims: Record<string, unknown>[];
}): string {
  return [
    "Task: supply only the missing claims.",
    ...claimContractLines,
    `Question: ${input.question}`,
    input.summary?.trim() ? `Proposal summary: ${input.summary.trim()}` : "",
    `Return JSON with a claims array of exactly ${input.missing} new claim(s).`,
    "Each claim has id, statement, rationale, confidence 0-1, risk, and evidenceIds.",
    input.existingClaims.length > 0
      ? `Preserve these existing claims and do not repeat them: ${JSON.stringify(input.existingClaims)}`
      : "The first attempt had no valid claims.",
    "Do not invent extra claims to pad the list."
  ].filter(Boolean).join("\n");
}

export async function resolveOllamaProposal(
  agentId: OllamaSeat,
  modelName: string,
  raw: Record<string, unknown>,
  repair: (request: { missing: number; existingClaims: Record<string, unknown>[] }) => Promise<unknown>
): Promise<Proposal> {
  const firstCount = Array.isArray(raw.claims) ? raw.claims.length : null;

  if (firstCount !== null && firstCount < 2) {
    const existingClaims = validClaims(raw.claims);
    const missing = 2 - existingClaims.length;
    let merged: Record<string, unknown>;
    try {
      merged = mergeRepairedClaims(raw, await repair({ missing, existingClaims }));
    } catch (error) {
      throw labelAttempt(agentId, modelName, "after repair", error, firstCount);
    }

    try {
      return parseOllamaProposal(agentId, modelName, merged);
    } catch (error) {
      throw labelAttempt(agentId, modelName, "after repair", error, firstCount);
    }
  }

  try {
    return parseOllamaProposal(agentId, modelName, raw);
  } catch (error) {
    throw labelAttempt(agentId, modelName, "on the first attempt", error);
  }
}

function labelAttempt(
  agentId: string,
  modelName: string,
  when: "on the first attempt" | "after repair",
  error: unknown,
  firstCount?: number
): Error {
  const prefix = `Proposal failed for ${agentId} (${modelName}): `;
  let message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(prefix)) message = message.slice(prefix.length);
  message = message.replace(/^(?:on the first attempt|after repair(?: \(first attempt had \d+ claim\(s\)\))?): /, "");
  const where = when === "after repair"
    ? `after repair (first attempt had ${firstCount ?? 0} claim(s))`
    : "on the first attempt";
  return proposalFailure(agentId, modelName, new Error(`${where}: ${message}`));
}

export function parseOllamaProposal(agentId: OllamaSeat, modelName: string, raw: Record<string, unknown>): Proposal {
  try {
    return proposalSchema.parse({
      ...normalizeProposalRecord(raw),
      agentId,
      model: modelName
    });
  } catch (error) {
    throw proposalFailure(agentId, modelName, error);
  }
}

function proposalFailure(agentId: string, modelName: string, error: unknown): Error {
  const prefix = `Proposal failed for ${agentId} (${modelName}): `;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(prefix)) return error instanceof Error ? error : new Error(message);
  return new Error(`${prefix}${message}`);
}

async function critique(config: OllamaProviderConfig, modelName: string, input: CritiqueInput): Promise<Critique> {
  const raw = await chat(config, modelName, config.systemPrompt, [
    "Task: critique the target proposal.",
    "Return JSON with challengedClaimIds, usefulAgreements, concerns, recommendation, severity (low, medium, or high), and evidenceFindings.",
    "Each evidenceFinding has claimId, evidenceId, and relation (supports, contradicts, or unrelated).",
    "Copy evidenceId from the evidence bundle. If the bundle is empty, return an empty evidenceFindings array and do not set evidenceId to null.",
    `Question: ${input.question}`,
    input.context ? `Context: ${input.context}` : "Context: none provided",
    `Target: ${JSON.stringify(input.target)}`,
    `Peers: ${JSON.stringify(input.peers.map((peer) => ({ agentId: peer.agentId, summary: peer.summary })))}`,
    renderEvidenceData(input.evidence),
    "You have no tools and cannot browse."
  ].join("\n"));

  try {
    const evidenceFindings = resolveEvidenceFindings(raw.evidenceFindings, input.evidence, {
      seat: config.agentId,
      model: modelName,
      claims: input.target.claims.map((claim) => ({
        id: claim.id,
        evidenceIds: claim.evidenceIds
      }))
    });
    return critiqueSchema.parse({
      ...raw,
      evidenceFindings,
      agentId: config.agentId,
      targetAgentId: input.target.agentId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`for ${config.agentId} (${modelName})`)) {
      throw error instanceof Error ? error : new Error(message);
    }
    throw new Error(`Critique failed for ${config.agentId} (${modelName}): ${message}`);
  }
}

async function synthesize(config: OllamaProviderConfig, modelName: string, input: SynthesisInput): Promise<Synthesis> {
  const raw = await chat(config, modelName, config.systemPrompt, [
    "Task: synthesize one verdict.",
    "Dispositions stay accepted, monitor, or rejected. Do not invent another disposition.",
    "A contradicted claim cannot be accepted. Unsupported evidence pushes the claim toward monitor.",
    "finalAnswer is four labeled lines: Viewpoints:, Agreement Check:, Vote:, Final Decision:.",
    "resolutionTrace items include claimRef and evidenceStatus (supported, contradicted, unsupported, or unchecked).",
    "Include supportingClaims, disagreements, uncertainties, confidenceBand (low, medium, or high), nextActions, resolutionTrace, deliberation, and decisionRationale.",
    `Question: ${input.question}`,
    input.context ? `Context: ${input.context}` : "Context: none provided",
    `Proposals: ${JSON.stringify(input.proposals)}`,
    `Critiques: ${JSON.stringify(input.critiques)}`,
    `Resolution trace: ${JSON.stringify(input.resolutionTrace)}`,
    renderEvidenceData(input.evidence),
    "You have no tools and cannot browse."
  ].join("\n"));

  return synthesisSchema.parse(raw);
}

async function chat(
  config: OllamaProviderConfig,
  modelName: string,
  systemPrompt: string,
  user: string
): Promise<Record<string, unknown>> {
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/api/chat`;
  const content = await requestOllamaChat(endpoint, {
    model: modelName,
    stream: false,
    format: "json",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: user }
    ],
    options: {
      temperature: 0.4,
      num_ctx: OLLAMA_NUM_CTX
    }
  });

  return parseJsonObject(content);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Response did not include a JSON object");
    }

    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
}
