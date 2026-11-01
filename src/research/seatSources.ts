import type { AgentId } from "../core/agents.js";
import type { EvidenceRetrieval } from "./collectEvidence.js";
import { loadRedditEvidence, type RedditClient } from "./reddit.js";
import type { SourceKind } from "./schemas.js";
import { loadWikipediaEvidence, type WikipediaClient } from "./wikipedia.js";

export type SourceClients = {
  wikipedia?: WikipediaClient;
  reddit?: RedditClient;
};

export type SeatSourceAdapter = {
  seat: "gpt" | "claude" | "grok";
  sourceKind: SourceKind;
  retrieve(query: string, clients?: SourceClients): Promise<EvidenceRetrieval>;
};

// The Strategist reads Wikipedia. The Chaos Gremlin reads Reddit.
// The Analyst has no source yet and reads this same shared bundle.
export const strategistSource: SeatSourceAdapter = {
  seat: "gpt",
  sourceKind: "wikipedia",
  retrieve(query, clients) {
    return loadWikipediaEvidence(query, clients?.wikipedia);
  }
};

export const gremlinSource: SeatSourceAdapter = {
  seat: "grok",
  sourceKind: "reddit",
  retrieve(query, clients) {
    return loadRedditEvidence({ query, client: clients?.reddit });
  }
};

const adapters: Partial<Record<SeatSourceAdapter["seat"], SeatSourceAdapter>> = {
  gpt: strategistSource,
  grok: gremlinSource
};

export function sourceAdapterFor(seat: AgentId): SeatSourceAdapter | undefined {
  if (seat === "voxis") return undefined;
  return adapters[seat];
}
