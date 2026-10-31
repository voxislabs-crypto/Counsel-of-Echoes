import type { AgentId } from "./agents.js";
import {
  runRequestSchema,
  type RunRequest,
  type RunRecord,
  type Synthesis
} from "./schemas.js";
import { buildHeuristicJudgeSynthesis, buildResolutionTrace } from "./judge.js";
import type { CouncilProvider, ProviderMode } from "../providers/types.js";
import { createProviders, type RuntimeConfig } from "../providers/index.js";
import { RunStore } from "../store/runStore.js";
import { gather, stripUnknownEvidenceIds, stripUnknownFindings } from "../research/service.js";
import type { EvidenceBundle } from "../research/schemas.js";
import {
  createVoxisContextClient,
  loadSeatContexts,
  moodDeltaForBand,
  type VoxisContextClient
} from "../providers/voxisContext.js";

export class CouncilService {
  private readonly voxis: VoxisContextClient;

  constructor(
    private readonly store: RunStore,
    private readonly config: RuntimeConfig,
    voxis: VoxisContextClient = createVoxisContextClient(config)
  ) {
    this.voxis = voxis;
  }

  async startRun(input: unknown): Promise<{ runId: string; mode: ProviderMode; agents: AgentId[] }> {
    const request = runRequestSchema.parse(input);
    const providers = createProviders(this.config, request.mode);
    const mode = resolveRunMode(providers);
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
    const mode = resolveRunMode(providers);
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

      const evidence = await this.gatherEvidence(runId, request, mode);
      let unknownEvidenceIdsStripped = 0;
      const topic = [request.question, request.context].filter(Boolean).join("\n");
      const voxisContexts = await loadSeatContexts(
        this.voxis,
        providers.map((provider) => provider.agentId),
        topic,
        mode === "ollama" && this.config.voxisContext
      );

      if (mode === "ollama") {
        await this.store.appendEvent(runId, {
          runId,
          type: "voxis.context",
          payload: {
            seats: providers.map((provider) => ({
              agentId: provider.agentId,
              chars: (voxisContexts.get(provider.agentId) || "").length,
              context: voxisContexts.get(provider.agentId) || ""
            }))
          }
        });
      }

      const proposals = await Promise.all(
        providers.map(async (provider) => {
          const voxisContext = voxisContexts.get(provider.agentId) || "";
          await this.store.appendEvent(runId, {
            runId,
            type: "proposal.started",
            agentId: provider.agentId,
            payload: {
              providerName: provider.providerName,
              modelName: provider.modelName,
              voxisContext
            }
          });

          const proposed = await provider.propose({
            question: request.question,
            context: request.context,
            peers: providers.map((candidate) => candidate.agentId).filter((agentId) => agentId !== provider.agentId),
            evidence,
            voxisContext
          });
          const sanitized = stripUnknownEvidenceIds(proposed.claims, evidence);
          unknownEvidenceIdsStripped += sanitized.stripped;
          const proposal = {
            ...proposed,
            claims: sanitized.claims
          };

          await this.streamText(runId, provider.agentId, proposal.summary);
          await this.store.appendEvent(runId, {
            runId,
            type: "proposal.completed",
            agentId: provider.agentId,
            payload: {
              proposal,
              unknownEvidenceIdsStripped: sanitized.stripped
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

          const drafted = await provider.critique({
            question: request.question,
            context: request.context,
            target,
            peers: proposals.filter((proposal) => proposal.agentId !== provider.agentId),
            evidence
          });
          const sanitizedFindings = stripUnknownFindings(drafted.evidenceFindings, evidence);
          unknownEvidenceIdsStripped += sanitizedFindings.stripped;
          const critique = {
            ...drafted,
            evidenceFindings: sanitizedFindings.findings
          };

          await this.store.appendEvent(runId, {
            runId,
            type: "critique.completed",
            agentId: provider.agentId,
            payload: {
              critique,
              unknownEvidenceIdsStripped: sanitizedFindings.stripped
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
          judgeAgentId: judgeProvider.agentId,
          unknownEvidenceIdsStripped
        }
      });

      const resolutionTrace = buildResolutionTrace(proposals, critiques, evidence);
      let synthesis: Synthesis;
      try {
        synthesis = await judgeProvider.synthesize({
          question: request.question,
          context: request.context,
          proposals,
          critiques,
          resolutionTrace,
          evidence
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Judge synthesis failed";
        await this.store.appendEvent(runId, {
          runId,
          type: "synthesis.fallback",
          payload: {
            judgeAgentId: judgeProvider.agentId,
            message
          }
        });
        synthesis = buildHeuristicJudgeSynthesis(request.question, proposals, critiques, resolutionTrace, evidence);
      }

      await this.store.appendEvent(runId, {
        runId,
        type: "synthesis.completed",
        payload: {
          synthesis
        }
      });

      if (mode === "ollama" && this.config.voxisContext) {
        void this.voxis.writeRound({
          topic: request.question,
          outcome: synthesis.finalAnswer,
          moodDelta: moodDeltaForBand(synthesis.confidenceBand),
          seats: providers.map((provider) => provider.agentId)
        }).then((result) => {
          void this.store.appendEvent(runId, {
            runId,
            type: "voxis.write",
            payload: result
          }).catch(() => undefined);
        });
      }

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

  private async gatherEvidence(runId: string, request: RunRequest, mode: ProviderMode): Promise<EvidenceBundle | undefined> {
    if (!request.research) {
      return undefined;
    }

    await this.store.appendEvent(runId, {
      runId,
      type: "research.started",
      payload: {
        query: request.question
      }
    });

    const evidence = await gather({
      query: request.question,
      mode
    });
    await this.store.setEvidence(runId, evidence);

    if (evidence.status === "empty") {
      await this.store.appendEvent(runId, {
        runId,
        type: "research.failed",
        payload: {
          query: evidence.query,
          status: evidence.status
        }
      });
      return evidence;
    }

    await this.store.appendEvent(runId, {
      runId,
      type: "research.completed",
      payload: {
        query: evidence.query,
        status: evidence.status,
        itemCount: evidence.items.length
      }
    });

    return evidence;
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

function resolveRunMode(providers: CouncilProvider[]): ProviderMode {
  if (providers.every((provider) => provider.mode === "ollama")) {
    return "ollama";
  }

  return providers.every((provider) => provider.mode === "mock") ? "mock" : "live";
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
