import { z } from "zod";
import { agentIdSchema, proposalSchema, runStatusSchema, synthesisSchema } from "../core/schemas.js";

export const evalCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(10),
  context: z.string().default(""),
  tags: z.array(z.string().min(1)).min(1),
  requiredSignals: z.array(z.string().min(1)).default([])
});

export const baselineResultSchema = z.object({
  agentId: agentIdSchema,
  mode: z.enum(["mock", "live"]),
  proposal: proposalSchema,
  answer: z.string().min(1),
  nextActions: z.array(z.string().min(1)).min(1).max(5)
});

export const evalScoreSchema = z.object({
  structure: z.number().min(0).max(5),
  actionability: z.number().min(0).max(5),
  calibration: z.number().min(0).max(5),
  conflictResolution: z.number().min(0).max(5),
  signalCoverage: z.number().min(0).max(5),
  total: z.number().min(0).max(25),
  notes: z.array(z.string().min(1)).max(8)
});

export const evalCaseResultSchema = z.object({
  case: evalCaseSchema,
  mode: z.enum(["mock", "live"]),
  councilRunId: z.string().min(1),
  councilStatus: runStatusSchema,
  council: synthesisSchema,
  baseline: baselineResultSchema,
  councilScore: evalScoreSchema,
  baselineScore: evalScoreSchema,
  winner: z.enum(["council", "baseline", "tie"]),
  rationale: z.string().min(1)
});

export const evalSuiteSummarySchema = z.object({
  casesRun: z.number().int().nonnegative(),
  councilWins: z.number().int().nonnegative(),
  baselineWins: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  averageCouncilScore: z.number().min(0).max(25),
  averageBaselineScore: z.number().min(0).max(25)
});

export const evalSuiteResultSchema = z.object({
  evalId: z.string().min(1),
  createdAt: z.string().min(1),
  mode: z.enum(["mock", "live"]),
  baselineAgent: agentIdSchema,
  summary: evalSuiteSummarySchema,
  results: z.array(evalCaseResultSchema).min(1)
});

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type BaselineResult = z.infer<typeof baselineResultSchema>;
export type EvalScore = z.infer<typeof evalScoreSchema>;
export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;
export type EvalSuiteResult = z.infer<typeof evalSuiteResultSchema>;