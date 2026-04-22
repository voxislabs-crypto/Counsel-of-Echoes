import { agentProfiles, type AgentId } from "../core/agents.js";
import { critiqueSchema, proposalSchema, type Critique, type Proposal, type Synthesis } from "../core/schemas.js";
import { buildHeuristicJudgeSynthesis } from "../core/judge.js";
import type { CouncilProvider, CritiqueInput, ProposalInput, SynthesisInput } from "./types.js";

const stanceTemplates: Record<AgentId, string> = {
  gpt: "Turn the question into a sequence of decisions with clear tradeoffs.",
  claude: "Reduce ambiguity, highlight structure, and define the safest strong answer.",
  grok: "Stress the plan against edge cases and second-order consequences.",
  voxis: "Keep the answer aligned with human needs, motivation, and tone."
};

export class MockProvider implements CouncilProvider {
  readonly providerName = "mock";
  readonly modelName: string;
  readonly mode = "mock" as const;

  constructor(readonly agentId: AgentId) {
    this.modelName = `mock-${agentId}`;
  }

  async propose(input: ProposalInput): Promise<Proposal> {
    const profile = agentProfiles[this.agentId];
    const subject = summarizeQuestion(input.question);
    const claims = buildClaims(this.agentId, subject);
    const proposal: Proposal = {
      agentId: this.agentId,
      model: this.modelName,
      stance: stanceTemplates[this.agentId],
      summary: `${profile.seat} sees the best path as a disciplined response to ${subject.toLowerCase()}, with emphasis on ${claims[0].statement.toLowerCase()}.`,
      claims,
      assumptions: buildAssumptions(this.agentId, subject),
      risks: buildRisks(this.agentId, subject),
      confidence: confidenceForAgent(this.agentId)
    };

    return proposalSchema.parse(proposal);
  }

  async critique(input: CritiqueInput): Promise<Critique> {
    const profile = agentProfiles[this.agentId];
    const targetClaim = input.target.claims[0];
    const critique: Critique = {
      agentId: this.agentId,
      targetAgentId: input.target.agentId,
      challengedClaimIds: input.target.claims.slice(0, 2).map((claim) => claim.id),
      usefulAgreements: [
        `${profile.label} agrees that ${input.target.claims[0].statement.toLowerCase()}`
      ],
      concerns: buildConcerns(this.agentId, targetClaim.statement),
      recommendation: buildRecommendation(this.agentId, input.target.agentId),
      severity: severityForAgent(this.agentId)
    };

    return critiqueSchema.parse(critique);
  }

  async synthesize(input: SynthesisInput): Promise<Synthesis> {
    return buildHeuristicJudgeSynthesis(input.question, input.proposals, input.critiques, input.resolutionTrace);
  }
}

function summarizeQuestion(question: string): string {
  return question.replace(/\s+/g, " ").trim().slice(0, 140);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 36);
}

function buildClaims(agentId: AgentId, subject: string) {
  const claimSets: Record<AgentId, Array<Omit<Proposal["claims"][number], "id">>> = {
    gpt: [
      {
        statement: `Start with a narrow first release for ${subject}`,
        rationale: "A constrained first release makes it easier to measure whether structured disagreement improves the answer.",
        confidence: 0.82,
        risk: "A broad launch hides whether the council itself adds value."
      },
      {
        statement: "Use one shared context packet for every participant",
        rationale: "Shared grounding keeps the council from fragmenting into competing realities.",
        confidence: 0.78,
        risk: "Independent context gathering creates citation drift and noisy synthesis."
      },
      {
        statement: "Measure outcome quality against a single-model baseline",
        rationale: "Without a baseline, the council can feel impressive while delivering no measurable improvement.",
        confidence: 0.84,
        risk: "A dramatic interface can disguise weak reasoning gains."
      }
    ],
    claude: [
      {
        statement: `Define strict schemas before expanding ${subject}`,
        rationale: "Typed proposals and critiques are what make the orchestration inspectable and repairable.",
        confidence: 0.86,
        risk: "Free-form prose becomes difficult to merge and impossible to audit reliably."
      },
      {
        statement: "Keep critique to a single bounded pass",
        rationale: "One critique round surfaces contradictions without letting the loop drift into rhetorical noise.",
        confidence: 0.81,
        risk: "Long debates increase cost and variance faster than quality."
      },
      {
        statement: "Separate factual synthesis from presentation styling",
        rationale: "Truth should be derived once, then rendered theatrically without changing meaning.",
        confidence: 0.89,
        risk: "Early personality overlays can corrupt confidence and salience."
      }
    ],
    grok: [
      {
        statement: `Design ${subject} for disagreement, not consensus theater`,
        rationale: "If every participant sounds smart in the same way, the council just averages style.",
        confidence: 0.79,
        risk: "Homogeneous prompts produce fake diversity."
      },
      {
        statement: "Surface unresolved conflicts instead of forcing agreement",
        rationale: "Users trust the verdict more when the system preserves legitimate uncertainty.",
        confidence: 0.77,
        risk: "Forced consensus hides the exact edge cases the council should expose."
      },
      {
        statement: "Treat timing and budget as first-class product constraints",
        rationale: "A slow or expensive council will only be used for a small slice of questions.",
        confidence: 0.8,
        risk: "Ignoring latency makes the system feel theatrical instead of useful."
      }
    ],
    voxis: [
      {
        statement: `Keep ${subject} legible to humans, not just technically correct`,
        rationale: "The final answer should preserve empathy, motivation, and the user's actual decision pressure.",
        confidence: 0.75,
        risk: "Purely analytical outputs can be right and still fail the user."
      },
      {
        statement: "Make the deliberation visible without leaking internal chaos",
        rationale: "A clean narrative layer builds trust while the underlying state machine stays disciplined.",
        confidence: 0.74,
        risk: "Raw transcript dumps reduce confidence instead of increasing it."
      },
      {
        statement: "Render personalities after synthesis, not before",
        rationale: "That preserves the factual core while still giving the council dramatic identity.",
        confidence: 0.78,
        risk: "Roleplay inside the reasoning loop will distort priorities."
      }
    ]
  };

  return claimSets[agentId].map((claim, index) => ({
    id: `${agentId}-${slugify(claim.statement)}-${index + 1}`,
    ...claim
  }));
}

