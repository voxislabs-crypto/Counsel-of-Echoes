import assert from "node:assert/strict";
import test from "node:test";
import { buildSourceQuery, seatClaimText } from "./searchText.js";
import { gather, gatherForRun } from "./service.js";

const question = "Should a local council prefer reliability?";

test("a long question keeps the seat claim inside the search text", () => {
  const claim = "CLAIM_TOKEN is the seat's own assertion.";
  const text = buildSourceQuery("Q".repeat(280), claim);

  assert.ok(text.length <= 300);
  assert.match(text, /^Q/);
  assert.match(text, /CLAIM_TOKEN/);
});

test("seat claim text keeps distinct statements and drops blanks", () => {
  assert.equal(
    seatClaimText(["  First claim. ", "First claim.", "", "Second claim."]),
    "First claim. Second claim."
  );
  assert.equal(seatClaimText(["   ", ""]), undefined);
});

test("each seat's claim is sent only to that seat's source", async () => {
  const seen = { wikipedia: "", reddit: "", scholar: "" };
  const bundle = await gather({
    query: question,
    mode: "ollama",
    claims: {
      gpt: "Instruction following comes first.",
      claude: "Papers should carry abstracts.",
      grok: "A minority view still matters."
    },
    wikipedia: {
      search: async (query) => {
        seen.wikipedia = query;
        return [];
      }
    },
    reddit: {
      search: async (input) => {
        seen.reddit = input.query;
        return [];
      }
    },
    scholar: {
      search: async (input) => {
        seen.scholar = input.query;
        return [];
      }
    }
  });

  assert.equal(bundle.status, "empty");
  assert.match(seen.wikipedia, /Instruction following comes first/);
  assert.match(seen.scholar, /Papers should carry abstracts/);
  assert.match(seen.reddit, /A minority view still matters/);
  assert.doesNotMatch(seen.wikipedia, /minority view|abstracts/);
  assert.doesNotMatch(seen.scholar, /Instruction following|minority view/);
  assert.doesNotMatch(seen.reddit, /Instruction following|abstracts/);
  for (const query of Object.values(seen)) {
    assert.match(query, /Should a local council prefer reliability/);
  }
});

test("a seat with no claim still searches the question", async () => {
  let scholarQuery = "";
  await gather({
    query: question,
    mode: "live",
    claims: { gpt: "Instruction following comes first." },
    wikipedia: { search: async () => [] },
    reddit: { search: async () => [] },
    scholar: {
      search: async (input) => {
        scholarQuery = input.query;
        return [];
      }
    }
  });

  assert.equal(scholarQuery, question);
});

test("mock mode ignores claim text and uses fixtures", async () => {
  let calls = 0;
  const bundle = await gather({
    query: "How tall is Mount Everest?",
    mode: "mock",
    claims: {
      gpt: "This claim must not be sent to a live source.",
      claude: "Neither should this one.",
      grok: "Nor this one."
    },
    wikipedia: { search: async () => { calls += 1; return []; } },
    reddit: { search: async () => { calls += 1; return []; } },
    scholar: { search: async () => { calls += 1; return []; } }
  });

  assert.equal(calls, 0);
  assert.equal(bundle.items[0]?.sourceKind, "fixture");
  assert.equal(bundle.items[0]?.id, "fixture:1");
});

test("research off skips claim-targeted searches", async () => {
  let calls = 0;
  const bundle = await gatherForRun({
    research: false,
    query: question,
    mode: "ollama",
    claims: {
      gpt: "Instruction following comes first.",
      claude: "Papers should carry abstracts.",
      grok: "A minority view still matters."
    },
    wikipedia: { search: async () => { calls += 1; return []; } },
    reddit: { search: async () => { calls += 1; return []; } },
    scholar: { search: async () => { calls += 1; return []; } }
  });

  assert.equal(bundle, undefined);
  assert.equal(calls, 0);
});
