import type { AgentId } from "../core/agents.js";

export type VoxisContextConfig = {
  voxisContext: boolean;
  voxisUrl: string;
  voxisSecret?: string;
  voxisTimeoutMs: number;
  voxisMaxChars: number;
};

export type VoxisRoundWrite = {
  topic: string;
  outcome: string;
  moodDelta?: {
    valence: number;
    arousal: number;
    dominance: number;
  };
  seats: AgentId[];
};

export type VoxisWriteResult = {
  ok: boolean;
  written: number;
};

export type VoxisContextClient = {
  fetchSeatContext(seatId: AgentId, topic: string): Promise<string>;
  writeRound(input: VoxisRoundWrite): Promise<VoxisWriteResult>;
};

export function moodDeltaForBand(band: string): VoxisRoundWrite["moodDelta"] {
  if (band === "high") return { valence: 0.05, arousal: 0, dominance: 0.05 };
  if (band === "low") return { valence: -0.05, arousal: 0.05, dominance: -0.05 };
  return { valence: 0, arousal: 0, dominance: 0 };
}

export function createVoxisContextClient(config: VoxisContextConfig): VoxisContextClient {
  const baseUrl = config.voxisUrl.replace(/\/$/, "");

  return {
    async fetchSeatContext(seatId, topic) {
      if (!config.voxisContext) return "";

      try {
        const response = await fetch(`${baseUrl}/api/internal/context`, {
          method: "POST",
          headers: voxisHeaders(config.voxisSecret),
          body: JSON.stringify({
            seatId,
            topic: topic.slice(0, 500),
            maxChars: config.voxisMaxChars
          }),
          signal: AbortSignal.timeout(config.voxisTimeoutMs)
        });

        if (!response.ok) return "";

        const body = await response.json() as { context?: unknown };
        return String(body.context || "").trim().slice(0, config.voxisMaxChars);
      } catch {
        return "";
      }
    },

    async writeRound(input) {
      if (!config.voxisContext) return { ok: false, written: 0 };

      try {
        const response = await fetch(`${baseUrl}/api/internal/round`, {
          method: "POST",
          headers: voxisHeaders(config.voxisSecret),
          body: JSON.stringify({
            topic: input.topic.slice(0, 500),
            outcome: input.outcome.slice(0, 600),
            moodDelta: input.moodDelta,
            seats: input.seats.map((seatId) => ({ seatId }))
          }),
          signal: AbortSignal.timeout(config.voxisTimeoutMs)
        });

        if (!response.ok) return { ok: false, written: 0 };

        const body = await response.json() as { written?: unknown };
        const written = Array.isArray(body.written) ? body.written.length : 0;
        return { ok: true, written };
      } catch {
        return { ok: false, written: 0 };
      }
    }
  };
}

export async function loadSeatContexts(
  client: VoxisContextClient,
  agentIds: AgentId[],
  topic: string,
  enabled: boolean
): Promise<Map<AgentId, string>> {
  const contexts = new Map<AgentId, string>();

  if (!enabled) {
    for (const agentId of agentIds) contexts.set(agentId, "");
    return contexts;
  }

  await Promise.all(agentIds.map(async (agentId) => {
    try {
      contexts.set(agentId, await client.fetchSeatContext(agentId, topic));
    } catch {
      contexts.set(agentId, "");
    }
  }));

  return contexts;
}

function voxisHeaders(secret?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-Voxis-Internal-Key"] = secret;
  return headers;
}
