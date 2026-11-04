import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { settleSeatTasks } from "../core/proposalStage.js";
import { critiqueSchema, proposalSchema, type Proposal } from "../core/schemas.js";
import { RunStore } from "../store/runStore.js";
import { assembleOllamaCritique, buildCritiquePrompt, parseOllamaCritique } from "./ollamaProvider.js";
import type { CritiqueInput } from "./types.js";

function rawCritique(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetAgentId: "claude",
    challengedClaimIds: ["claude:c1"],
    usefulAgreements: ["The function stays small."],
    concerns: ["The extra argument spreads the tone choice."],
    recommendation: "Keep the voice in one lookup.",
    severity: "medium",
    ...overrides
  };
}

test("string concerns pass through trimmed", () => {
  const critique = parseOllamaCritique("gpt", "llama3.1:8b", rawCritique({
    concerns: ["  The extra argument spreads the tone choice.  "]
  }), []);

  assert.deepEqual(critique.concerns, ["The extra argument spreads the tone choice."]);
  assert.equal(critique.agentId, "gpt");
  assert.equal(critique.targetAgentId, "claude");
});

test("object concerns keep their fields as labeled strings", () => {
  const critique = parseOllamaCritique("grok", "qwen2.5:7b", rawCritique({
    concerns: [
      { claimId: "claude:c1", concern: "A tone argument forces every caller to choose." },
      { claimId: "claude:c2", issue: "The template hides the second voice.", severity: "high" }
    ],
    usefulAgreements: [{ claimId: "claude:c2", agreement: "The function stays small." }]
  }), []);

  assert.deepEqual(critique.concerns, [
    "claimId: claude:c1; concern: A tone argument forces every caller to choose.",
    "claimId: claude:c2; issue: The template hides the second voice.; severity: high"
  ]);
  assert.deepEqual(critique.usefulAgreements, [
    "claimId: claude:c2; agreement: The function stays small."
  ]);
});

test("an object concern with no usable fields fails instead of inventing text", () => {
  assert.throws(
    () => parseOllamaCritique("claude", "mistral:7b", rawCritique({
      concerns: [{ note: null }]
    }), []),
    /Critique failed for claude \(mistral:7b\): concerns\[0\] object contained no string, number, or boolean values/
  );
});

test("the critique schema still rejects an object concern", () => {
  const parsed = critiqueSchema.safeParse(rawCritique({
    agentId: "gpt",
    concerns: [{ concern: "Too wide." }]
  }));

  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.equal(parsed.error.issues[0]?.message, "Expected string, received object");
    assert.deepEqual(parsed.error.issues[0]?.path, ["concerns", 0]);
  }
});

test("a missing targetAgentId is derived from the critiqued seat", () => {
  const omitted = rawCritique();
  delete omitted.targetAgentId;
  const fromOmitted = parseOllamaCritique("gpt", "llama3.1:8b", omitted, [], "claude");
  const fromNull = parseOllamaCritique("grok", "qwen2.5:7b", rawCritique({
    targetAgentId: null
  }), [], "claude");
  const fromBlank = parseOllamaCritique("gpt", "llama3.1:8b", rawCritique({
    targetAgentId: "  "
  }), [], "claude");

  assert.equal(fromOmitted.targetAgentId, "claude");
  assert.equal(fromNull.targetAgentId, "claude");
  assert.equal(fromBlank.targetAgentId, "claude");
  assert.equal(fromOmitted.agentId, "gpt");
});

