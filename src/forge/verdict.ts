import { randomUUID } from "node:crypto";
import {
  executionReportSchema,
  implementationPacketSchema,
  reviewVerdictSchema,
  type ExecutionReport,
  type ImplementationPacket,
  type ReviewVerdict
} from "../contracts/schemas.js";

const MOCK_NOTE = "Deterministic mock review. This is not a Council review.";

export function mockReview(packetInput: unknown, reportInput: unknown): ReviewVerdict {
  const packet = implementationPacketSchema.parse(packetInput);
  const report = executionReportSchema.parse(reportInput);
  assertSameIdentity(packet, report);
  const status = mockStatus(packet, report);
  const missing = missingFiles(packet, report);
  return reviewVerdictSchema.parse({
    schema_version: 1,
    verdict_id: `vrd_${randomUUID()}`,
    packet_id: packet.packet_id,
    source_run_id: packet.source_run_id,
    task_id: report.task_id,
    attempt_id: report.attempt_ids[0] ?? "",
    review_mode: "mock_review",
    status,
    compliance_notes: [MOCK_NOTE],
    missing_requirements: missing,
    requested_corrections: status === "changes_requested"
      ? missing.map((file) => `Create or complete ${file}.`)
      : [],
    disagreements: packet.disagreements,
    authorizes_promotion: false
  });
}

export function failedCouncilReview(packetInput: unknown, reportInput: unknown, reason: string): ReviewVerdict {
  const packet = implementationPacketSchema.parse(packetInput);
  const report = executionReportSchema.parse(reportInput);
  assertSameIdentity(packet, report);
  return reviewVerdictSchema.parse({
    schema_version: 1,
    verdict_id: `vrd_${randomUUID()}`,
    packet_id: packet.packet_id,
    source_run_id: packet.source_run_id,
    task_id: report.task_id,
    attempt_id: report.attempt_ids[0] ?? "",
    review_mode: "council_review_failed",
    status: "blocked",
    compliance_notes: [reason],
    missing_requirements: [],
    requested_corrections: [],
    disagreements: packet.disagreements,
    authorizes_promotion: false
  });
}

function assertSameIdentity(packet: ImplementationPacket, report: ExecutionReport): void {
  if (packet.packet_id !== report.packet_id || packet.source_run_id !== report.source_run_id) {
    throw new Error("Execution report does not match this packet. Stale artifacts are rejected.");
  }
}

function mockStatus(packet: ImplementationPacket, report: ExecutionReport): ReviewVerdict["status"] {
  if (packet.derivation === "fallback" && !report.fallback_authorized) return "blocked";
  if (report.verification_status === "blocked" || report.verification_status === "not_run") return "blocked";
  const changed = new Set([...report.files_created, ...report.files_modified].map(normalize));
  if (changed.size === 0) return "blocked";
  if (missingFiles(packet, report).length > 0 || report.verification_status === "failed") {
    return "changes_requested";
  }
  if (report.verification_status === "passed") return "approve";
  return "blocked";
}

function missingFiles(packet: ImplementationPacket, report: ExecutionReport): string[] {
  const changed = new Set([...report.files_created, ...report.files_modified].map(normalize));
  return packet.expected_files.filter((file) => !changed.has(normalize(file)));
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
