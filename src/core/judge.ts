import { agentProfiles } from "./agents.js";
import {
  synthesisSchema,
  type Critique,
  type Proposal,
  type ResolutionTraceItem,
  type Synthesis
} from "./schemas.js";

type ResolvedClaim = ResolutionTraceItem & {
  supportCount: number;
  challengeCount: number;
};

export function buildResolutionTrace(proposals: Proposal[], critiques: Critique[]): ResolutionTraceItem[] {
  return resolveClaims(proposals, critiques)
    .slice(0, 12)
    .map((claim) => ({
      statement: claim.statement,
      disposition: claim.disposition,
      sourceAgents: claim.sourceAgents,
      challengedBy: claim.challengedBy,
      score: claim.score,
      rationale: claim.rationale
    }));
}

export function buildHeuristicJudgeSynthesis(
  question: string,
  proposals: Proposal[],
  critiques: Critique[],
  resolutionTraceInput?: ResolutionTraceItem[]
): Synthesis {
  const resolvedClaims = hydrateResolvedClaims(proposals, critiques, resolutionTraceInput);
  const acceptedClaims = resolvedClaims.filter((claim) => claim.disposition === "accepted").slice(0, 5);
  const monitoredClaims = resolvedClaims.filter((claim) => claim.disposition === "monitor").slice(0, 5);

  const supportingClaims = (acceptedClaims.length > 0 ? acceptedClaims : resolvedClaims.slice(0, 5)).map((claim) => ({
    statement: claim.statement,
    sourceAgents: claim.sourceAgents,
    supportCount: claim.supportCount,
    challengeCount: claim.challengeCount,
    confidence: claim.score
  }));

  const disagreements = [
    ...critiques
      .filter((critique) => critique.severity !== "low")
      .map((critique) => {
        const critic = agentProfiles[critique.agentId].label;
        const target = agentProfiles[critique.targetAgentId].label;
        return `${critic} challenges ${target}: ${critique.concerns[0]}`;
      }),
    ...monitoredClaims.map((claim) => `The chamber is still monitoring: ${claim.statement}. ${claim.rationale}`)
  ].slice(0, 6);

  const uncertainties = [
    ...monitoredClaims.map((claim) => claim.statement),
    ...new Set([
      ...proposals.flatMap((proposal) => proposal.assumptions),
      ...proposals.flatMap((proposal) => proposal.risks)
    ])
  ].slice(0, 6);

  const nextActions = unique([
    ...acceptedClaims.slice(0, 2).map((claim) => toAction(claim.statement)),
    ...critiques.slice(0, 2).map((critique) => critique.recommendation),
    monitoredClaims[0] ? `Validate whether ${monitoredClaims[0].statement.toLowerCase()} should stay in the final verdict.` : undefined,
    "Run the same prompt against the single strongest baseline model and compare quality."
  ]).slice(0, 5);

  const viewpoints = proposals.map((proposal) => {
    const strongestClaim = resolvedClaims.find((claim) => claim.sourceAgents.includes(proposal.agentId)) ?? resolvedClaims[0];
    return {
      agentId: proposal.agentId,
      perspective: proposal.summary,
      primaryClaim: strongestClaim?.statement ?? proposal.claims[0]?.statement ?? proposal.summary,
      disposition: strongestClaim?.disposition ?? "monitor"
    };
  });

  const votes = viewpoints.map((viewpoint) => ({
    agentId: viewpoint.agentId,
    ballot: viewpoint.disposition,
    reason: `${agentProfiles[viewpoint.agentId].label} prioritizes ${viewpoint.primaryClaim.toLowerCase()}.`
  }));

  const voteCounts = tallyVotes(votes);
  const winningDisposition = pickWinningDisposition(voteCounts, acceptedClaims.length, monitoredClaims.length);
  const agreementState = Object.values(voteCounts).filter((count) => count > 0).length === 1 ? "full-agreement" : "disagreement";
  const voteRequired = agreementState === "disagreement";

  const consensusSummary = voteRequired
    ? `Disagreement remained after critique, so the chamber used a majority vote and selected ${winningDisposition} (${voteCounts.accepted}-${voteCounts.monitor}-${voteCounts.rejected}).`
    : `All seats converged on ${winningDisposition}, so no tie-break vote was required.`;

  const decisionRationale = {
    summary: voteRequired
      ? `The council selected ${winningDisposition} because it won the seat vote after critique pressure was applied to each claim.`
      : `The council selected ${winningDisposition} because every seat converged after critique and no escalation vote was needed.`,
    keyFactors: unique([
      `Vote distribution was ${voteCounts.accepted} accepted, ${voteCounts.monitor} monitor, and ${voteCounts.rejected} rejected.`,
      `Top accepted claims: ${acceptedClaims.slice(0, 2).map((claim) => claim.statement).join("; ") || "none"}.`,
      `Highest remaining tension: ${disagreements[0] ?? "none surfaced"}.`,
      `Confidence band calibrated to ${determineConfidenceBand(resolvedClaims, disagreements.length, uncertainties.length)} based on accepted-claim strength and unresolved pressure.`
    ]).slice(0, 4)
  };

  const confidenceBand = determineConfidenceBand(resolvedClaims, disagreements.length, uncertainties.length);
  const resolutionTrace = resolvedClaims.slice(0, 8).map((claim) => ({
    statement: claim.statement,
    disposition: claim.disposition,
    sourceAgents: claim.sourceAgents,
    challengedBy: claim.challengedBy,
    score: claim.score,
    rationale: claim.rationale
  }));

  const viewpointSummary = viewpoints
    .map((viewpoint) => `${agentProfiles[viewpoint.agentId].label}: ${viewpoint.primaryClaim}`)
    .join(" | ");

  const finalAnswer = [
    `Viewpoints: ${viewpointSummary}`,
    `Agreement Check: ${agreementState === "full-agreement" ? "full-agreement" : "disagreement"}`,
    voteRequired
      ? `Vote: required (2-of-3 rule), result ${voteCounts.accepted}-${voteCounts.monitor}-${voteCounts.rejected}`
      : "Vote: not required",
    `Final Decision: ${winningDisposition}. ${consensusSummary}`
  ].join("\n");

  return synthesisSchema.parse({
    finalAnswer,
    supportingClaims,
    disagreements,
    uncertainties,
    confidenceBand,
    nextActions,
    resolutionTrace,
    deliberation: {
      agreementState,
      viewpoints,
      voteRequired,
      votes,
      winningDisposition,
      consensusSummary
    },
    decisionRationale
  });
}