function buildAssumptions(agentId: AgentId, subject: string): string[] {
  const assumptions: Record<AgentId, string[]> = {
    gpt: [
      `${subject} can be improved incrementally instead of requiring a full-platform rewrite.`,
      "The first release should optimize for learnings rather than completeness."
    ],
    claude: [
      "The system can enforce JSON outputs consistently across providers.",
      "The council should be explainable enough to debug when providers disagree."
    ],
    grok: [
      "Different providers will produce materially different perspectives for this question class.",
      "Users will tolerate extra latency when the task is high value or ambiguous."
    ],
    voxis: [
      "Users care about how the verdict feels, not only what it says.",
      "A strong narrative layer can increase trust without weakening factual rigor."
    ]
  };

  return assumptions[agentId];
}

function buildRisks(agentId: AgentId, subject: string): string[] {
  const risks: Record<AgentId, string[]> = {
    gpt: [
      `If ${subject.toLowerCase()} ships too wide, it will be hard to tell which component improved the output.`,
      "Without a baseline, complexity masquerades as intelligence."
    ],
    claude: [
      "Loose schema enforcement will make synthesis brittle.",
      "Long critique loops will inflate token cost without stabilizing quality."
    ],
    grok: [
      "The providers may agree stylistically while missing the same blind spot.",
      "Consensus can be overvalued even when legitimate uncertainty remains."
    ],
    voxis: [
      "An over-clinical verdict can lose the user even if it is technically strong.",
      "Too much theater too early can distract from whether the council is genuinely useful."
    ]
  };

  return risks[agentId];
}

function buildConcerns(agentId: AgentId, targetStatement: string): string[] {
  const concerns: Record<AgentId, string[]> = {
    gpt: [
      `The claim "${targetStatement}" needs a clearer execution sequence.`,
      "The proposal should define what success looks like after the first release."
    ],
    claude: [
      `The claim "${targetStatement}" may be right, but it is underspecified.`,
      "The proposal should state what evidence would falsify its confidence."
    ],
    grok: [
      `The claim "${targetStatement}" ignores at least one second-order consequence.`,
      "The proposal risks sounding solid without proving its tradeoffs."
    ],
    voxis: [
      `The claim "${targetStatement}" could land as correct but emotionally tone-deaf.`,
      "The proposal needs to explain why the user should trust this path."
    ]
  };

  return concerns[agentId];
}

function buildRecommendation(agentId: AgentId, targetAgentId: AgentId): string {
  const recommendations: Record<AgentId, string> = {
    gpt: `Keep ${targetAgentId}'s core point, but turn it into a more explicit plan with a measurable next step.`,
    claude: `Retain ${targetAgentId}'s strongest insight, but tighten the claim boundaries and confidence.`,
    grok: `Keep ${targetAgentId}'s useful angle, but force it to address the hardest edge case directly.`,
    voxis: `Keep ${targetAgentId}'s logic, but make the final recommendation easier for a human to act on.`
  };

  return recommendations[agentId];
}

function confidenceForAgent(agentId: AgentId): number {
  return {
    gpt: 0.82,
    claude: 0.87,
    grok: 0.79,
    voxis: 0.76
  }[agentId];
}

function severityForAgent(agentId: AgentId): Critique["severity"] {
  const severities: Record<AgentId, Critique["severity"]> = {
    gpt: "medium",
    claude: "high",
    grok: "medium",
    voxis: "low"
  };

  return severities[agentId];
}