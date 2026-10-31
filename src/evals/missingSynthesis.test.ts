import assert from "node:assert/strict";
import test from "node:test";
import { formatMissingSynthesis } from "./service.js";

test("a failed council run is reported as failed before synthesis", () => {
  const message = formatMissingSynthesis({
    runId: "04886b30-515a-491f-aeff-14d117e6c458",
    status: "failed",
    error: "Proposal stage failed for 1 of 3 seats."
  });

  assert.equal(
    message,
    "Council run 04886b30-515a-491f-aeff-14d117e6c458 failed before synthesis: Proposal stage failed for 1 of 3 seats."
  );
  assert.doesNotMatch(message, /completed without synthesis/);
});

test("a completed record that has no synthesis is still reported as failed", () => {
  const message = formatMissingSynthesis({
    runId: "run-1",
    status: "completed"
  });

  assert.equal(message, "Council run run-1 failed before synthesis");
});
