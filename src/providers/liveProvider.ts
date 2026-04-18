import { agentProfiles, type AgentId } from "../core/agents.js";
import { critiqueSchema, proposalSchema, type Critique, type Proposal } from "../core/schemas.js";
import type { CouncilProvider, CritiqueInput, ProposalInput } from "./types.js";

type LiveProviderKind = "openai" | "anthropic" | "xai";

type LiveProviderConfig = {
  kind: LiveProviderKind;
  apiKey: string;
  modelName: string;
  agentId: AgentId;
};

export class LiveProvider implements CouncilProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly mode = "live" as const;

  constructor(private readonly config: LiveProviderConfig) {
    this.providerName = config.kind;
    this.modelName = config.modelName;
  }

  get agentId(): AgentId {
    return this.config.agentId;
  }

  async propose(input: ProposalInput): Promise<Proposal> {
    const profile = agentProfiles[this.agentId];
    const system = [
      `You are ${profile.label}, seat ${profile.seat}.`,
      profile.role,
      "Return JSON only.",
      "Do not wrap the JSON in markdown.",
      "Follow this shape exactly:",
      JSON.stringify({
        agentId: this.agentId,
        model: this.modelName,
        stance: "string",
        summary: "string",
        claims: [
          {
            id: `${this.agentId}-claim-1`,
            statement: "string",
            rationale: "string",
            confidence: 0.75,
            risk: "string"
          }
        ],
        assumptions: ["string"],
        risks: ["string"],
        confidence: 0.75
      })
    ].join("\n");

    const user = [
      `Question: ${input.question}`,
      input.context ? `Context: ${input.context}` : "Context: none provided",
      `Other seats present: ${input.peers.join(", ")}`,
      "Give 2 to 4 concrete claims. Keep them concise and falsifiable."
    ].join("\n");

    const raw = await this.requestJson(system, user);

    return proposalSchema.parse({
      ...raw,
      agentId: this.agentId,
      model: this.modelName
    });
  }

  async critique(input: CritiqueInput): Promise<Critique> {
    const profile = agentProfiles[this.agentId];
    const system = [
      `You are ${profile.label}, seat ${profile.seat}.`,
      profile.critiqueLens,
      "Return JSON only.",
      "Do not wrap the JSON in markdown.",
      "Follow this shape exactly:",
      JSON.stringify({
        agentId: this.agentId,
        targetAgentId: input.target.agentId,
        challengedClaimIds: [input.target.claims[0]?.id ?? `${input.target.agentId}-claim-1`],
        usefulAgreements: ["string"],
        concerns: ["string"],
        recommendation: "string",
        severity: "medium"
      })
    ].join("\n");

    const user = [
      `Question: ${input.question}`,
      input.context ? `Context: ${input.context}` : "Context: none provided",
      `Target proposal: ${JSON.stringify(input.target)}`,
      `Peer summaries: ${JSON.stringify(input.peers.map((peer) => ({ agentId: peer.agentId, summary: peer.summary })))} `,
      "Challenge weak logic, preserve strong ideas, and avoid rewriting the whole answer."
    ].join("\n");

    const raw = await this.requestJson(system, user);

    return critiqueSchema.parse({
      ...raw,
      agentId: this.agentId,
      targetAgentId: input.target.agentId
    });
  }

  private async requestJson(system: string, user: string): Promise<Record<string, unknown>> {
    switch (this.config.kind) {
      case "openai":
      case "xai":
        return this.requestOpenAiCompatible(system, user);
      case "anthropic":
        return this.requestAnthropic(system, user);
    }
  }

  private async requestOpenAiCompatible(system: string, user: string) {
    const endpoint = this.config.kind === "xai"
      ? "https://api.x.ai/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.modelName,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.4,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      throw new Error(`${this.config.kind} request failed with ${response.status}`);
    }

    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(`${this.config.kind} returned an empty response`);
    }

    return parseJsonObject(content);
  }

  private async requestAnthropic(system: string, user: string) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.config.modelName,
        max_tokens: 1200,
        temperature: 0.4,
        system,
        messages: [
          {
            role: "user",
            content: user
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`anthropic request failed with ${response.status}`);
    }

    const body = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const content = body.content?.find((item) => item.type === "text")?.text;

    if (!content) {
      throw new Error("anthropic returned an empty response");
    }

    return parseJsonObject(content);
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  const trimmed = value.trim();

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Response did not include a JSON object");
    }

    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
}