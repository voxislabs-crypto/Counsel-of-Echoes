import assert from "node:assert/strict";
import test from "node:test";
import { FAILED_COPY, initialSeatCard, reduceSeatCard, WAITING_COPY } from "./seatState.js";

test("a failed proposal seat is marked failed instead of left waiting", () => {
  const started = reduceSeatCard(initialSeatCard(), {
    type: "proposal.started",
    payload: { providerName: "ollama", modelName: "llama3.1:8b" }
  });
  const failed = reduceSeatCard(started, {
    type: "proposal.failed",
    payload: { message: "Proposal failed for gpt (llama3.1:8b): confidence: Required (number)" }
  });

  assert.equal(failed.failed, true);
  assert.equal(failed.active, false);
  assert.equal(failed.copy, FAILED_COPY);
  assert.notEqual(failed.copy, WAITING_COPY);
  assert.equal(failed.meta[0], "Failed");
  assert.match(failed.meta[1], /gpt \(llama3\.1:8b\)/);
});

test("a completed seat keeps its proposal when another seat fails", () => {
  const completed = reduceSeatCard(initialSeatCard(), {
    type: "proposal.completed",
    payload: {
      proposal: {
        summary: "The function stays small.",
        confidence: 0.4,
        claims: [{ statement: "Keep the template." }]
      }
    }
  });
  const afterCritiqueFailure = reduceSeatCard(completed, {
    type: "critique.failed",
    payload: { message: "Critique failed for claude (mistral:7b): evidenceFindings" }
  });

  assert.equal(completed.copy, "The function stays small.");
  assert.equal(completed.failed, false);
  assert.equal(afterCritiqueFailure.copy, "The function stays small.");
  assert.equal(afterCritiqueFailure.meta.at(-1), "Critique failed");
});
