import assert from "node:assert/strict";
import test from "node:test";
import { proposalSchema } from "../core/schemas.js";
import { parseOllamaProposal } from "./ollamaProvider.js";
import { normalizeStringList } from "./proposalNormalize.js";

function rawProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stance: "Proceed.",
    summary: "A short plan.",
    claims: [
      {
        id: "c1",
        statement: "One claim.",
        rationale: "Because it is testable.",
        confidence: 0.5,
        risk: "Low.",
        evidenceIds: []
      },
      {
        id: "c2",
        statement: "Another claim.",
        rationale: "Because it is narrow.",
        confidence: 0.6,
        risk: "Also low.",
        evidenceIds: []
      }
    ],
    assumptions: ["We have models."],
    risks: ["Time is short."],
    confidence: 0.7,
    ...overrides
  };
}

test("string assumptions and risks pass through trimmed", () => {
  const proposal = parseOllamaProposal("gpt", "llama3.1:8b", rawProposal({
    assumptions: ["  We have models.  "],
    risks: ["Time is short."]
  }));

  assert.deepEqual(proposal.assumptions, ["We have models."]);
  assert.deepEqual(proposal.risks, ["Time is short."]);
  assert.equal(proposal.agentId, "gpt");
  assert.equal(proposal.model, "llama3.1:8b");
});

test("object assumptions and risks keep their fields as labeled strings", () => {
  const proposal = parseOllamaProposal("claude", "mistral:7b", rawProposal({
    assumptions: [{ assumption: "We have models.", impact: "high", unused: "   " }],
    risks: [
      { risk: "Limited time", likelihood: "medium" },
      { risk: "Thin evidence", severity: "high", score: 0.25, active: false }
    ]
  }));

  assert.deepEqual(proposal.assumptions, ["assumption: We have models.; impact: high"]);
  assert.deepEqual(proposal.risks, [
    "risk: Limited time; likelihood: medium",
    "risk: Thin evidence; severity: high; score: 0.25; active: false"
  ]);
});

test("one nested object level is kept and a deeper object is rejected", () => {
  assert.deepEqual(
    normalizeStringList("assumptions", [{ constraint: { name: "budget", note: "fixed" } }]),
    ["constraint.name: budget; constraint.note: fixed"]
  );

  assert.throws(
    () => normalizeStringList("assumptions", [{ constraint: { detail: { note: "fixed" } } }]),
    /assumptions\[0\]\.constraint\.detail was nested more than one level/
  );
});

test("malformed or missing list values name the field and do not invent text", () => {
  assert.throws(
    () => parseOllamaProposal("gpt", "llama3.1:8b", rawProposal({ assumptions: undefined })),
    /Proposal failed for gpt \(llama3\.1:8b\): assumptions must be an array of strings/
  );
  assert.throws(
    () => parseOllamaProposal("grok", "qwen2.5:7b", rawProposal({ risks: [] })),
    /Proposal failed for grok \(qwen2\.5:7b\)/
  );
  assert.throws(() => normalizeStringList("risks", "Time is short."), /risks must be an array of strings/);
  assert.throws(() => normalizeStringList("assumptions", [""]), /assumptions\[0\] was an empty string/);
  assert.throws(() => normalizeStringList("assumptions", [null]), /assumptions\[0\] was null/);
  assert.throws(() => normalizeStringList("risks", [{ note: null }]), /risks\[0\] object contained no string, number, or boolean values/);
  assert.throws(
    () => normalizeStringList("risks", [{ sources: [{ name: "lab" }] }]),
    /risks\[0\]\.sources\[0\] was an object, expected a string, number, or boolean/
  );
});

test("proposalSchema stays strict for object-shaped assumptions", () => {
  assert.throws(() => proposalSchema.parse({
    ...rawProposal({ assumptions: [{ text: "We have models." }] }),
    agentId: "grok",
    model: "qwen2.5:7b"
  }), /Expected string, received object/);
});
