import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CouncilProvider } from "../providers/types.js";
import { buildSeatFindingPrompt, examineWithProvider, parseSeatFinding, reviewDiff, type SeatFinding } from "./diffReview.js";

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../Voxis-Forge/contracts/examples");

const realSeats = [
  { agentId: "gpt", providerName: "ollama", mode: "ollama" },
  { agentId: "claude", providerName: "ollama", mode: "ollama" },
  { agentId: "grok", providerName: "ollama", mode: "ollama" }
];

function finding(
  seatId: SeatFinding["seat_id"],
  status: SeatFinding["status"],
  corrections: string[] = []
): SeatFinding {
  return {
    seat_id: seatId,
    status,
    files_cited: ["hello.py"],
    corrections,
    note: `${seatId} read hello.py in the diff`,
    risks: [],
    assumptions: []
  };
}

const helloDiff = "diff --git a/hello.py b/hello.py\n+++ b/hello.py\n+def value():\n+    return 'stub'\n";

function contract(seatId: SeatFinding["seat_id"], patch: Record<string, unknown> = {}) {
  return {
    seat_id: seatId,
    status: "approve",
    summary: `${seatId} reviewed the value function.`,
    findings: [
      {
        statement: "The diff adds a value function.",
        files_cited: ["hello.py"],
        evidence: ["return 'stub'"]
      }
    ],
    corrections: [],
    risks: [],
    assumptions: [],
    ...patch
  };
}

test("injected diff seats produce a council review and do not promote", async () => {
  const packet = JSON.parse(await readFile(path.join(examples, "implementation-packet.json"), "utf8"));
  const report = JSON.parse(await readFile(path.join(examples, "execution-report.json"), "utf8"));
  report.diff_excerpt = "diff --git a/hello.py b/hello.py\n+++ b/hello.py\n+def value():\n+    return 'stub'\n";
  let calls = 0;
  const verdict = await reviewDiff({
    packet,
    report,
    providers: realSeats,
    examine: async (seatId) => {
      calls += 1;
      return finding(seatId, "approve");
    }
  });
  assert.equal(calls, 3);
  assert.equal(verdict.review_mode, "council_review");
  assert.equal(verdict.status, "approve");
  assert.equal(verdict.authorizes_promotion, false);
  assert.equal(verdict.packet_id, packet.packet_id);

  report.diff_excerpt += "\n# council repair applied\n";
  const again = await reviewDiff({
    packet,
    report,
    providers: realSeats,
    examine: async (seatId, diff) => {
      assert.match(diff, /council repair applied/);
      return finding(seatId, "approve");
    }
  });
  assert.equal(again.review_mode, "council_review");
  assert.equal(again.status, "approve");
  assert.notEqual(again.verdict_id, verdict.verdict_id);
  assert.equal(again.authorizes_promotion, false);
});

test("a seat can request one correction from the diff", async () => {
  const packet = JSON.parse(await readFile(path.join(examples, "implementation-packet.json"), "utf8"));
  const report = JSON.parse(await readFile(path.join(examples, "execution-report.json"), "utf8"));
  const verdict = await reviewDiff({
    packet,
    report,
    providers: realSeats,
    examine: async (seatId) => finding(
      seatId,
      seatId === "claude" ? "changes_requested" : "approve",
      seatId === "claude" ? ["Add the repair marker."] : []
    )
  });
  assert.equal(verdict.review_mode, "council_review");
  assert.equal(verdict.status, "changes_requested");
  assert.deepEqual(verdict.requested_corrections, ["Add the repair marker."]);
  assert.equal(verdict.authorizes_promotion, false);
});

