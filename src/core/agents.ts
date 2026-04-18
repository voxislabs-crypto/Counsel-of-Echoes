export const agentIds = ["gpt", "claude", "grok", "voxis"] as const;

export type AgentId = (typeof agentIds)[number];

export type AgentProfile = {
  id: AgentId;
  label: string;
  seat: string;
  role: string;
  color: string;
  accent: string;
  critiqueLens: string;
};

export const agentProfiles: Record<AgentId, AgentProfile> = {
  gpt: {
    id: "gpt",
    label: "GPT",
    seat: "The Strategist",
    role: "Translate the question into a clear plan with concrete next actions.",
    color: "#D95D39",
    accent: "#F4C6A8",
    critiqueLens: "Find missing execution detail, weak sequencing, or unsupported certainty."
  },
  claude: {
    id: "claude",
    label: "Claude",
    seat: "The Analyst",
    role: "Pressure-test assumptions, structure the answer, and surface risks.",
    color: "#2E4057",
    accent: "#BFD7EA",
    critiqueLens: "Find ambiguity, unsupported claims, safety gaps, or vague logic."
  },
  grok: {
    id: "grok",
    label: "Grok",
    seat: "The Contrarian",
    role: "Look for second-order effects, edge cases, and strategic blind spots.",
    color: "#2A7F62",
    accent: "#B9E5D2",
    critiqueLens: "Challenge consensus, expose edge cases, and push on hidden tradeoffs."
  },
  voxis: {
    id: "voxis",
    label: "Voxis",
    seat: "The Humanist",
    role: "Keep the answer grounded in tone, human impact, and emotional coherence.",
    color: "#6E4B7F",
    accent: "#E2D2F0",
    critiqueLens: "Challenge cold logic that ignores user context, motivation, or experience."
  }
};

export function getEnabledAgentIds(includeVoxis: boolean): AgentId[] {
  return includeVoxis ? ["gpt", "claude", "grok", "voxis"] : ["gpt", "claude", "grok"];
}