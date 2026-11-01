import { clampExcerpt } from "./safeFetch.js";
import { evidenceItemSchema, type EvidenceItem, type SourceKind } from "./schemas.js";
import type { SearchLead } from "./types.js";

export const MAX_EVIDENCE_ITEMS = 3;

export type EvidenceRetrieval = {
  items: EvidenceItem[];
  failed: number;
};

// Turns search leads into evidence items. One bad lead is skipped.
// A caller that throws before this runs is handled by the adapter.
export async function collectEvidenceItems(
  leads: SearchLead[],
  sourceKind: SourceKind,
  excerptFor: (lead: SearchLead) => Promise<string>,
  now: () => string = () => new Date().toISOString()
): Promise<EvidenceRetrieval> {
  const items: EvidenceItem[] = [];
  let failed = 0;

  for (const lead of leads.slice(0, MAX_EVIDENCE_ITEMS)) {
    try {
      const excerpt = clampExcerpt(await excerptFor(lead));
      const parsed = evidenceItemSchema.safeParse({
        id: `${sourceKind}:${items.length + 1}`,
        sourceUrl: lead.url,
        retrievedAt: now(),
        title: lead.title,
        excerpt,
        sourceKind
      });
      if (!parsed.success) {
        failed += 1;
        continue;
      }
      items.push(parsed.data);
    } catch {
      failed += 1;
    }
  }

  return { items, failed };
}
