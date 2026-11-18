import { randomUUID } from "node:crypto";
import type { CouncilProvider } from "../providers/types.js";
import {
  executionReportSchema,
  implementationPacketSchema,
  reviewVerdictSchema,
  type ReviewVerdict
} from "../contracts/schemas.js";
import { failedCouncilReview } from "./verdict.js";

const REQUIRED_SEATS = ["gpt", "claude", "grok"] as const;
export type ReviewSeatId = (typeof REQUIRED_SEATS)[number];

const findingFence = /```seat-finding\s*([\s\S]*?)```/i;

export type SeatFinding = {
  seat_id: ReviewSeatId;
  status: "approve" | "changes_requested" | "blocked";
  files_cited: string[];
  corrections: string[];
  note: string;
};

type ChamberProvider = {
  agentId: string;
  providerName: string;
  mode: string;
};

export function filesInDiff(diff: string): string[] {
  const found = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const name = match[2].trim();
    if (name && name !== "/dev/null") found.add(name.replace(/\\/g, "/"));
  }
  for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const name = match[1].trim();
    if (name && name !== "/dev/null") found.add(name.replace(/\\/g, "/"));
  }
  return [...found];
}

export function chamberIsReal(providers: ChamberProvider[]): boolean {
  return REQUIRED_SEATS.every((seatId) => {
    const provider = providers.find((item) => item.agentId === seatId);
    return Boolean(provider) && provider?.mode !== "mock" && provider?.providerName !== "mock";
  });
}

export async function reviewDiff(input: {
  packet: unknown;
  report: unknown;
  providers: ChamberProvider[];
  examine: (seatId: ReviewSeatId, diff: string) => Promise<SeatFinding | null>;
}): Promise<ReviewVerdict> {
  const report = executionReportSchema.parse(input.report);
  if (!chamberIsReal(input.providers)) {
    return failedCouncilReview(
      input.packet,
      input.report,
      "Council review was requested and the chamber resolved to mock providers. Mock review was not substituted."
    );
  }
  const diff = report.diff_excerpt || "";
  const diffFiles = filesInDiff(diff);
  if (diffFiles.length === 0) {
    return failedCouncilReview(
      input.packet,
      input.report,
      "Council review was requested and the execution report diff excerpt names no files."
    );
  }

  const findings: SeatFinding[] = [];
  for (const seatId of REQUIRED_SEATS) {
    let finding: SeatFinding | null;
    try {
      finding = await input.examine(seatId, diff);
    } catch {
      finding = null;
    }
    if (!finding || finding.seat_id !== seatId || !findingIsValid(finding, diffFiles)) {
      return failedCouncilReview(
        input.packet,
        input.report,
        `Council review was requested and ${seatId} did not return a finding that cites the diff.`
      );
    }
    findings.push(finding);
  }
  return verdictFromFindings(input.packet, report.task_id, report.attempt_ids[0] ?? "", findings);
}

export async function examineWithProvider(provider: CouncilProvider, diff: string): Promise<SeatFinding | null> {
  if (!REQUIRED_SEATS.includes(provider.agentId as ReviewSeatId)) return null;
  try {
    const proposal = await provider.propose({
      question: "Review the execution diff and return one seat-finding for the files it names.",
      context: diff.slice(0, 6000),
      peers: [],
      lens: "code"
    });
    const text = [
      proposal.summary,
      ...proposal.claims.map((claim) => claim.statement),
      ...proposal.risks
    ].join("\n");
    return parseSeatFinding(provider.agentId as ReviewSeatId, text, diff);
  } catch {
    return null;
  }
}

export function parseSeatFinding(seatId: ReviewSeatId, text: string, diff: string): SeatFinding | null {
  const match = text.match(findingFence);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as {
      status?: unknown;
      files_cited?: unknown;
      corrections?: unknown;
      note?: unknown;
    };
    const finding: SeatFinding = {
      seat_id: seatId,
      status: parsed.status === "approve" || parsed.status === "changes_requested" || parsed.status === "blocked"
        ? parsed.status
        : "blocked",
      files_cited: stringList(parsed.files_cited),
      corrections: stringList(parsed.corrections),
      note: typeof parsed.note === "string" ? parsed.note : ""
    };
    return findingIsValid(finding, filesInDiff(diff)) ? finding : null;
  } catch {
    return null;
  }
}

function verdictFromFindings(
  packetInput: unknown,
  taskId: string,
  attemptId: string,
  findings: SeatFinding[]
): ReviewVerdict {
  const packet = implementationPacketSchema.parse(packetInput);
  const status = findings.some((finding) => finding.status === "blocked")
    ? "blocked"
    : findings.some((finding) => finding.status === "changes_requested")
      ? "changes_requested"
      : "approve";
  const corrections = status === "changes_requested"
    ? [...new Set(findings.flatMap((finding) => finding.corrections))].slice(0, 8)
    : [];
  const disagreements = [...(packet.disagreements ?? [])];
  const distinct = new Set(findings.map((finding) => finding.status));
  if (distinct.size > 1) disagreements.push("Seats disagreed on the diff.");
  return reviewVerdictSchema.parse({
    schema_version: 1,
    verdict_id: `vrd_${randomUUID()}`,
    packet_id: packet.packet_id,
    source_run_id: packet.source_run_id,
    task_id: taskId,
    attempt_id: attemptId,
    review_mode: "council_review",
    status,
    compliance_notes: [
      "Three seats examined the diff excerpt. This is a Council review of that diff. It does not authorize promotion.",
      ...findings.map((finding) => `${finding.seat_id}: ${finding.note || finding.status}. Cited ${finding.files_cited.join(", ")}.`)
    ],
    missing_requirements: [],
    requested_corrections: corrections,
    disagreements,
    authorizes_promotion: false
  });
}

function findingIsValid(finding: SeatFinding, diffFiles: string[]): boolean {
  if (finding.files_cited.length === 0) return false;
  const known = new Set(diffFiles.map(normalize));
  return finding.files_cited.every((file) => known.has(normalize(file)));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
