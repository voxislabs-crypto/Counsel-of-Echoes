import {
  critiqueSchema,
  proposalSchema,
  synthesisSchema,
  type Critique,
  type Proposal,
  type Synthesis
} from "../core/schemas.js";
import { resolveEvidenceFindings, type ClaimEvidenceRef } from "../research/evidenceFindings.js";
import type { EvidenceBundle } from "../research/schemas.js";
import { renderEvidenceData } from "../research/service.js";
import { codeLensLines } from "./codeLens.js";
import { requestOllamaChat } from "./ollamaChat.js";
import { normalizeCritiqueRecord, resolveCritiqueTargetAgentId } from "./critiqueNormalize.js";
import { critiqueFieldLines, recoverCritique } from "./critiqueOutput.js";
import { normalizeProposalRecord } from "./proposalNormalize.js";
import { StructuredOutputError } from "./outputRecovery.js";
import { claimContractLines, proposalFieldLines, recoverProposal } from "./proposalOutput.js";
import type { CouncilProvider, CritiqueInput, ProposalInput, SynthesisInput } from "./types.js";

export { claimContractLines, proposalFieldLines, recoverProposal as resolveOllamaProposal };

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
    return await recoverProposal(config.agentId, modelName, raw, async (request) => {
      return chat(config, modelName, systemPrompt, request.prompt);
    }, {
      question: input.question,
      onTrace: input.onOutputTrace
    });
  } catch (error) {
    if (error instanceof StructuredOutputError) throw error;
    throw proposalFailure(config.agentId, modelName, error);
  }
}

export function buildProposalPrompt(agentId: string, input: ProposalInput): string {
  return [
    "Task: propose.",
    "Return JSON with stance, summary, claims (2-4 items: id, statement, rationale, confidence 0-1, risk, evidenceIds), assumptions, risks, and confidence 0-1.",
    ...proposalFieldLines,
    ...codeLensLines("proposal", input.lens),
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

export function parseOllamaCritique(
  agentId: OllamaSeat,
  modelName: string,
  raw: Record<string, unknown>,
  evidenceFindings: unknown,
  critiquedSeat?: string
): Critique {
  try {
    return critiqueSchema.parse({
      ...normalizeCritiqueRecord(raw),
      evidenceFindings,
      agentId,
      targetAgentId: resolveCritiqueTargetAgentId(raw.targetAgentId, critiquedSeat)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`for ${agentId} (${modelName})`)) {
      throw error instanceof Error ? error : new Error(message);
    }
    throw new Error(`Critique failed for ${agentId} (${modelName}): ${message}`);
  }
}

export function assembleOllamaCritique(
  agentId: OllamaSeat,
  modelName: string,
  raw: Record<string, unknown>,
  input: {
    evidence?: EvidenceBundle;
    claims: ClaimEvidenceRef[];
    targetAgentId?: string;
  }
): Critique {
  const evidenceFindings = resolveEvidenceFindings(raw.evidenceFindings, input.evidence, {
    seat: agentId,
    model: modelName,
    claims: input.claims
  });
  return parseOllamaCritique(agentId, modelName, raw, evidenceFindings, input.targetAgentId);
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

export function buildCritiquePrompt(input: CritiqueInput): string {
  const bundleEmpty = !input.evidence || input.evidence.items.length === 0;
  return [
    "Task: critique the target proposal.",
    "Return JSON with targetAgentId, challengedClaimIds, usefulAgreements, concerns, recommendation, severity (low, medium, or high), and evidenceFindings.",
    ...critiqueFieldLines,
    "targetAgentId is a plain string naming the one seat whose proposal you are critiquing: gpt, claude, or grok.",
    "Do not omit targetAgentId and do not send it as an object.",
    "concerns is an array of 1 to 4 plain strings. Each entry is one sentence, not an object.",
    "usefulAgreements is an array of up to 3 plain strings. Each entry is one sentence, not an object.",
    "Each evidenceFinding has claimId, evidenceId, and relation (supports, contradicts, or unrelated).",
    bundleEmpty
      ? "No evidence bundle is present. Return an empty evidenceFindings array. Do not return finding objects, and do not set evidenceId to null."
      : "evidenceId is a plain string copied from the evidence bundle. Do not set evidenceId to null.",
    ...codeLensLines("critique", input.lens),
    ...(input.lens === "code" ? [
      "Code review still requires targetAgentId as the plain seat id of the Target proposal, one of gpt, claude, or grok.",
      bundleEmpty
        ? "A code critique with no evidence bundle returns evidenceFindings as []. A null evidenceId is not a finding."
        : "A code critique copies evidenceId from the bundle. A null evidenceId is not a finding."
    ] : []),
    `Question: ${input.question}`,
    input.context ? `Context: ${input.context}` : "Context: none provided",
    `Target: ${JSON.stringify(input.target)}`,
    `Peers: ${JSON.stringify(input.peers.map((peer) => ({ agentId: peer.agentId, summary: peer.summary })))}`,
    renderEvidenceData(input.evidence),
    "You have no tools and cannot browse."
  ].join("\n");
}

async function critique(config: OllamaProviderConfig, modelName: string, input: CritiqueInput): Promise<Critique> {
  const raw = await chat(config, modelName, config.systemPrompt, buildCritiquePrompt(input));

  try {
    return await recoverCritique(config.agentId, modelName, raw, {
      evidence: input.evidence,
      claims: input.target.claims.map((claim) => ({
        id: claim.id,
        evidenceIds: claim.evidenceIds
      })),
      targetAgentId: input.target.agentId,
      question: input.question,
      onTrace: input.onOutputTrace
    }, async (request) => chat(config, modelName, config.systemPrompt, request.prompt));
  } catch (error) {
    if (error instanceof StructuredOutputError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`for ${config.agentId} (${modelName})`)) {
      throw error instanceof Error ? error : new Error(message);
    }
    throw new Error(`Critique failed for ${config.agentId} (${modelName}): ${message}`);
  }
}

export function buildSynthesisPrompt(input: SynthesisInput): string {
  return [
    "Task: synthesize one verdict.",
    "Dispositions stay accepted, monitor, or rejected. Do not invent another disposition.",
    "A contradicted claim cannot be accepted. Unsupported evidence pushes the claim toward monitor.",
    ...codeLensLines("synthesis", input.lens),
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
  ].join("\n");
}

async function synthesize(config: OllamaProviderConfig, modelName: string, input: SynthesisInput): Promise<Synthesis> {
  const raw = await chat(config, modelName, config.systemPrompt, buildSynthesisPrompt(input));

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
