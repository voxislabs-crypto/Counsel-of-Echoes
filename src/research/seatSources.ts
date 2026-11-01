import type { AgentId } from "../core/agents.js";
import type { EvidenceRetrieval } from "./collectEvidence.js";
import { loadRedditEvidence, type RedditClient } from "./reddit.js";
import { loadScholarEvidence, type ScholarClient } from "./scholar.js";
import type { SourceKind } from "./schemas.js";
import { loadWikipediaEvidence, type WikipediaClient } from "./wikipedia.js";

export type SourceClients = {
  wikipedia?: WikipediaClient;
  reddit?: RedditClient;
  scholar?: ScholarClient;
};

export type SeatSourceAdapter = {
  seat: "gpt" | "claude" | "grok";
  sourceKind: SourceKind;
  retrieve(query: string, clients?: SourceClients): Promise<EvidenceRetrieval>;
};

// The Strategist reads Wikipedia, the Analyst reads Semantic Scholar,
// and the Chaos Gremlin reads Reddit. One research-on run shares all three.
export const strategistSource: SeatSourceAdapter = {
  seat: "gpt",
  sourceKind: "wikipedia",
  retrieve(query, clients) {
    return loadWikipediaEvidence(query, clients?.wikipedia);
  }
};

export const analystSource: SeatSourceAdapter = {
  seat: "claude",
  sourceKind: "scholar",
  retrieve(query, clients) {
    return loadScholarEvidence({ query, client: clients?.scholar });
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
  claude: analystSource,
  grok: gremlinSource
};

export function sourceAdapterFor(seat: AgentId): SeatSourceAdapter | undefined {
  if (seat === "voxis") return undefined;
  return adapters[seat];
}
