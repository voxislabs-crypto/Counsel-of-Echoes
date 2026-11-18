import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { implementationPacketSchema, executionReportSchema, reviewVerdictSchema } from "../contracts/schemas.js";
import { createPacket, derivePacket } from "./packet.js";
import { mockReview } from "./verdict.js";

const forgeExamples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../Voxis-Forge/contracts/examples");

const structured = `
\`\`\`structured-packet
{
  "expected_files": ["hello.py"],
  "instructions": ["Create hello.py."],
  "acceptance_criteria": ["hello.py defines value()."],
  "scope": "hello.py only"
}
\`\`\`
`;

test("golden fixtures match the Zod mirrors", async () => {
  implementationPacketSchema.parse(JSON.parse(await readFile(path.join(forgeExamples, "implementation-packet.json"), "utf8")));
  executionReportSchema.parse(JSON.parse(await readFile(path.join(forgeExamples, "execution-report.json"), "utf8")));
  reviewVerdictSchema.parse(JSON.parse(await readFile(path.join(forgeExamples, "review-verdict.json"), "utf8")));
});

test("mock chamber with a structured fixture emits a council packet", async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), "coe-packet-"));
  const built = await createPacket({
    question: "Add the greeting helper described in the structured packet.",
    context: structured,
    repository: "X:\\Example\\fixture",
    mode: "mock",
    storeDir: store
  });
  assert.equal(built.exitCode, 0);
  assert.equal(built.packet.derivation, "council");
  assert.deepEqual(built.packet.expected_files, ["hello.py"]);
  assert.match(built.packet.context_summary, /not independent per-seat investigation/i);
});

test("mock chamber without a structured spec is a blocked fallback", async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), "coe-packet-"));
  const built = await createPacket({
    question: "Describe a greeting helper without naming a file.",
    context: "No file list is available.",
    repository: "X:\\Example\\fixture",
    mode: "mock",
    storeDir: store
  });
  assert.equal(built.exitCode, 2);
  assert.equal(built.packet.derivation, "fallback");
});

test("live mode ignores a structured fixture and falls back when synthesis has no files", () => {
  const built = derivePacket({
    mode: "live",
    question: "Add a helper.",
    context: structured,
    repository: "X:\\Example\\fixture",
    sourceRunId: "run_example_council_001",
    synthesis: {
      finalAnswer: "No file was selected.",
      supportingClaims: [{
        statement: "No file was selected.",
        sourceAgents: ["gpt"],
        supportCount: 1,
        challengeCount: 0,
        confidence: 0.4
      }],
      disagreements: [],
      uncertainties: ["file unknown"],
      confidenceBand: "low",
      nextActions: ["Decide the file name."],
      resolutionTrace: [{
        claimRef: "gpt:c1",
        statement: "No file was selected.",
        disposition: "monitor",
        sourceAgents: ["gpt"],
        challengedBy: [],
        score: 0.4,
        rationale: "The chamber did not name a file.",
        evidenceStatus: "unchecked"
      }],
      deliberation: {
        agreementState: "full-agreement",
        viewpoints: [
          { agentId: "gpt", perspective: "wait", primaryClaim: "No file was selected.", disposition: "monitor" },
          { agentId: "claude", perspective: "wait", primaryClaim: "No file was selected.", disposition: "monitor" }
        ],
        voteRequired: false,
        votes: [
          { agentId: "gpt", ballot: "monitor", reason: "No file." },
          { agentId: "claude", ballot: "monitor", reason: "No file." }
        ],
        winningDisposition: "monitor",
        consensusSummary: "No file."
      },
      decisionRationale: {
        summary: "No file was named.",
        keyFactors: ["No expected file line.", "Structured fixture is ignored in live mode."]
      }
    }
  });
  assert.equal(built.exitCode, 2);
  assert.equal(built.packet.derivation, "fallback");
});

test("mock review distinguishes the three outcomes and rejects a stale report", () => {
  const packet = {
    schema_version: 1,
    packet_id: "pkt_example_council_001",
    source_run_id: "run_example_council_001",
    derivation: "council",
    objective: "Add hello.py",
    repository: "X:\\Example\\fixture",
    context_summary: "shared",
    scope: "hello.py",
    prohibited_changes: [],
    expected_files: ["hello.py"],
    instructions: ["Create hello.py."],
    acceptance_criteria: ["It exists."],
    required_tests: [],
    risks: [],
    assumptions: [],
    disagreements: ["None."]
  };
  const report = {
    schema_version: 1,
    packet_id: packet.packet_id,
    source_run_id: packet.source_run_id,
    task_id: "task_example_001",
    attempt_ids: ["task_example_001:IMPLEMENT:1"],
    repository: packet.repository,
    base_commit: null,
    branch: null,
    workspace_path: null,
    developer: "stub",
    filesystem_boundary: "A Git worktree is not an OS security boundary.",
    files_created: ["hello.py"],
    files_modified: [],
    diff_path: null,
    diff_excerpt: "",
    verification_status: "passed",
    commands: [],
    repair_attempts: 0,
    errors: [],
    remaining_risks: [],
    promotion_performed: false,
    fallback_authorized: false,
    review_mode: null
  };
  const approved = mockReview(packet, report);
  assert.equal(approved.review_mode, "mock_review");
  assert.equal(approved.status, "approve");
  assert.equal(approved.authorizes_promotion, false);

  const missing = mockReview(packet, { ...report, files_created: ["other.py"], verification_status: "passed" });
  assert.equal(missing.status, "changes_requested");

  const empty = mockReview(packet, { ...report, files_created: [], verification_status: "failed" });
  assert.equal(empty.status, "blocked");

  const blocked = mockReview(packet, { ...report, verification_status: "blocked" });
  assert.equal(blocked.status, "blocked");

  assert.throws(
    () => mockReview(packet, { ...report, packet_id: "pkt_other_packet_0002" }),
    /Stale artifacts/
  );
});
