import { z } from "zod";
import { agentIds } from "./agents.js";

export const agentIdSchema = z.enum(agentIds);

export const claimSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
  risk: z.string().min(1)
});

export const proposalSchema = z.object({
  agentId: agentIdSchema,
  model: z.string().min(1),
  stance: z.string().min(1),
  summary: z.string().min(1),
  claims: z.array(claimSchema).min(2).max(5),
  assumptions: z.array(z.string().min(1)).min(1).max(4),
  risks: z.array(z.string().min(1)).min(1).max(4),
  confidence: z.number().min(0).max(1)
});

export const critiqueSchema = z.object({
  agentId: agentIdSchema,
  targetAgentId: agentIdSchema,
  challengedClaimIds: z.array(z.string().min(1)).max(4),
  usefulAgreements: z.array(z.string().min(1)).max(3),
  concerns: z.array(z.string().min(1)).min(1).max(4),
  recommendation: z.string().min(1),
  severity: z.enum(["low", "medium", "high"])
});

export const supportingClaimSchema = z.object({
  statement: z.string().min(1),
  sourceAgents: z.array(agentIdSchema).min(1),
  supportCount: z.number().int().nonnegative(),
  challengeCount: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1)
});

export const resolutionTraceItemSchema = z.object({
  statement: z.string().min(1),
  disposition: z.enum(["accepted", "monitor", "rejected"]),
  sourceAgents: z.array(agentIdSchema).min(1),
  challengedBy: z.array(agentIdSchema),
  score: z.number().min(0).max(1),
  rationale: z.string().min(1)
});

export const synthesisSchema = z.object({
  finalAnswer: z.string().min(1),
  supportingClaims: z.array(supportingClaimSchema).min(1).max(6),
  disagreements: z.array(z.string().min(1)).max(6),
  uncertainties: z.array(z.string().min(1)).max(6),
  confidenceBand: z.enum(["low", "medium", "high"]),
  nextActions: z.array(z.string().min(1)).min(1).max(5),
  resolutionTrace: z.array(resolutionTraceItemSchema).min(1).max(12)
});

export const runRequestSchema = z.object({
  question: z.string().min(10).max(4000),
  context: z.string().max(12000).optional().default(""),
  mode: z.enum(["mock", "live"]).optional()
});

export const councilEventTypeSchema = z.enum([
  "run.started",
  "route.selected",
  "proposal.started",
  "proposal.delta",
  "proposal.completed",
  "critique.started",
  "critique.completed",
  "synthesis.started",
  "synthesis.completed",
  "run.completed",
  "run.failed"
]);

export const councilEventSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.string().min(1),
  type: councilEventTypeSchema,
  agentId: agentIdSchema.optional(),
  payload: z.record(z.string(), z.unknown())
});

export const runStatusSchema = z.enum(["pending", "running", "completed", "failed"]);

export type Claim = z.infer<typeof claimSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Critique = z.infer<typeof critiqueSchema>;
export type Synthesis = z.infer<typeof synthesisSchema>;
export type ResolutionTraceItem = z.infer<typeof resolutionTraceItemSchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;
export type CouncilEvent = z.infer<typeof councilEventSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;

export type RunRecord = {
  runId: string;
  request: RunRequest;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  events: CouncilEvent[];
  proposals: Proposal[];
  critiques: Critique[];
  synthesis?: Synthesis;
  error?: string;
};