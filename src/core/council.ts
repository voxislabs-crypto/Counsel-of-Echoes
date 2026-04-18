import type { AgentId } from "./agents.js";
import { agentProfiles } from "./agents.js";
import {
  runRequestSchema,
  synthesisSchema,
  type Critique,
  type Proposal,
  type RunRequest,
  type RunRecord,
  type Synthesis
} from "./schemas.js";
import type { CouncilProvider, ProviderMode } from "../providers/types.js";
import { createProviders, type RuntimeConfig } from "../providers/index.js";
import { RunStore } from "../store/runStore.js";

export class CouncilService {
  constructor(
    private readonly store: RunStore,
    private readonly config: RuntimeConfig
  ) {}

  async startRun(input: unknown): Promise<{ runId: string; mode: ProviderMode; agents: AgentId[] }> {
    const request = runRequestSchema.parse(input);
    const providers = createProviders(this.config, request.mode);
    const mode = providers.every((provider) => provider.mode === "mock") ? "mock" : "live";
    const record = this.store.createRun({ ...request, mode });

    await this.store.appendEvent(record.runId, {
      runId: record.runId,
      type: "run.started",
      payload: {
        question: request.question,
        context: request.context,
        requestedMode: request.mode ?? this.config.providerMode
      }
    });

    void this.execute(record.runId, request, providers, mode);

    return {
      runId: record.runId,
      mode,
      agents: providers.map((provider) => provider.agentId)
    };
  }

  async runAndWait(input: unknown): Promise<RunRecord> {
    const request = runRequestSchema.parse(input);
    const providers = createProviders(this.config, request.mode);
    const mode = providers.every((provider) => provider.mode === "mock") ? "mock" : "live";
    const record = this.store.createRun({ ...request, mode });

    await this.store.appendEvent(record.runId, {
      runId: record.runId,
      type: "run.started",
      payload: {
        question: request.question,
        context: request.context,
        requestedMode: request.mode ?? this.config.providerMode
      }
    });

    await this.execute(record.runId, request, providers, mode);

    return this.store.getRun(record.runId) ?? record;
  }

  private async execute(
    runId: string,
    request: RunRequest,
    providers: CouncilProvider[],
    mode: ProviderMode
  ): Promise<void> {
    try {
      await this.store.setStatus(runId, "running");
      await this.store.appendEvent(runId, {
        runId,
        type: "route.selected",
        payload: {
          mode,
          providers: providers.map((provider) => ({
            agentId: provider.agentId,
            providerName: provider.providerName,
            modelName: provider.modelName,
            mode: provider.mode
          }))
        }
      });

      const proposals = await Promise.all(
        providers.map(async (provider) => {
          await this.store.appendEvent(runId, {
            runId,
            type: "proposal.started",
            agentId: provider.agentId,
            payload: {
              providerName: provider.providerName,
              modelName: provider.modelName
            }
          });

          const proposal = await provider.propose({
            question: request.question,
            context: request.context,
            peers: providers.map((candidate) => candidate.agentId).filter((agentId) => agentId !== provider.agentId)
          });

          await this.streamText(runId, provider.agentId, proposal.summary);
          await this.store.appendEvent(runId, {
            runId,
            type: "proposal.completed",
            agentId: provider.agentId,
            payload: {
              proposal
            }
          });

          return proposal;
        })
      );

      const critiques = await Promise.all(
        providers.map(async (provider, index) => {
          const target = proposals[(index + 1) % proposals.length];
          await this.store.appendEvent(runId, {
            runId,
            type: "critique.started",
            agentId: provider.agentId,
            payload: {
              targetAgentId: target.agentId
            }
          });

          const critique = await provider.critique({
            question: request.question,
            context: request.context,
            target,
            peers: proposals.filter((proposal) => proposal.agentId !== provider.agentId)
          });

          await this.store.appendEvent(runId, {
            runId,
            type: "critique.completed",
            agentId: provider.agentId,
            payload: {
              critique
            }
          });

          return critique;
        })
      );

      await this.store.appendEvent(runId, {
        runId,
        type: "synthesis.started",
        payload: {
          proposalCount: proposals.length,
          critiqueCount: critiques.length
        }
      });

      const synthesis = buildSynthesis(request.question, proposals, critiques);

      await this.store.appendEvent(runId, {
        runId,
        type: "synthesis.completed",
        payload: {
          synthesis
        }
      });

      await this.store.appendEvent(runId, {
        runId,
        type: "run.completed",
        payload: {
          confidenceBand: synthesis.confidenceBand
        }
      });
      await this.store.setStatus(runId, "completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown council failure";
      await this.store.appendEvent(runId, {
        runId,
        type: "run.failed",
        payload: {
          message
        }
      });
      await this.store.setStatus(runId, "failed", message);
    }
  }

  private async streamText(runId: string, agentId: AgentId, text: string): Promise<void> {
    const words = text.split(/\s+/).filter(Boolean);
    const chunkSize = 10;

    for (let index = 0; index < words.length; index += chunkSize) {
      const chunk = `${words.slice(index, index + chunkSize).join(" ")} `;
      await this.store.appendEvent(runId, {
        runId,
        type: "proposal.delta",
        agentId,
        payload: {
          delta: chunk
        }
      });

      await wait(40);
    }
  }
}

function buildSynthesis(question: string, proposals: Proposal[], critiques: Critique[]): Synthesis {
  const supportingClaims = proposals
    .flatMap((proposal) => proposal.claims.map((claim) => ({ proposal, claim })))
    .sort((left, right) => right.claim.confidence - left.claim.confidence)
    .slice(0, 5)
    .map(({ proposal, claim }) => ({
      statement: claim.statement,
      sourceAgents: [proposal.agentId],
      confidence: claim.confidence
    }));

  const disagreements = critiques.map((critique) => {
    const critic = agentProfiles[critique.agentId].label;
    const target = agentProfiles[critique.targetAgentId].label;
    return `${critic} challenges ${target}: ${critique.concerns[0]}`;
  }).slice(0, 5);

  const uncertainties = [
    ...new Set([
      ...proposals.flatMap((proposal) => proposal.assumptions),
      ...proposals.flatMap((proposal) => proposal.risks)
    ])
  ].slice(0, 5);

  const nextActions = [
    "Run the same prompt against the single strongest baseline model and compare quality.",
    "Keep one critique round only until evaluation shows a measurable gain from more.",
    "Add persistence and replay before adding avatars or voice."
  ];

  const finalAnswer = [
    `The council's current answer to "${question}" is to keep the system narrow, inspectable, and evidence-driven.`,
    `Across the chamber, the strongest consensus is around ${supportingClaims.slice(0, 3).map((claim) => claim.statement.toLowerCase()).join("; ")}.`,
    disagreements.length
      ? `The main unresolved tension is that ${disagreements[0].toLowerCase()}.`
      : "There is no material disagreement in this run, which itself should be treated cautiously."
  ].join(" ");

  const averageConfidence = supportingClaims.reduce((sum, claim) => sum + claim.confidence, 0) / supportingClaims.length;
  const confidenceBand = averageConfidence >= 0.8 ? "high" : averageConfidence >= 0.68 ? "medium" : "low";

  return synthesisSchema.parse({
    finalAnswer,
    supportingClaims,
    disagreements,
    uncertainties,
    confidenceBand,
    nextActions
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}