test("mock providers and an empty diff fail closed without a substitute approve", async () => {
  const packet = JSON.parse(await readFile(path.join(examples, "implementation-packet.json"), "utf8"));
  const report = JSON.parse(await readFile(path.join(examples, "execution-report.json"), "utf8"));
  let calls = 0;
  const mocked = await reviewDiff({
    packet,
    report,
    providers: realSeats.map((seat) => ({ ...seat, providerName: "mock", mode: "mock" })),
    examine: async () => {
      calls += 1;
      return finding("gpt", "approve");
    }
  });
  assert.equal(calls, 0);
  assert.equal(mocked.review_mode, "council_review_failed");
  assert.equal(mocked.status, "blocked");
  assert.equal(mocked.authorizes_promotion, false);

  report.diff_excerpt = "";
  const empty = await reviewDiff({
    packet,
    report,
    providers: realSeats,
    examine: async () => {
      calls += 1;
      return finding("gpt", "approve");
    }
  });
  assert.equal(calls, 0);
  assert.equal(empty.review_mode, "council_review_failed");
});

test("a citation outside the diff is not a council review", async () => {
  const packet = JSON.parse(await readFile(path.join(examples, "implementation-packet.json"), "utf8"));
  const report = JSON.parse(await readFile(path.join(examples, "execution-report.json"), "utf8"));
  let calls = 0;
  const verdict = await reviewDiff({
    packet,
    report,
    providers: realSeats,
    examine: async (seatId) => {
      calls += 1;
      return {
        ...finding(seatId, "approve"),
        files_cited: ["other.py"]
      };
    }
  });
  assert.equal(calls, 3);
  assert.equal(verdict.review_mode, "council_review_failed");
  assert.equal(verdict.authorizes_promotion, false);
  assert.deepEqual(verdict.requested_corrections, []);
});

test("a valid structured finding cites the diff and keeps corrections", () => {
  const prompt = buildSeatFindingPrompt("gpt", helloDiff);
  for (const field of ["seat_id", "status", "summary", "findings", "files_cited", "evidence", "corrections", "risks", "assumptions"]) {
    assert.match(prompt, new RegExp(field));
  }
  assert.match(prompt, /Do not return a proposal/);
  assert.match(prompt, /Your seat_id is gpt/);

  const parsed = parseSeatFinding("claude", JSON.stringify(contract("claude", {
    status: "changes_requested",
    corrections: ["", "Add the repair marker."]
  })), helloDiff);
  assert.equal(parsed?.status, "changes_requested");
  assert.deepEqual(parsed?.files_cited, ["hello.py"]);
  assert.deepEqual(parsed?.corrections, ["Add the repair marker."]);
  assert.equal(parsed?.seat_id, "claude");

  const extra = parseSeatFinding("gpt", JSON.stringify({
    ...contract("gpt"),
    stance: "approve",
    confidence: 0.2
  }), helloDiff);
  assert.equal(extra?.status, "approve");
  assert.equal(parseSeatFinding("gpt", JSON.stringify(contract("grok")), helloDiff), null);
});

test("json surrounded by markdown or prose still parses one object", () => {
  const body = JSON.stringify(contract("gpt"), null, 2);
  const fenced = parseSeatFinding("gpt", `Review follows.\n\`\`\`json\n${body}\n\`\`\`\nEnd.`, helloDiff);
  const legacy = parseSeatFinding("gpt", `\`\`\`seat-finding\n${body}\n\`\`\``, helloDiff);
  const prose = parseSeatFinding("gpt", `Finding:\n${body}\nDone.`, helloDiff);
  assert.equal(fenced?.status, "approve");
  assert.equal(legacy?.status, "approve");
  assert.equal(prose?.files_cited[0], "hello.py");
});

test("missing required fields and malformed json are not findings", () => {
  const missing = { ...contract("gpt") } as Record<string, unknown>;
  delete missing.summary;
  delete missing.findings;
  assert.equal(parseSeatFinding("gpt", JSON.stringify(missing), helloDiff), null);
  assert.equal(parseSeatFinding("gpt", "{", helloDiff), null);
  assert.equal(parseSeatFinding("gpt", `${JSON.stringify(contract("gpt"))}\n${JSON.stringify(contract("gpt"))}`, helloDiff), null);
  assert.equal(parseSeatFinding("gpt", JSON.stringify(contract("gpt", { status: "approved" })), helloDiff), null);
});