function hydrateResolvedClaims(
  proposals: Proposal[],
  critiques: Critique[],
  resolutionTraceInput?: ResolutionTraceItem[]
): ResolvedClaim[] {
  if (!resolutionTraceInput || resolutionTraceInput.length === 0) {
    return resolveClaims(proposals, critiques);
  }

  return resolutionTraceInput
    .map((item) => ({
      ...item,
      supportCount: Math.max(1, item.sourceAgents.length),
      challengeCount: item.challengedBy.length
    }))
    .sort((left, right) => right.score - left.score);
}

function resolveClaims(proposals: Proposal[], critiques: Critique[]): ResolvedClaim[] {
  return proposals
    .flatMap((proposal) => proposal.claims.map((claim) => buildResolvedClaim(proposal, claim, critiques)))
    .sort((left, right) => right.score - left.score);
}

function buildResolvedClaim(proposal: Proposal, claim: Proposal["claims"][number], critiques: Critique[]): ResolvedClaim {
  const relatedCritiques = critiques.filter(
    (critique) => critique.targetAgentId === proposal.agentId && critique.challengedClaimIds.includes(claim.id)
  );
  const challengePenalty = relatedCritiques.reduce((sum, critique) => sum + severityPenalty(critique.severity), 0);
  const supportCount = 1;
  const challengeCount = relatedCritiques.length;
  const score = clamp01(claim.confidence + supportCount * 0.05 - challengePenalty);
  const disposition = score >= 0.78 && challengeCount <= 1 ? "accepted" : score >= 0.58 ? "monitor" : "rejected";
  const challengedBy = relatedCritiques.map((critique) => critique.agentId);
  const rationale = relatedCritiques.length
    ? `${proposal.agentId} proposed this claim, but ${challengedBy.join(", ")} challenged it during critique.`
    : `${proposal.agentId} proposed this claim and no critique directly displaced it.`;

  return {
    statement: claim.statement,
    sourceAgents: [proposal.agentId],
    supportCount,
    challengeCount,
    score,
    disposition,
    challengedBy,
    rationale
  };
}

function determineConfidenceBand(
  resolvedClaims: Array<{ disposition: ResolutionTraceItem["disposition"]; score: number; challengeCount: number }>,
  disagreementCount: number,
  uncertaintyCount: number
): Synthesis["confidenceBand"] {
  const acceptedClaims = resolvedClaims.filter((claim) => claim.disposition === "accepted");

  if (acceptedClaims.length === 0) {
    return "low";
  }

  const averageAcceptedScore = acceptedClaims.reduce((sum, claim) => sum + claim.score, 0) / acceptedClaims.length;
  const pressure = disagreementCount * 0.04 + uncertaintyCount * 0.03 + acceptedClaims.reduce((sum, claim) => sum + claim.challengeCount * 0.03, 0);
  const calibratedScore = averageAcceptedScore - pressure;

  if (calibratedScore >= 0.8) {
    return "high";
  }
  if (calibratedScore >= 0.64) {
    return "medium";
  }
  return "low";
}

function severityPenalty(severity: Critique["severity"]): number {
  switch (severity) {
    case "high":
      return 0.17;
    case "medium":
      return 0.1;
    case "low":
      return 0.04;
  }
}

function tallyVotes(votes: Array<{ ballot: ResolutionTraceItem["disposition"] }>): Record<ResolutionTraceItem["disposition"], number> {
  return votes.reduce(
    (counts, vote) => {
      counts[vote.ballot] += 1;
      return counts;
    },
    {
      accepted: 0,
      monitor: 0,
      rejected: 0
    } satisfies Record<ResolutionTraceItem["disposition"], number>
  );
}

function pickWinningDisposition(
  voteCounts: Record<ResolutionTraceItem["disposition"], number>,
  acceptedClaims: number,
  monitoredClaims: number
): ResolutionTraceItem["disposition"] {
  const ranked = Object.entries(voteCounts).sort((left, right) => right[1] - left[1]);
  const topCount = ranked[0][1];
  const tied = ranked.filter((entry) => entry[1] === topCount);

  if (tied.length === 1) {
    return tied[0][0] as ResolutionTraceItem["disposition"];
  }

  if (acceptedClaims > monitoredClaims) {
    return "accepted";
  }

  if (monitoredClaims > 0) {
    return "monitor";
  }

  return "rejected";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function toAction(statement: string): string {
  return /^(run|add|keep|measure|compare|replace|ship|test|build)\b/i.test(statement.trim())
    ? statement.endsWith(".") ? statement : `${statement}.`
    : `Act on this claim: ${statement.toLowerCase()}.`;
}
