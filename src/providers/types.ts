import type { AgentId } from "../core/agents.js";
import type { Critique, Proposal, ResolutionTraceItem, Synthesis } from "../core/schemas.js";
import type { EvidenceBundle } from "../research/schemas.js";

export type ProviderMode = "mock" | "live" | "ollama";

export type ProposalInput = {
  question: string;
  context: string;
  peers: AgentId[];
  evidence?: EvidenceBundle;
  voxisContext?: string;
};

export type CritiqueInput = {
  question: string;
  context: string;
  target: Proposal;
  peers: Proposal[];
  evidence?: EvidenceBundle;
};

export type SynthesisInput = {
  question: string;
  context: string;
  proposals: Proposal[];
  critiques: Critique[];
  resolutionTrace: ResolutionTraceItem[];
  evidence?: EvidenceBundle;
};

export interface CouncilProvider {
  agentId: AgentId;
  providerName: string;
  modelName: string;
  mode: ProviderMode;
  propose(input: ProposalInput): Promise<Proposal>;
  critique(input: CritiqueInput): Promise<Critique>;
  synthesize(input: SynthesisInput): Promise<Synthesis>;
}