test("a missing citation or a file outside the diff is invalid", () => {
  assert.equal(parseSeatFinding("gpt", JSON.stringify(contract("gpt", {
    findings: [{ statement: "No file.", files_cited: [], evidence: ["nothing to cite"] }]
  })), helloDiff), null);
  assert.equal(parseSeatFinding("gpt", JSON.stringify(contract("gpt", {
    findings: [{ statement: "Wrong file.", files_cited: ["other.py"], evidence: ["not in the diff"] }]
  })), helloDiff), null);
});

test("ordinary prose and a normal proposal are not approvals", async () => {
  let proposed = 0;
  const provider = fakeProvider(async () => "I approve the change to hello.py.");
  provider.propose = async () => {
    proposed += 1;
    throw new Error("proposal recovery must not examine a diff");
  };
  assert.equal(await examineWithProvider(provider, helloDiff), null);
  assert.equal(proposed, 0);
  const proposal = {
    stance: "approve",
    summary: "Accept hello.py",
    claims: [{ id: "gpt:c1", statement: "hello.py is fine", rationale: "the diff", confidence: 0.9, risk: "none", evidenceIds: [] }],
    assumptions: ["the diff is complete"],
    risks: ["none"],
    confidence: 0.9
  };
  assert.equal(parseSeatFinding("gpt", JSON.stringify(proposal), helloDiff), null);
  assert.equal(await examineWithProvider(fakeProvider(async () => JSON.stringify(proposal)), helloDiff), null);
});

test("a provider timeout or error does not become a finding", async () => {
  const timedOut = await examineWithProvider(
    fakeProvider(async () => {
      throw new Error("fetch timed out after 600s");
    }),
    helloDiff
  );
  const failed = await examineWithProvider(
    fakeProvider(async () => {
      throw new Error("ollama request failed with 500");
    }),
    helloDiff
  );
  assert.equal(timedOut, null);
  assert.equal(failed, null);
});

test("one invalid seat fails the chamber after every seat is examined", async () => {
  const packet = JSON.parse(await readFile(path.join(examples, "implementation-packet.json"), "utf8"));
  const report = JSON.parse(await readFile(path.join(examples, "execution-report.json"), "utf8"));
  const seen: string[] = [];
  const verdict = await reviewDiff({
    packet,
    report,
    providers: realSeats,
    examine: async (seatId) => {
      seen.push(seatId);
      if (seatId === "claude") return null;
      return finding(seatId, "approve");
    }
  });
  assert.deepEqual(seen, ["gpt", "claude", "grok"]);
  assert.equal(verdict.review_mode, "council_review_failed");
  assert.equal(verdict.status, "blocked");
  assert.equal(verdict.authorizes_promotion, false);
  assert.deepEqual(verdict.requested_corrections, []);
  const notes = verdict.compliance_notes.join("\n");
  assert.match(notes, /gpt: parsed approve/);
  assert.match(notes, /claude: did not return a finding/);
  assert.match(notes, /grok: parsed approve/);
});

test("three valid seat-finding contracts produce a council verdict and do not promote", async () => {
  const packet = JSON.parse(await readFile(path.join(examples, "implementation-packet.json"), "utf8"));
  const report = JSON.parse(await readFile(path.join(examples, "execution-report.json"), "utf8"));
  report.diff_excerpt = helloDiff;
  let calls = 0;
  const verdict = await reviewDiff({
    packet,
    report,
    providers: realSeats,
    examine: async (seatId, diff) => {
      calls += 1;
      assert.match(diff, /hello\.py/);
      return parseSeatFinding(seatId, JSON.stringify(contract(seatId)), diff);
    }
  });
  assert.equal(calls, 3);
  assert.equal(verdict.review_mode, "council_review");
  assert.equal(verdict.status, "approve");
  assert.equal(verdict.authorizes_promotion, false);
  assert.match(verdict.compliance_notes[0], /does not authorize promotion/);
});

function fakeProvider(respond: () => Promise<string>): CouncilProvider {
  return {
    agentId: "gpt",
    providerName: "ollama",
    modelName: "llama3.1:8b",
    mode: "ollama",
    async propose() {
      throw new Error("proposal recovery must not examine a diff");
    },
    async critique() {
      throw new Error("unused");
    },
    async synthesize() {
      throw new Error("unused");
    },
    respond
  };
}
