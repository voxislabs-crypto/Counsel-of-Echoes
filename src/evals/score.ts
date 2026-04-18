import type { Proposal, Synthesis } from "../core/schemas.js";
import type { BaselineResult, EvalCase, EvalScore } from "./schemas.js";

export function scoreCouncil(caseInput: EvalCase, synthesis: Synthesis): EvalScore {
  const notes: string[] = [];
  const finalAnswer = synthesis.finalAnswer.toLowerCase();
  const signals = caseInput.requiredSignals.filter((signal) => finalAnswer.includes(signal.toLowerCase()));

  const structure = clampScore(
    synthesis.supportingClaims.length >= 3 && synthesis.resolutionTrace.length >= 3 ? 5 : synthesis.supportingClaims.length + Math.min(2, synthesis.resolutionTrace.length),
    notes,
    "Council structure is thin; it needs more supporting claims."
  );

  const actionability = clampScore(
    Math.min(5, synthesis.nextActions.length + (containsImperative(synthesis.nextActions) ? 1 : 0)),
    notes,
    "Council output needs clearer next actions."
  );

  const disagreementWeight = caseInput.tags.some((tag) => ["conflict", "ambiguity", "uncertainty", "tradeoff"].includes(tag)) ? 1 : 0;
  const conflictResolution = clampScore(
    Math.min(
      5,
      synthesis.disagreements.length +
        synthesis.uncertainties.length +
        disagreementWeight +
        synthesis.resolutionTrace.filter((item) => item.disposition !== "accepted").length
    ),
    notes,
    "Council is not surfacing enough disagreement for this prompt class."
  );

  const calibration = scoreCalibration(
    synthesis.confidenceBand,
    synthesis.disagreements.length,
    synthesis.uncertainties.length,
    synthesis.resolutionTrace.filter((item) => item.disposition === "accepted").length,
    notes,
    "Council confidence does not seem aligned with visible disagreement."
  );

  const signalCoverage = clampScore(
    signals.length === 0 ? 1 : Math.min(5, signals.length + 1),
    notes,
    "Council answer missed prompt-specific evaluation signals."
  );

  return finalizeScore({ structure, actionability, calibration, conflictResolution, signalCoverage, notes });
}

export function scoreBaseline(caseInput: EvalCase, baseline: BaselineResult): EvalScore {
  const notes: string[] = [];
  const summary = `${baseline.answer} ${baseline.proposal.summary}`.toLowerCase();
  const signals = caseInput.requiredSignals.filter((signal) => summary.includes(signal.toLowerCase()));

  const structure = clampScore(
    Math.min(5, baseline.proposal.claims.length + (baseline.proposal.risks.length > 0 ? 1 : 0)),
    notes,
    "Baseline structure is thin."
  );

  const actionability = clampScore(
    Math.min(5, baseline.nextActions.length + (containsImperative(baseline.nextActions) ? 1 : 0)),
    notes,
    "Baseline answer is not actionable enough."
  );

  const conflictResolution = clampScore(
    Math.min(5, baseline.proposal.risks.length + baseline.proposal.assumptions.length - 1),
    notes,
    "Baseline cannot really resolve multi-perspective disagreement on its own."
  );

  const calibration = scoreBaselineCalibration(
    baseline.proposal.confidence,
    baseline.proposal.risks.length,
    notes,
    "Baseline confidence looks under-calibrated relative to surfaced risk."
  );

  const signalCoverage = clampScore(
    signals.length === 0 ? 1 : Math.min(5, signals.length + 1),
    notes,
    "Baseline answer missed prompt-specific signals."
  );

  return finalizeScore({ structure, actionability, calibration, conflictResolution, signalCoverage, notes });
}

export function chooseWinner(councilScore: EvalScore, baselineScore: EvalScore): { winner: "council" | "baseline" | "tie"; rationale: string } {
  if (councilScore.total === baselineScore.total) {
    return {
      winner: "tie",
      rationale: "Council and baseline landed at the same total score, so this case needs human review or a stronger judge."
    };
  }

  if (councilScore.total > baselineScore.total) {
    return {
      winner: "council",
      rationale: `Council won ${councilScore.total} to ${baselineScore.total} by preserving more structure, disagreement handling, or actionability.`
    };
  }

  return {
    winner: "baseline",
    rationale: `Baseline won ${baselineScore.total} to ${councilScore.total}, which suggests the current council loop is adding cost faster than quality on this case.`
  };
}

function finalizeScore(input: Omit<EvalScore, "total">): EvalScore {
  const total = input.structure + input.actionability + input.calibration + input.conflictResolution + input.signalCoverage;
  return {
    ...input,
    total
  };
}

function clampScore(value: number, notes: string[], note: string): number {
  const score = Math.max(0, Math.min(5, Math.round(value)));
  if (score <= 2) {
    notes.push(note);
  }
  return score;
}

function scoreCalibration(
  confidenceBand: Synthesis["confidenceBand"],
  disagreements: number,
  uncertainties: number,
  acceptedClaims: number,
  notes: string[],
  note: string
): number {
  if (confidenceBand === "low" && (disagreements + uncertainties >= 2 || acceptedClaims <= 1)) {
    return 5;
  }
  if (confidenceBand === "medium" && acceptedClaims >= 2 && disagreements + uncertainties >= 1) {
    return 5;
  }
  if (confidenceBand === "high" && acceptedClaims >= 3 && disagreements === 0 && uncertainties <= 1) {
    return 4;
  }
  notes.push(note);
  return 2;
}

function scoreBaselineCalibration(confidence: number, risks: number, notes: string[], note: string): number {
  if (confidence <= 0.78 && risks >= 1) {
    return 4;
  }
  if (confidence <= 0.88 && risks >= 2) {
    return 3;
  }
  notes.push(note);
  return 2;
}

function containsImperative(nextActions: string[]): boolean {
  return nextActions.some((action) => /^(run|add|keep|measure|compare|replace|ship|test|build)\b/i.test(action.trim()));
}