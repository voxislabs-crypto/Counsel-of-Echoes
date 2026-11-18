import { z } from "zod";

export const derivationSchema = z.enum(["council", "fallback"]);
export const reviewModeSchema = z.enum([
  "mock_review",
  "council_review",
  "council_review_failed"
]);
export const verdictStatusSchema = z.enum(["approve", "changes_requested", "blocked"]);
export const verificationStatusSchema = z.enum(["passed", "failed", "blocked", "not_run"]);

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,}$/);

export const implementationPacketSchema = z.object({
  schema_version: z.literal(1),
  packet_id: identifier,
  source_run_id: identifier,
  derivation: derivationSchema,
  objective: z.string().min(1),
  repository: z.string().min(1),
  context_summary: z.string(),
  scope: z.string(),
  prohibited_changes: z.array(z.string()),
  expected_files: z.array(z.string().min(1)),
  instructions: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  required_tests: z.array(z.string()),
  risks: z.array(z.string()),
  assumptions: z.array(z.string()),
  disagreements: z.array(z.string())
}).strict();

export const executionReportSchema = z.object({
  schema_version: z.literal(1),
  packet_id: identifier,
  source_run_id: identifier,
  task_id: z.string().min(1),
  attempt_ids: z.array(z.string()),
  repository: z.string(),
  base_commit: z.string().nullable(),
  branch: z.string().nullable(),
  workspace_path: z.string().nullable(),
  developer: z.literal("stub"),
  filesystem_boundary: z.string().min(1),
  files_created: z.array(z.string()),
  files_modified: z.array(z.string()),
  diff_path: z.string().nullable(),
  diff_excerpt: z.string(),
  verification_status: verificationStatusSchema,
  commands: z.array(z.unknown()),
  repair_attempts: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  remaining_risks: z.array(z.string()),
  promotion_performed: z.literal(false),
  fallback_authorized: z.boolean(),
  review_mode: reviewModeSchema.nullable()
}).strict();

export const reviewVerdictSchema = z.object({
  schema_version: z.literal(1),
  verdict_id: identifier,
  packet_id: identifier,
  source_run_id: identifier,
  task_id: z.string().min(1),
  attempt_id: z.string(),
  review_mode: reviewModeSchema,
  status: verdictStatusSchema,
  compliance_notes: z.array(z.string()),
  missing_requirements: z.array(z.string()),
  requested_corrections: z.array(z.string()),
  disagreements: z.array(z.string()),
  authorizes_promotion: z.literal(false)
}).strict();

export type ImplementationPacket = z.infer<typeof implementationPacketSchema>;
export type ExecutionReport = z.infer<typeof executionReportSchema>;
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
