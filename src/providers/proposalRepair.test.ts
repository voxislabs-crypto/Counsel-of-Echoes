import assert from "node:assert/strict";
import test from "node:test";
import { proposalSchema } from "../core/schemas.js";
import {
  buildClaimRepairPrompt,
  buildProposalPrompt,
  claimContractLines,
  resolveOllamaProposal
} from "./ollamaProvider.js";
import { mergeRepairedClaims } from "./proposalRepair.js";

function claim(statement: string) {
  return {
    id: "c1",
    statement,
    rationale: "Because it can be checked on its own.",
    confidence: 0.5,
    risk: "The evidence is thin.",
    evidenceIds: [] as string[]
  };
}

function rawProposal(claims: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stance: "The topping is disputed.",
    summary: "Pineapple on pizza is a preference claim, not a settled rule.",
    claims,
    assumptions: ["Taste is not uniform."],
    risks: ["A second claim might only restate the first."],
    confidence: 0.4,
    ...overrides
  };
}

const input = {
  question: "should pineapple belong on pizza?",
  context: "",
  peers: ["gpt", "claude"] as ["gpt", "claude"]
};

test("the proposal prompt requires two distinct claims and forbids padding", () => {
  const prompt = buildProposalPrompt("grok", input);
  for (const line of claimContractLines) {
    assert.equal(prompt.includes(line), true);
  }
  const repair = buildClaimRepairPrompt({
    question: input.question,
    missing: 1,
    existingClaims: [claim("Pineapple on pizza is a preference, not a rule.")]
  });
  assert.match(repair, /exactly 1 new claim/);
  assert.match(repair, /Do not invent extra claims to pad the list/);
});

test("zero claims can be repaired with two model-supplied claims", async () => {
  let calls = 0;
  const proposal = await resolveOllamaProposal("grok", "qwen2.5:7b", rawProposal([]), async (request) => {
    calls += 1;
    assert.equal(request.missing, 2);
    assert.deepEqual(request.existingClaims, []);
    return {
      claims: [
        claim("Pineapple on pizza is a preference, not a culinary rule."),
        claim("The evidence here is personal taste, so the answer stays uncertain.")
      ]
    };
  });

  assert.equal(calls, 1);
  assert.deepEqual(proposal.claims.map((item) => item.statement), [
    "Pineapple on pizza is a preference, not a culinary rule.",
    "The evidence here is personal taste, so the answer stays uncertain."
  ]);
});

test("one valid claim is preserved and the repair adds only the missing claim", async () => {
  let calls = 0;
  const proposal = await resolveOllamaProposal("grok", "qwen2.5:7b", rawProposal([
    claim("Pineapple on pizza is a preference, not a culinary rule.")
  ]), async (request) => {
    calls += 1;
    assert.equal(request.missing, 1);
    assert.equal(request.existingClaims.length, 1);
    return {
      claims: [claim("The evidence here is personal taste, so the answer stays uncertain.")]
    };
  });

  assert.equal(calls, 1);
  assert.deepEqual(proposal.claims.map((item) => item.id), ["grok:c1", "grok:c2"]);
  assert.equal(proposal.claims[0]?.statement, "Pineapple on pizza is a preference, not a culinary rule.");
  assert.equal(proposal.claims[1]?.statement, "The evidence here is personal taste, so the answer stays uncertain.");
});

test("a failed repair reports the attempt and does not pad the short list", async () => {
  let calls = 0;
  const original = claim("Pineapple on pizza is a preference, not a culinary rule.");

  await assert.rejects(
    () => resolveOllamaProposal("grok", "qwen2.5:7b", rawProposal([original]), async () => {
      calls += 1;
      return { claims: [original] };
    }),
    (error: unknown) => {
      assert.equal(calls, 1);
      assert.ok(error instanceof Error);
      assert.match(error.message, /Proposal failed for grok \(qwen2\.5:7b\): after repair \(first attempt had 1 claim\(s\)\)/);
      assert.match(error.message, /Array must contain at least 2 element\(s\)/);
      return true;
    }
  );

  assert.deepEqual(mergeRepairedClaims(rawProposal([]), { claims: [] }).claims, []);
  assert.throws(
    () => proposalSchema.parse({ ...rawProposal([original]), agentId: "grok", model: "qwen2.5:7b" }),
    /Array must contain at least 2 element\(s\)/
  );
});

test("zero claims stays failed when the repair returns only one claim", async () => {
  await assert.rejects(
    () => resolveOllamaProposal("grok", "qwen2.5:7b", rawProposal([]), async () => ({
      claims: [claim("Pineapple on pizza is a preference, not a culinary rule.")]
    })),
    /after repair \(first attempt had 0 claim\(s\)\)/
  );
});

test("a proposal that already has two claims does not ask for a repair", async () => {
  let calls = 0;
  const proposal = await resolveOllamaProposal("grok", "qwen2.5:7b", rawProposal([
    claim("Pineapple on pizza is a preference, not a culinary rule."),
    claim("The evidence here is personal taste, so the answer stays uncertain.")
  ]), async () => {
    calls += 1;
    return { claims: [] };
  });

  assert.equal(calls, 0);
  assert.equal(proposal.claims.length, 2);
});
