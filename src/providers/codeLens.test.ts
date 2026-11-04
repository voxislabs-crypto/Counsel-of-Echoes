import assert from "node:assert/strict";
import test from "node:test";
import { runRequestSchema } from "../core/schemas.js";
import { buildCritiquePrompt, buildProposalPrompt, buildSynthesisPrompt } from "./ollamaProvider.js";
import type { Critique, Proposal, ResolutionTraceItem } from "../core/schemas.js";

const snippet = "function greet(name) { return 'hi ' + name }";

test("a general run keeps the code disagreement lines out of the prompts", () => {
  const proposal = buildProposalPrompt("gpt", {
    question: "Should the greeting stay simple?",
    context: snippet,
    peers: ["claude", "grok"],
    lens: "general"
  });
  const critique = buildCritiquePrompt(critiqueInput("general"));
  const synthesis = buildSynthesisPrompt(synthesisInput("general"));

  assert.doesNotMatch(proposal, /Code review:/);
  assert.doesNotMatch(critique, /Code critique:/);
  assert.doesNotMatch(synthesis, /Code verdict:/);
  assert.match(proposal, /Context: function greet/);
});

test("code review asks for a concrete approach, a competing critique, and a verdict", () => {
  const proposal = buildProposalPrompt("claude", {
    question: "How should this greeting become more lifelike?",
    context: snippet,
    peers: ["gpt", "grok"],
    lens: "code"
  });
  const critique = buildCritiquePrompt(critiqueInput("code"));
  const synthesis = buildSynthesisPrompt(synthesisInput("code"));

  assert.match(proposal, /Propose one concrete implementation/);
  assert.match(proposal, /what the other pattern gives up/);
  assert.match(proposal, /Do not invent file paths/);
  assert.match(critique, /stronger implementation/);
  assert.match(critique, /does not invent an evidenceId/);
  assert.match(critique, /empty evidenceFindings array/);
  assert.match(synthesis, /competing code choices/);
  assert.match(synthesis, /concrete edits/);
  assert.match(synthesis, /Do not invent another disposition/);
});

test("the run request defaults to a general lens", () => {
  const parsed = runRequestSchema.parse({
    question: "How should this greeting become more lifelike?"
  });
  assert.equal(parsed.lens, "general");
  assert.equal(runRequestSchema.parse({
    question: "How should this greeting become more lifelike?",
    lens: "code",
    context: snippet
  }).lens, "code");
});

function critiqueInput(lens: "general" | "code") {
  return {
    question: "How should this greeting become more lifelike?",
    context: snippet,
    target: proposal("gpt"),
    peers: [proposal("claude")],
    lens
  };
}

function synthesisInput(lens: "general" | "code") {
  return {
    question: "How should this greeting become more lifelike?",
    context: snippet,
    proposals: [proposal("gpt"), proposal("claude")],
    critiques: [critique("grok")],
    resolutionTrace: [trace()],
    lens
  };
}

function proposal(agentId: "gpt" | "claude" | "grok"): Proposal {
  return {
    agentId,
    model: "mock",
    stance: "Return a structured greeting.",
    summary: "Keep the function small and explicit.",
    claims: [
      {
        id: `${agentId}:c1`,
        statement: "Pass the tone in as an argument.",
        rationale: "The caller can choose the voice.",
        confidence: 0.6,
        risk: "Every caller must now supply a tone.",
        evidenceIds: []
      },
      {
        id: `${agentId}:c2`,
        statement: "Keep the string template in the function.",
        rationale: "The current function already returns one string.",
        confidence: 0.4,
        risk: "A second voice requires another edit.",
        evidenceIds: []
      }
    ],
    assumptions: ["The snippet is the whole function."],
    risks: ["A larger persona system may not fit this shape."],
    confidence: 0.5
  };
}

function critique(agentId: "gpt" | "claude" | "grok"): Critique {
  return {
    agentId,
    targetAgentId: "gpt",
    challengedClaimIds: ["gpt:c1"],
    usefulAgreements: ["The function stays small."],
    concerns: ["An extra argument spreads tone choices to every caller."],
    recommendation: "Prefer a lookup table when more than one voice is required.",
    severity: "medium",
    evidenceFindings: []
  };
}

function trace(): ResolutionTraceItem {
  return {
    statement: "Pass the tone in as an argument.",
    disposition: "monitor",
    sourceAgents: ["gpt"],
    challengedBy: ["grok"],
    score: 0.5,
    claimRef: "gpt:c1",
    rationale: "The seats named two workable patterns.",
    evidenceStatus: "unchecked"
  };
}
