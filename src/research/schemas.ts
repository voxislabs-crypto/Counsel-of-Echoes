import { z } from "zod";

export const sourceKindSchema = z.enum(["wikipedia", "fixture"]);

export const evidenceItemSchema = z.object({
  id: z.string().min(1),
  sourceUrl: z.string().url(),
  retrievedAt: z.string().min(1),
  title: z.string().min(1),
  excerpt: z.string().min(1).max(800),
  sourceKind: sourceKindSchema
});

export const evidenceBundleSchema = z.object({
  items: z.array(evidenceItemSchema).max(3),
  query: z.string(),
  status: z.enum(["ok", "partial", "empty"])
});

export const evidenceRelationSchema = z.enum(["supports", "contradicts", "unrelated"]);

export const evidenceFindingSchema = z.object({
  claimId: z.string().min(1),
  evidenceId: z.string().min(1),
  relation: evidenceRelationSchema
});

export const evidenceStatusSchema = z.enum(["supported", "contradicted", "unsupported", "unchecked"]);

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
export type EvidenceFinding = z.infer<typeof evidenceFindingSchema>;
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;
export type SourceKind = z.infer<typeof sourceKindSchema>;
