import {
  critiqueSchema,
  proposalSchema,
  synthesisSchema,
  type Critique,
  type Proposal,
  type Synthesis
} from "../core/schemas.js";
import { renderEvidenceData } from "../research/service.js";
import type { CouncilProvider, CritiqueInput, ProposalInput, SynthesisInput } from "./types.js";

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
  const raw = await chat(config, modelName, composeSeatPrompt(config.systemPrompt, input.voxisContext), [
    "Task: propose.",
    "Return JSON with stance, summary, claims (2-4 items: id, statement, rationale, confidence 0-1, risk, evidenceIds), assumptions (1-4), risks (1-4), and confidence 0-1.",
    `Claim ids look like ${config.agentId}:c1.`,
    "evidenceIds may list at most 3 ids copied from the evidence bundle.",
    `Question: ${input.question}`,
    input.context ? `Context: ${input.context}` : "Context: none provided",
    `Other seats: ${input.peers.join(", ") || "none"}`,
    renderEvidenceData(input.evidence),
    "You have no tools and cannot browse."
  ].join("\n"));

  return proposalSchema.parse({
    ...raw,
    agentId: config.agentId,
    model: modelName
  });
}

async function critique(config: OllamaProviderConfig, modelName: string, input: CritiqueInput): Promise<Critique> {
  const raw = await chat(config, modelName, config.systemPrompt, [
    "Task: critique the target proposal.",
    "Return JSON with challengedClaimIds, usefulAgreements, concerns, recommendation, severity (low, medium, or high), and evidenceFindings.",
    "Each evidenceFinding has claimId, evidenceId, and relation (supports, contradicts, or unrelated).",
    `Question: ${input.question}`,
    input.context ? `Context: ${input.context}` : "Context: none provided",
    `Target: ${JSON.stringify(input.target)}`,
    `Peers: ${JSON.stringify(input.peers.map((peer) => ({ agentId: peer.agentId, summary: peer.summary })))}`,
    renderEvidenceData(input.evidence),
    "You have no tools and cannot browse."
  ].join("\n"));

  return critiqueSchema.parse({
    ...raw,
    agentId: config.agentId,
    targetAgentId: input.target.agentId
  });
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
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
    })
  });

  if (!response.ok) {
    throw new Error(`ollama request failed with ${response.status}`);
  }

  const body = await response.json() as { message?: { content?: string } };
  const content = body.message?.content;

  if (!content) {
    throw new Error("ollama returned an empty response");
  }

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
