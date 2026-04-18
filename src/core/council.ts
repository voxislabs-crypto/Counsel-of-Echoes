import type { AgentId } from "./agents.js";
import { agentProfiles } from "./agents.js";
import {
  runRequestSchema,
  synthesisSchema,
  type Critique,
  type Proposal,
  type ResolutionTraceItem,
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
  const resolvedClaims = proposals
    .flatMap((proposal) => proposal.claims.map((claim) => buildResolvedClaim(proposal, claim, critiques)))
    .sort((left, right) => right.score - left.score);

  const acceptedClaims = resolvedClaims.filter((claim) => claim.disposition === "accepted").slice(0, 5);
  const monitoredClaims = resolvedClaims.filter((claim) => claim.disposition === "monitor").slice(0, 5);

  const supportingClaims = (acceptedClaims.length > 0 ? acceptedClaims : resolvedClaims.slice(0, 5)).map((claim) => ({
    statement: claim.statement,
    sourceAgents: claim.sourceAgents,
    supportCount: claim.supportCount,
    challengeCount: claim.challengeCount,
    confidence: claim.score
  }));

  const disagreements = [
    ...critiques
      .filter((critique) => critique.severity !== "low")
      .map((critique) => {
        const critic = agentProfiles[critique.agentId].label;
        const target = agentProfiles[critique.targetAgentId].label;
        return `${critic} challenges ${target}: ${critique.concerns[0]}`;
      }),
    ...monitoredClaims.map((claim) => `The chamber is still monitoring: ${claim.statement}. ${claim.rationale}`)
  ].slice(0, 6);

  const uncertainties = [
    ...monitoredClaims.map((claim) => claim.statement),
    ...new Set([
      ...proposals.flatMap((proposal) => proposal.assumptions),
      ...proposals.flatMap((proposal) => proposal.risks)
    ])
  ].slice(0, 6);

  const nextActions = unique([
    ...acceptedClaims.slice(0, 2).map((claim) => toAction(claim.statement)),
    ...critiques.slice(0, 2).map((critique) => critique.recommendation),
    monitoredClaims[0] ? `Validate whether ${monitoredClaims[0].statement.toLowerCase()} should stay in the final verdict.` : undefined,
    "Run the same prompt against the single strongest baseline model and compare quality."
  ]).slice(0, 5);

  const consensusLead = supportingClaims.slice(0, 3).map((claim) => claim.statement.toLowerCase());
  const finalAnswer = [
    `The council's current answer to "${question}" is to privilege claims that survive critique, not just claims that sound strong in isolation.`,
    consensusLead.length
      ? `The accepted direction is centered on ${consensusLead.join("; ")}.`
      : "The chamber did not produce enough accepted claims to justify a strong verdict.",
    disagreements.length
      ? `The main unresolved tension is that ${disagreements[0].toLowerCase()}.`
      : "No major contradiction survived the synthesis pass, so the result should still be checked against a single-model baseline."
  ].join(" ");

  const confidenceBand = determineConfidenceBand(resolvedClaims, disagreements.length, uncertainties.length);
  const resolutionTrace = resolvedClaims.slice(0, 8).map((claim) => ({
    statement: claim.statement,
    disposition: claim.disposition,
    sourceAgents: claim.sourceAgents,
    challengedBy: claim.challengedBy,
    score: claim.score,
    rationale: claim.rationale
  }));

  return synthesisSchema.parse({
    finalAnswer,
    supportingClaims,
    disagreements,
    uncertainties,
    confidenceBand,
    nextActions,
    resolutionTrace
  });
}

function buildResolvedClaim(proposal: Proposal, claim: Proposal["claims"][number], critiques: Critique[]) {
  const relatedCritiques = critiques.filter(
    (critique) => critique.targetAgentId === proposal.agentId && critique.challengedClaimIds.includes(claim.id)
  );
  const challengePenalty = relatedCritiques.reduce((sum, critique) => sum + severityPenalty(critique.severity), 0);
  const supportCount = 1;
  const challengeCount = relatedCritiques.length;
  const score = clamp01(claim.confidence + supportCount * 0.05 - challengePenalty);
  const disposition = score >= 0.78 && challengeCount <= 1 ? "accepted" : score >= 0.58 ? "monitor" : "rejected";
  const challengedBy = relatedCritiques.map((critique) => critique.agentId);
  const rationale = relatedCritiques.length
    ? `${proposal.agentId} proposed this claim, but ${challengedBy.join(", ")} challenged it during critique.`
    : `${proposal.agentId} proposed this claim and no critique directly displaced it.`;

  return {
    statement: claim.statement,
    sourceAgents: [proposal.agentId],
    supportCount,
    challengeCount,
    score,
    disposition,
    challengedBy,
    rationale
  } satisfies ResolutionTraceItem & { supportCount: number; challengeCount: number };
}

function determineConfidenceBand(
  resolvedClaims: Array<{ disposition: ResolutionTraceItem["disposition"]; score: number; challengeCount: number }>,
  disagreementCount: number,
  uncertaintyCount: number
): Synthesis["confidenceBand"] {
  const acceptedClaims = resolvedClaims.filter((claim) => claim.disposition === "accepted");

  if (acceptedClaims.length === 0) {
    return "low";
  }

  const averageAcceptedScore = acceptedClaims.reduce((sum, claim) => sum + claim.score, 0) / acceptedClaims.length;
  const pressure = disagreementCount * 0.04 + uncertaintyCount * 0.03 + acceptedClaims.reduce((sum, claim) => sum + claim.challengeCount * 0.03, 0);
  const calibratedScore = averageAcceptedScore - pressure;

  if (calibratedScore >= 0.8) {
    return "high";
  }
  if (calibratedScore >= 0.64) {
    return "medium";
  }
  return "low";
}

function severityPenalty(severity: Critique["severity"]): number {
  switch (severity) {
    case "high":
      return 0.17;
    case "medium":
      return 0.1;
    case "low":
      return 0.04;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function toAction(statement: string): string {
  return /^run|add|keep|measure|compare|replace|ship|test|build\b/i.test(statement.trim())
    ? statement.endsWith(".") ? statement : `${statement}.`
    : `Act on this claim: ${statement.toLowerCase()}.`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}