import { createProviderForAgent, type RuntimeConfig } from "../providers/index.js";
import type { ProviderMode } from "../providers/types.js";
import { CouncilService } from "../core/council.js";
import type { Proposal } from "../core/schemas.js";
import { EvalStore } from "./store.js";
import { defaultEvalCases } from "./fixtures.js";
import { baselineResultSchema, evalCaseResultSchema, evalSuiteResultSchema, type BaselineResult, type EvalCase, type EvalSuiteResult } from "./schemas.js";
import { chooseWinner, scoreBaseline, scoreCouncil } from "./score.js";

export class EvalService {
  constructor(
    private readonly council: CouncilService,
    private readonly config: RuntimeConfig,
    private readonly store: EvalStore
  ) {}

  async runSuite(options?: { mode?: ProviderMode; cases?: EvalCase[] }): Promise<EvalSuiteResult> {
    await this.store.initialize();
    const mode = options?.mode ?? this.config.providerMode;
    const cases = options?.cases ?? defaultEvalCases;
    const results = [];

    for (const caseInput of cases) {
      const councilRun = await this.council.runAndWait({
        question: caseInput.question,
        context: caseInput.context,
        mode
      });

      if (!councilRun.synthesis) {
        throw new Error(`Council run ${councilRun.runId} completed without synthesis`);
      }

      const baseline = await this.runBaseline(caseInput, mode);
      const councilScore = scoreCouncil(caseInput, councilRun.synthesis);
      const baselineScore = scoreBaseline(caseInput, baseline);
      const comparison = chooseWinner(councilScore, baselineScore);

      results.push(evalCaseResultSchema.parse({
        case: caseInput,
        mode,
        councilRunId: councilRun.runId,
        councilStatus: councilRun.status,
        council: councilRun.synthesis,
        baseline,
        councilScore,
        baselineScore,
        winner: comparison.winner,
        rationale: comparison.rationale
      }));
    }

    const suiteResult = evalSuiteResultSchema.parse({
      evalId: this.store.createId(),
      createdAt: new Date().toISOString(),
      mode,
      baselineAgent: results[0]?.baseline.agentId ?? this.config.baselineAgent,
      summary: buildSummary(results),
      results
    });

    await this.store.persist(suiteResult);
    return suiteResult;
  }

  async listSuites() {
    return this.store.list();
  }

  async getSuite(evalId: string) {
    return this.store.get(evalId);
  }

  private async runBaseline(caseInput: EvalCase, mode: ProviderMode): Promise<BaselineResult> {
    const provider = createProviderForAgent(this.config, this.config.baselineAgent, mode);
    const proposal = await provider.propose({
      question: caseInput.question,
      context: caseInput.context,
      peers: []
    });

    return baselineResultSchema.parse({
      agentId: provider.agentId,
      mode: provider.mode,
      proposal,
      answer: renderBaselineAnswer(proposal),
      nextActions: proposal.claims.slice(0, 3).map((claim) => normalizeAction(claim.statement))
    });
  }
}

function renderBaselineAnswer(proposal: Proposal): string {
  return [
    proposal.summary,
    `The baseline's strongest claims are ${proposal.claims.slice(0, 2).map((claim) => claim.statement.toLowerCase()).join("; ")}.`,
    `The main risks it sees are ${proposal.risks.slice(0, 2).join("; ").toLowerCase()}.`
  ].join(" ");
}

function normalizeAction(statement: string): string {
  return statement.endsWith(".") ? statement : `${statement}.`;
}

function buildSummary(results: Array<{ winner: "council" | "baseline" | "tie"; councilScore: { total: number }; baselineScore: { total: number } }>) {
  const casesRun = results.length;
  const councilWins = results.filter((result) => result.winner === "council").length;
  const baselineWins = results.filter((result) => result.winner === "baseline").length;
  const ties = results.filter((result) => result.winner === "tie").length;
  const averageCouncilScore = casesRun === 0 ? 0 : Number((results.reduce((sum, result) => sum + result.councilScore.total, 0) / casesRun).toFixed(2));
  const averageBaselineScore = casesRun === 0 ? 0 : Number((results.reduce((sum, result) => sum + result.baselineScore.total, 0) / casesRun).toFixed(2));

  return {
    casesRun,
    councilWins,
    baselineWins,
    ties,
    averageCouncilScore,
    averageBaselineScore
  };
}