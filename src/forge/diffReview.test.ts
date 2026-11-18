import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reviewDiff, type SeatFinding } from "./diffReview.js";

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
    note: `${seatId} read hello.py in the diff`
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
  const verdict = await reviewDiff({
    packet,
    report,
    providers: realSeats,
    examine: async (seatId) => ({
      ...finding(seatId, "approve"),
      files_cited: ["other.py"]
    })
  });
  assert.equal(verdict.review_mode, "council_review_failed");
  assert.equal(verdict.authorizes_promotion, false);
});
