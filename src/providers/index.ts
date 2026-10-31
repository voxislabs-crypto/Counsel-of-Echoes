import { agentProfiles, getEnabledAgentIds } from "../core/agents.js";
import type { AgentId } from "../core/agents.js";
import type { CouncilProvider, ProviderMode } from "./types.js";
import { LiveProvider } from "./liveProvider.js";
import { MockProvider } from "./mockProvider.js";
import { createOllamaProvider } from "./ollamaProvider.js";

const ollamaSeats = ["gpt", "claude", "grok"] as const;

export type RuntimeConfig = {
  port: number;
  providerMode: ProviderMode;
  includeVoxis: boolean;
  ollamaUrl: string;
  openAiKey?: string;
  openAiModel: string;
  anthropicKey?: string;
  anthropicModel: string;
  xAiKey?: string;
  xAiModel: string;
  baselineAgent: AgentId;
  voxisContext: boolean;
  voxisUrl: string;
  voxisSecret?: string;
  voxisTimeoutMs: number;
  voxisMaxChars: number;
};

export function readRuntimeConfig(): RuntimeConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    providerMode: readProviderMode(process.env.COE_PROVIDER_MODE),
    includeVoxis: process.env.COE_INCLUDE_VOXIS === "true",
    ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    openAiKey: process.env.OPENAI_API_KEY,
    openAiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-3-7-sonnet-latest",
    xAiKey: process.env.XAI_API_KEY,
    xAiModel: process.env.XAI_MODEL ?? "grok-3-mini",
    baselineAgent: readBaselineAgent(process.env.COE_BASELINE_AGENT),
    voxisContext: process.env.VOXIS_CONTEXT !== "false",
    voxisUrl: process.env.VOXIS_URL ?? "http://127.0.0.1:3101",
    voxisSecret: process.env.VOXIS_INTERNAL_SECRET,
    voxisTimeoutMs: readBoundedInt(process.env.VOXIS_TIMEOUT_MS, 1200, 200, 4000),
    voxisMaxChars: readBoundedInt(process.env.VOXIS_MAX_CHARS, 700, 500, 800)
  };
}

export function readProviderMode(value: string | undefined): ProviderMode {
  return value === "live" || value === "ollama" ? value : "mock";
}

export function createProviders(config: RuntimeConfig, modeOverride?: ProviderMode): CouncilProvider[] {
  const mode = modeOverride ?? config.providerMode;
  const enabledAgents = getEnabledAgentIds(config.includeVoxis);

  if (mode === "ollama") {
    // Three local seats only. Voxis stays out so the machine is not running four inferences at once.
    return ollamaSeats.map((agentId) => createOllamaProvider({
      agentId,
      baseUrl: config.ollamaUrl,
      systemPrompt: seatSystemPrompt(agentId)
    }));
  }

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

export function createProviderForAgent(
  config: RuntimeConfig,
  agentId: AgentId,
  modeOverride?: ProviderMode
): CouncilProvider {
  const providers = createProviders(config, modeOverride);
  return providers.find((provider) => provider.agentId === agentId) ?? providers[0];
}

function seatSystemPrompt(agentId: (typeof ollamaSeats)[number]): string {
  const profile = agentProfiles[agentId];
  const voice = agentId === "grok"
    ? " Tone: direct, impatient, sarcastic, and brutally honest. Cut bullshit and refuse analysis paralysis."
    : "";

  return `You are ${profile.label}, seat ${profile.seat}. ${profile.role} Critique lens: ${profile.critiqueLens}.${voice}`;
}

function readBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function readBaselineAgent(value: string | undefined): AgentId {
  switch (value) {
    case "claude":
    case "grok":
    case "voxis":
      return value;
    default:
      return "gpt";
  }
}