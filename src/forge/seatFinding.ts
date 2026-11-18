import { z } from "zod";

export const REVIEW_SEAT_IDS = ["gpt", "claude", "grok"] as const;
export type ReviewSeatId = (typeof REVIEW_SEAT_IDS)[number];

const nonEmpty = z.string().trim().min(1);

export const seatFindingResponseSchema = z.object({
  seat_id: z.enum(REVIEW_SEAT_IDS),
  status: z.enum(["approve", "changes_requested", "blocked"]),
  summary: nonEmpty,
  findings: z.array(z.object({
    statement: nonEmpty,
    files_cited: z.array(nonEmpty).min(1),
    evidence: z.array(nonEmpty).min(1)
  })).min(1),
  corrections: z.array(nonEmpty),
  risks: z.array(nonEmpty),
  assumptions: z.array(nonEmpty)
});

export type SeatFindingDraft = {
  seat_id: ReviewSeatId;
  status: "approve" | "changes_requested" | "blocked";
  summary: string;
  files_cited: string[];
  corrections: string[];
  risks: string[];
  assumptions: string[];
};

const CONTRACT_SYSTEM = [
  "Return one JSON object matching the seat-finding contract in the user message.",
  "Do not return a proposal, critique, or synthesis."
].join(" ");

export function seatFindingSystemPrompt(seatId: ReviewSeatId): string {
  return `You are seat ${seatId}. ${CONTRACT_SYSTEM}`;
}

export function buildSeatFindingPrompt(seatId: ReviewSeatId, diff: string): string {
  return [
    "Task: return one seat finding for this execution diff.",
    `Your seat_id is ${seatId}.`,
    "Return one JSON object with these fields: seat_id, status, summary, findings, corrections, risks, assumptions.",
    "status is the verdict recommendation and must be approve, changes_requested, or blocked.",
    "summary is one short paragraph.",
    "findings is a non-empty array. Each finding has statement, files_cited, and evidence.",
    "files_cited lists file paths copied from the diff excerpt. Cite at least one file that appears in the diff. Do not cite a file that is not in the diff.",
    "evidence is a non-empty array of short strings. Each string points at the diff text that supports that finding.",
    "corrections is an array of strings. Use an empty array when you do not request a change.",
    "risks is an array of strings. assumptions is an array of strings. Use empty arrays when you have none.",
    "Do not return a proposal. Do not use stance, claims, or confidence as this contract.",
    "Do not approve, request changes, or block without file citations from the diff.",
    "A single JSON object is required. You may wrap that object in one json or seat-finding fence. Extra JSON objects are invalid.",
    "You have no tools and cannot browse.",
    "Diff excerpt:",
    diff.trim() ? diff : "(empty)"
  ].join("\n");
}

export function readSeatFinding(seatId: ReviewSeatId, text: string): SeatFindingDraft | null {
  const extracted = extractJsonObject(text);
  if (!extracted) return null;
  const parsed = seatFindingResponseSchema.safeParse(prepareLists(extracted));
  if (!parsed.success || parsed.data.seat_id !== seatId) return null;
  const files = citedFiles(parsed.data.findings);
  if (files.length === 0) return null;
  return {
    seat_id: parsed.data.seat_id,
    status: parsed.data.status,
    summary: parsed.data.summary,
    files_cited: files,
    corrections: parsed.data.corrections,
    risks: parsed.data.risks,
    assumptions: parsed.data.assumptions
  };
}

function prepareLists(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.seat_id === "string") record.seat_id = record.seat_id.trim();
  if (typeof record.status === "string") record.status = record.status.trim();
  if (typeof record.summary === "string") record.summary = record.summary.trim();
  for (const key of ["corrections", "risks", "assumptions"] as const) {
    const items = record[key];
    if (!Array.isArray(items)) continue;
    record[key] = items
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  return record;
}

function citedFiles(findings: Array<{ files_cited: string[] }>): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const finding of findings) {
    for (const file of finding.files_cited) {
      const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      files.push(normalized);
    }
  }
  return files;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const direct = tryParseObject(trimmed);
  if (direct) return direct;
  const fences = [...trimmed.matchAll(/```([a-zA-Z-]*)\s*([\s\S]*?)```/g)];
  if (fences.length > 1) return null;
  if (fences.length === 1) {
    const label = fences[0][1].trim().toLowerCase();
    if (label && label !== "json" && label !== "seat-finding") return null;
    return tryParseObject(fences[0][2].trim());
  }
  return singleEmbeddedObject(trimmed);
}

function singleEmbeddedObject(text: string): unknown {
  let found: Record<string, unknown> | null = null;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start < 0) break;
    const slice = sliceJsonObject(text, start);
    if (!slice) {
      searchFrom = start + 1;
      continue;
    }
    const parsed = tryParseObject(slice);
    if (parsed) {
      if (found) return null;
      found = parsed;
    }
    searchFrom = start + slice.length;
  }
  return found;
}

function sliceJsonObject(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
