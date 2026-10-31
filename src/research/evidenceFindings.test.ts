import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { settleSeatTasks } from "../core/proposalStage.js";
import { critiqueSchema, proposalSchema, type Critique, type Proposal } from "../core/schemas.js";
import { RunStore } from "../store/runStore.js";
import { resolveEvidenceFindings, type ClaimEvidenceRef } from "./evidenceFindings.js";
import { evidenceFindingSchema, type EvidenceBundle, type EvidenceItem } from "./schemas.js";

const claims = [
  { id: "gpt:c1", evidenceIds: [] as string[] },
  { id: "gpt:c2", evidenceIds: [] as string[] }
];

function item(id: string, sourceUrl: string): EvidenceItem {
  return {
    id,
    sourceUrl,
    retrievedAt: "2026-10-31T00:00:00.000Z",
    title: id,
    excerpt: "A short excerpt from the source.",
    sourceKind: "wikipedia"
  };
}

function bundle(items: EvidenceItem[]): EvidenceBundle {
  return {
    items,
    query: "local council reliability",
    status: items.length === 0 ? "empty" : "ok"
  };
}

function context(overrides: Partial<{ seat: string; model: string; claims: ClaimEvidenceRef[] }> = {}) {
  return {
    seat: "grok",
    model: "qwen2.5:7b",
    claims,
    ...overrides
  };
}

test("a null evidenceId resolves from the only loaded source when the claim cites none", () => {
  const resolved = resolveEvidenceFindings([
    { claimId: "gpt:c1", evidenceId: null, relation: "supports" }
  ], bundle([item("wikipedia:1", "https://en.wikipedia.org/wiki/Reliability")]), context());

  assert.deepEqual(resolved, [
    { claimId: "gpt:c1", evidenceId: "wikipedia:1", relation: "supports" }
  ]);
  assert.doesNotThrow(() => evidenceFindingSchema.parse((resolved as unknown[])[0]));
});

test("a null evidenceId resolves from a unique source URL among several items", () => {
  const resolved = resolveEvidenceFindings([
    {
      claimId: "gpt:c2",
      evidenceId: "",
      relation: "contradicts",
      sourceUrl: "https://en.wikipedia.org/wiki/Diversity"
    }
  ], bundle([
    item("wikipedia:1", "https://en.wikipedia.org/wiki/Reliability"),
    item("wikipedia:2", "https://en.wikipedia.org/wiki/Diversity")
  ]), context());

  const findings = resolved as Array<{ evidenceId: string }>;
  assert.equal(findings[0].evidenceId, "wikipedia:2");
  assert.equal(evidenceFindingSchema.parse(findings[0]).evidenceId, "wikipedia:2");
});

test("a null evidenceId resolves from the claim's single evidence id", () => {
  const resolved = resolveEvidenceFindings([
    { claimId: "gpt:c1", evidenceId: null, relation: "unrelated" }
  ], bundle([
    item("wikipedia:1", "https://en.wikipedia.org/wiki/Reliability"),
    item("wikipedia:2", "https://en.wikipedia.org/wiki/Diversity")
  ]), context({
    claims: [{ id: "gpt:c1", evidenceIds: ["wikipedia:2"] }]
  }));

  assert.equal((resolved as Array<{ evidenceId: string }>)[0].evidenceId, "wikipedia:2");
});

test("a null evidenceId with no unique source fails and names the seat, model, and sources", () => {
  assert.throws(
    () => resolveEvidenceFindings([
      { claimId: "gpt:c1", evidenceId: null, relation: "supports" },
      { claimId: "gpt:c2", evidenceId: null, relation: "contradicts" }
    ], undefined, context()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Cannot resolve null evidenceId for grok \(qwen2\.5:7b\)/);
      assert.match(error.message, /Evidence sources: none/);
      assert.match(error.message, /finding\[0\] claimId=gpt:c1 evidenceId was null/);
      assert.match(error.message, /finding\[1\] claimId=gpt:c2 evidenceId was null/);
      assert.doesNotMatch(error.message, /Expected string, received null/);
      assert.doesNotMatch(error.message, /on the first attempt/);
      return true;
    }
  );

  const direct = evidenceFindingSchema.safeParse({
    claimId: "gpt:c1",
    evidenceId: null,
    relation: "supports"
  });
  assert.equal(direct.success, false);
  if (!direct.success) {
    assert.match(direct.error.issues[0]?.message ?? "", /Expected string, received null/);
  }
});

test("a named source that is not in the bundle fails instead of borrowing another id", () => {
  assert.throws(
    () => resolveEvidenceFindings([
      {
        claimId: "gpt:c1",
        evidenceId: null,
        relation: "supports",
        sourceUrl: "https://example.test/missing"
      }
    ], bundle([item("wikipedia:1", "https://en.wikipedia.org/wiki/Reliability")]), context()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Evidence sources: wikipedia:1 https:\/\/en\.wikipedia\.org\/wiki\/Reliability/);
      assert.match(error.message, /finding named https:\/\/example\.test\/missing/);
      assert.doesNotMatch(error.message, /wikipedia:1 https:\/\/example/);
      return true;
    }
  );
});