test("a missing targetAgentId with no critiqued seat fails and a foreign id is not replaced", () => {
  const omitted = rawCritique();
  delete omitted.targetAgentId;

  assert.throws(
    () => parseOllamaCritique("gpt", "llama3.1:8b", omitted, []),
    /Critique failed for gpt \(llama3\.1:8b\): targetAgentId was missing and no single critiqued seat was available/
  );
  assert.throws(
    () => parseOllamaCritique("grok", "qwen2.5:7b", rawCritique({
      targetAgentId: "analyst"
    }), [], "claude"),
    /Critique failed for grok \(qwen2\.5:7b\): targetAgentId was "analyst", which is not a council seat/
  );
  assert.throws(
    () => parseOllamaCritique("claude", "mistral:7b", rawCritique({
      targetAgentId: { agentId: "gpt" }
    }), [], "gpt"),
    /Critique failed for claude \(mistral:7b\): targetAgentId was an object, expected a seat id string/
  );

  const parsed = critiqueSchema.safeParse({
    agentId: "gpt",
    challengedClaimIds: ["claude:c1"],
    usefulAgreements: ["The function stays small."],
    concerns: ["The extra argument spreads the tone choice."],
    recommendation: "Keep the voice in one lookup.",
    severity: "medium"
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((item) => item.path[0] === "targetAgentId");
    assert.equal(issue?.code, "invalid_type");
    assert.equal(issue && "received" in issue ? issue.received : undefined, "undefined");
    assert.match(String(issue && "expected" in issue ? issue.expected : ""), /gpt/);
    assert.deepEqual(issue?.path, ["targetAgentId"]);
  }
});

test("a null evidenceId with an empty bundle still fails", () => {
  const raw = rawCritique({
    evidenceFindings: [
      { claimId: "gpt:c1", evidenceId: null, relation: "supports" }
    ]
  });
  delete raw.targetAgentId;

  assert.throws(
    () => assembleOllamaCritique("claude", "mistral:7b", raw, {
      claims: [{ id: "gpt:c1", evidenceIds: [] }],
      targetAgentId: "gpt"
    }),
    /Cannot resolve null evidenceId for claude \(mistral:7b\)[\s\S]*Evidence sources: none[\s\S]*evidenceId was null and no unique evidence source matched/
  );
});

test("a valid targetAgentId passes through", () => {
  const critique = parseOllamaCritique("gpt", "llama3.1:8b", rawCritique({
    targetAgentId: "  grok  "
  }), [], "claude");

  assert.equal(critique.targetAgentId, "grok");
  assert.equal(critique.agentId, "gpt");
});

test("the critique prompt names the seat and forbids null evidence ids", () => {
  const general = buildCritiquePrompt(promptInput("general"));
  const code = buildCritiquePrompt(promptInput("code"));

  assert.match(general, /targetAgentId is a plain string naming the one seat/);
  assert.match(general, /gpt, claude, or grok/);
  assert.match(general, /Return an empty evidenceFindings array/);
  assert.match(general, /do not set evidenceId to null/);
  assert.doesNotMatch(general, /Code review still requires/);
  assert.match(code, /Code review still requires targetAgentId as the plain seat id/);
  assert.match(code, /A null evidenceId is not a finding/);
  assert.match(code, /evidenceFindings as \[\]/);
});

test("a critique failure leaves completed proposals on the record", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coe-critique-target-"));
  try {
    const store = new RunStore(dir);
    await store.initialize();
    const record = store.createRun({
      question: "How should this greeting become more lifelike?",
      context: "function greet(name) { return 'hi ' + name }",
      mode: "ollama",
      research: false,
      lens: "code"
    });
    const proposals = [
      storedProposal("gpt", "llama3.1:8b"),
      storedProposal("claude", "mistral:7b"),
      storedProposal("grok", "qwen2.5:7b")
    ];

    for (const proposal of proposals) {
      await store.appendEvent(record.runId, {
        runId: record.runId,
        type: "proposal.completed",
        agentId: proposal.agentId,
        payload: { proposal }
      });
    }

    const omitted = rawCritique();
    delete omitted.targetAgentId;

    await assert.rejects(
      () => settleSeatTasks([
        {
          agentId: "gpt",
          modelName: "llama3.1:8b",
          run: async () => parseOllamaCritique("gpt", "llama3.1:8b", omitted, [])
        },
        {
          agentId: "grok",
          modelName: "qwen2.5:7b",
          run: async () => parseOllamaCritique("grok", "qwen2.5:7b", omitted, [])
        },
        {
          agentId: "claude",
          modelName: "mistral:7b",
          run: async () => assembleOllamaCritique("claude", "mistral:7b", {
            ...omitted,
            evidenceFindings: [
              { claimId: "gpt:c1", evidenceId: null, relation: "supports" }
            ]
          }, {
            claims: [{ id: "gpt:c1", evidenceIds: [] }],
            targetAgentId: "gpt"
          })
        }
      ], "Critique stage"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Critique stage failed for 3 of 3 seats/);
        assert.match(error.message, /gpt \(llama3\.1:8b\): failed: Critique failed for gpt \(llama3\.1:8b\): targetAgentId was missing/);
        assert.match(error.message, /grok \(qwen2\.5:7b\): failed: Critique failed for grok \(qwen2\.5:7b\): targetAgentId was missing/);
        assert.match(error.message, /claude \(mistral:7b\): failed: Cannot resolve null evidenceId for claude \(mistral:7b\)/);
        assert.match(error.message, /Evidence sources: none/);
        return true;
      }
    );

    const message = "Critique stage failed";
    await store.appendEvent(record.runId, {
      runId: record.runId,
      type: "run.failed",
      payload: { message }
    });
    await store.setStatus(record.runId, "failed", message);

    const saved = JSON.parse(await readFile(path.join(dir, `${record.runId}.json`), "utf8")) as {
      status: string;
      proposals: Proposal[];
      critiques: unknown[];
    };
    assert.equal(saved.status, "failed");
    assert.deepEqual(saved.proposals.map((proposal) => proposal.agentId), ["gpt", "claude", "grok"]);
    assert.deepEqual(saved.critiques, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function promptInput(lens: "general" | "code"): CritiqueInput {
  return {
    question: "How should this greeting become more lifelike?",
    context: "function greet(name) { return 'hi ' + name }",
    target: storedProposal("claude", "mistral:7b"),
    peers: [storedProposal("gpt", "llama3.1:8b")],
    lens
  };
}

function storedProposal(agentId: "gpt" | "claude" | "grok", model: string): Proposal {
  return proposalSchema.parse({
    agentId,
    model,
    stance: "Keep the voice in one lookup.",
    summary: "The function stays small and explicit.",
    claims: [
      {
        id: "c1",
        statement: "Pass the tone in as an argument.",
        rationale: "The caller can choose the voice.",
        confidence: 0.6,
        risk: "Every caller must now supply a tone.",
        evidenceIds: []
      },
      {
        id: "c2",
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
  });
}
