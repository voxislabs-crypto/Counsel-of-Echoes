import { randomUUID } from "node:crypto";
import type { CouncilProvider } from "../providers/types.js";
import {
  executionReportSchema,
  implementationPacketSchema,
  reviewVerdictSchema,
  type ReviewVerdict
} from "../contracts/schemas.js";
import {
  REVIEW_SEAT_IDS,
  buildSeatFindingPrompt,
  readSeatFinding,
  type ReviewSeatId
} from "./seatFinding.js";
import { failedCouncilReview } from "./verdict.js";

export type { ReviewSeatId };
export { buildSeatFindingPrompt };

const REQUIRED_SEATS = REVIEW_SEAT_IDS;

export type SeatFinding = {
  seat_id: ReviewSeatId;
  status: "approve" | "changes_requested" | "blocked";
  files_cited: string[];
  corrections: string[];
  note: string;
  risks: string[];
  assumptions: string[];
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

  const outcomes: Array<{ seatId: ReviewSeatId; finding: SeatFinding | null; failure: string | null }> = [];
  for (const seatId of REQUIRED_SEATS) {
    let finding: SeatFinding | null = null;
    let failure: string | null = null;
    try {
      finding = await input.examine(seatId, diff);
    } catch {
      failure = `${seatId}: the examiner failed before a finding was returned.`;
      finding = null;
    }
    if (!failure && (!finding || finding.seat_id !== seatId || !findingIsValid(finding, diffFiles))) {
      failure = `${seatId}: did not return a finding that cites the diff.`;
      finding = null;
    }
    outcomes.push({ seatId, finding, failure });
  }
  if (outcomes.some((outcome) => outcome.failure)) {
    return failedCouncilReview(
      input.packet,
      input.report,
      "Council review was requested and one or more seats did not return a finding that cites the diff.",
      outcomes.map((outcome) => outcome.failure ?? `${outcome.seatId}: parsed ${outcome.finding?.status} citing ${outcome.finding?.files_cited.join(", ")}. Not a chamber verdict.`)
    );
  }
  return verdictFromFindings(
    input.packet,
    report.task_id,
    report.attempt_ids[0] ?? "",
    outcomes.map((outcome) => outcome.finding as SeatFinding)
  );
}

export async function examineWithProvider(provider: CouncilProvider, diff: string): Promise<SeatFinding | null> {
  if (!REQUIRED_SEATS.includes(provider.agentId as ReviewSeatId)) return null;
  try {
    const seatId = provider.agentId as ReviewSeatId;
    const text = await provider.respond(buildSeatFindingPrompt(seatId, diff.slice(0, 6000)));
    return parseSeatFinding(seatId, text, diff);
  } catch {
    return null;
  }
}

export function parseSeatFinding(seatId: ReviewSeatId, text: string, diff: string): SeatFinding | null {
  const draft = readSeatFinding(seatId, text);
  if (!draft) return null;
  const finding: SeatFinding = {
    seat_id: draft.seat_id,
    status: draft.status,
    files_cited: draft.files_cited,
    corrections: draft.corrections,
    note: draft.summary.slice(0, 500),
    risks: draft.risks,
    assumptions: draft.assumptions
  };
  return findingIsValid(finding, filesInDiff(diff)) ? finding : null;
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
      ...findings.map((finding) => describeFinding(finding))
    ],
    missing_requirements: [],
    requested_corrections: corrections,
    disagreements,
    authorizes_promotion: false
  });
}

function describeFinding(finding: SeatFinding): string {
  const risks = finding.risks.length > 0 ? ` Risks: ${finding.risks.join("; ")}.` : "";
  const assumptions = finding.assumptions.length > 0 ? ` Assumptions: ${finding.assumptions.join("; ")}.` : "";
  return `${finding.seat_id}: ${finding.note || finding.status}. Cited ${finding.files_cited.join(", ")}.${risks}${assumptions}`;
}

function findingIsValid(finding: SeatFinding, diffFiles: string[]): boolean {
  if (finding.files_cited.length === 0) return false;
  const known = new Set(diffFiles.map(normalize));
  return finding.files_cited.every((file) => known.has(normalize(file)));
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