test("a valid evidenceId passes through unchanged", () => {
  const finding = { claimId: "gpt:c1", evidenceId: "wikipedia:9", relation: "supports" };
  const resolved = resolveEvidenceFindings([finding], undefined, context());
  assert.deepEqual(resolved, [finding]);
  assert.equal(evidenceFindingSchema.parse(finding).evidenceId, "wikipedia:9");
});

test("a non-string evidenceId fails instead of being coerced", () => {
  assert.throws(
    () => resolveEvidenceFindings([
      { claimId: "gpt:c1", evidenceId: 4, relation: "supports" }
    ], undefined, context()),
    /finding\[0\] claimId=gpt:c1 evidenceId was number/
  );
});

test("evidence assembly failure preserves completed proposals and critiques", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coe-evidence-"));
  try {
    const store = new RunStore(dir);
    await store.initialize();
    const record = store.createRun({
      question: "Should a local council prefer reliability?",
      context: "",
      mode: "ollama",
      research: false
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

    await assert.rejects(
      () => settleSeatTasks([
        {
          agentId: "gpt",
          modelName: "llama3.1:8b",
          run: async () => {
            const critique = storedCritique("gpt", "claude");
            await store.appendEvent(record.runId, {
              runId: record.runId,
              type: "critique.completed",
              agentId: "gpt",
              payload: { critique }
            });
            return critique;
          }
        },
        {
          agentId: "claude",
          modelName: "mistral:7b",
          run: async () => {
            const critique = storedCritique("claude", "grok");
            await store.appendEvent(record.runId, {
              runId: record.runId,
              type: "critique.completed",
              agentId: "claude",
              payload: { critique }
            });
            return critique;
          }
        },
        {
          agentId: "grok",
          modelName: "qwen2.5:7b",
          run: async () => {
            resolveEvidenceFindings([
              { claimId: "gpt:c1", evidenceId: null, relation: "supports" },
              { claimId: "gpt:c2", evidenceId: null, relation: "contradicts" }
            ], undefined, context());
            return storedCritique("grok", "gpt");
          }
        }
      ], "Critique stage"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Critique stage failed for 1 of 3 seats/);
        assert.match(error.message, /gpt \(llama3\.1:8b\): completed/);
        assert.match(error.message, /claude \(mistral:7b\): completed/);
        assert.match(error.message, /grok \(qwen2\.5:7b\): failed: Cannot resolve null evidenceId for grok \(qwen2\.5:7b\)/);
        assert.match(error.message, /Evidence sources: none/);
        assert.match(error.message, /finding\[0\]/);
        assert.match(error.message, /finding\[1\]/);
        return true;
      }
    );

    const message = "Critique stage failed while resolving evidenceId";
    await store.appendEvent(record.runId, {
      runId: record.runId,
      type: "run.failed",
      payload: { message }
    });
    await store.setStatus(record.runId, "failed", message);

    const saved = JSON.parse(await readFile(path.join(dir, `${record.runId}.json`), "utf8")) as {
      status: string;
      proposals: Proposal[];
      critiques: Critique[];
    };
    assert.equal(saved.status, "failed");
    assert.deepEqual(saved.proposals.map((proposal) => proposal.agentId), ["gpt", "claude", "grok"]);
    assert.deepEqual(saved.critiques.map((critique) => critique.agentId), ["gpt", "claude"]);
    assert.equal(saved.critiques.some((critique) => critique.agentId === "grok"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function storedProposal(agentId: "gpt" | "claude" | "grok", model: string): Proposal {
  return proposalSchema.parse({
    agentId,
    model,
    stance: "Reliability comes first at this size.",
    summary: "Instruction following matters more than style diversity on CPU.",
    claims: [
      {
        id: "c1",
        statement: "A dropped seat hides its reasoning from the council.",
        rationale: "The run cannot compare a missing proposal.",
        confidence: 0.6,
        risk: "The remaining seats may look more certain than they are.",
        evidenceIds: []
      },
      {
        id: "c2",
        statement: "Diversity still matters once each seat can finish.",
        rationale: "Style only helps if the output validates.",
        confidence: 0.4,
        risk: "Reliability can collapse every seat into the same answer.",
        evidenceIds: []
      }
    ],
    assumptions: ["The three seats stay mapped as they are."],
    risks: ["A schema failure can still end the round."],
    confidence: 0.5
  });
}

function storedCritique(agentId: "gpt" | "claude" | "grok", targetAgentId: "gpt" | "claude" | "grok"): Critique {
  return critiqueSchema.parse({
    agentId,
    targetAgentId,
    challengedClaimIds: [`${targetAgentId}:c1`],
    usefulAgreements: ["The uncertainty is explicit."],
    concerns: ["The claim has no evidence id."],
    recommendation: "Monitor until a source is attached.",
    severity: "medium",
    evidenceFindings: []
  });
}
