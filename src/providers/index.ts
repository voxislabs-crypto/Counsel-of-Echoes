import { getEnabledAgentIds } from "../core/agents.js";
import type { CouncilProvider, ProviderMode } from "./types.js";
import { LiveProvider } from "./liveProvider.js";
import { MockProvider } from "./mockProvider.js";

export type RuntimeConfig = {
  port: number;
  providerMode: ProviderMode;
  includeVoxis: boolean;
  openAiKey?: string;
  openAiModel: string;
  anthropicKey?: string;
  anthropicModel: string;
  xAiKey?: string;
  xAiModel: string;
};

export function readRuntimeConfig(): RuntimeConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    providerMode: process.env.COE_PROVIDER_MODE === "live" ? "live" : "mock",
    includeVoxis: process.env.COE_INCLUDE_VOXIS === "true",
    openAiKey: process.env.OPENAI_API_KEY,
    openAiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-3-7-sonnet-latest",
    xAiKey: process.env.XAI_API_KEY,
    xAiModel: process.env.XAI_MODEL ?? "grok-3-mini"
  };
}

export function createProviders(config: RuntimeConfig, modeOverride?: ProviderMode): CouncilProvider[] {
  const mode = modeOverride ?? config.providerMode;
  const enabledAgents = getEnabledAgentIds(config.includeVoxis);

  if (mode === "live") {
    const liveProviders: CouncilProvider[] = [];

    if (enabledAgents.includes("gpt") && config.openAiKey) {
      liveProviders.push(new LiveProvider({
        kind: "openai",
        apiKey: config.openAiKey,
        modelName: config.openAiModel,
        agentId: "gpt"
      }));
    }

    if (enabledAgents.includes("claude") && config.anthropicKey) {
      liveProviders.push(new LiveProvider({
        kind: "anthropic",
        apiKey: config.anthropicKey,
        modelName: config.anthropicModel,
        agentId: "claude"
      }));
    }

    if (enabledAgents.includes("grok") && config.xAiKey) {
      liveProviders.push(new LiveProvider({
        kind: "xai",
        apiKey: config.xAiKey,
        modelName: config.xAiModel,
        agentId: "grok"
      }));
    }

    if (enabledAgents.includes("voxis")) {
      liveProviders.push(new MockProvider("voxis"));
    }

    if (liveProviders.length >= 2) {
      return liveProviders;
    }
  }

  return enabledAgents.map((agentId) => new MockProvider(agentId));
}