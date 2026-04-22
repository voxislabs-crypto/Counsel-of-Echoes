import type { AgentId } from "./agents.js";
import {
  runRequestSchema,
  type RunRequest,
  type RunRecord
} from "./schemas.js";
import { buildHeuristicJudgeSynthesis, buildResolutionTrace } from "./judge.js";
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

      const judgeProvider = chooseJudgeProvider(providers);
      await this.store.appendEvent(runId, {
        runId,
        type: "synthesis.started",
        payload: {
          proposalCount: proposals.length,
          critiqueCount: critiques.length,
          judgeAgentId: judgeProvider.agentId
        }
      });

      const resolutionTrace = buildResolutionTrace(proposals, critiques);
      const synthesis = await judgeProvider
        .synthesize({
          question: request.question,
          context: request.context,
          proposals,
          critiques,
          resolutionTrace
        })
        .catch(() => buildHeuristicJudgeSynthesis(request.question, proposals, critiques, resolutionTrace));

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

function chooseJudgeProvider(providers: CouncilProvider[]): CouncilProvider {
  const preferredOrder: AgentId[] = ["claude", "gpt", "grok", "voxis"];

  for (const preferred of preferredOrder) {
    const provider = providers.find((candidate) => candidate.agentId === preferred);
    if (provider) {
      return provider;
    }
  }

  return providers[0];
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
