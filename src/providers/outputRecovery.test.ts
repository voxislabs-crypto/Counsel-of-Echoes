import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { proposalSchema, type Proposal } from "../core/schemas.js";
import { RunStore } from "../store/runStore.js";
import { recoverCritique } from "./critiqueOutput.js";
import { outputFailurePayload, StructuredOutputError } from "./outputRecovery.js";
import { buildProposalPrompt, resolveOllamaProposal } from "./ollamaProvider.js";

function claim(statement: string, confidence = 0.4) {
  return {
    id: "c1",
    statement,
    rationale: "Because it can be checked on its own.",
    confidence,
    risk: "The evidence is thin.",
    evidenceIds: [] as string[]
  };
}

function rawProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stance: "Keep the voice in one lookup.",
    summary: "The function stays small.",
    claims: [
      claim("Pass the tone in as an argument.", 0.6),
      claim("Keep the string template in the function.", 0.4),
      claim("Name the lookup in one place.", 0.5),
      claim("Leave the second voice for a later edit.", 0.3)
    ],
    assumptions: ["The snippet is the whole function."],
    risks: ["A second voice needs another edit."],
    confidence: 0.55,
    ...overrides
  };
}

test("the proposal prompt states every required field, including confidence", () => {
  const prompt = buildProposalPrompt("gpt", {
    question: "How should this greeting become more lifelike?",
    context: "",
    peers: ["claude", "grok"]
  });

  assert.match(prompt, /confidence: a number from 0 to 1/);
  assert.match(prompt, /Do not omit it and do not substitute a default/);
  assert.match(prompt, /assumptions: an array of 1 to 4 plain strings/);
  assert.match(prompt, /claims: an array of 2 to 5 claims/);
});

test("a missing confidence is requested once and valid claims stay", async () => {
  let calls = 0;
  const original = rawProposal();
  delete original.confidence;

  const proposal = await resolveOllamaProposal("grok", "qwen2.5:7b", original, async (request) => {
    calls += 1;
    assert.deepEqual([...new Set(request.fields.map((field) => field.path.split(".")[0]))], ["confidence"]);
    assert.match(request.prompt, /Keys you may return: confidence/);
    assert.match(request.prompt, /Do not fabricate/);
    assert.equal((request.preserved.claims as { statement: string }[]).length, 4);
    return {
      confidence: 0.33,
      summary: "Regenerated summary that must be ignored.",
      claims: [claim("A replacement claim that must be ignored.")]
    };
  });

  assert.equal(calls, 1);
  assert.equal(proposal.confidence, 0.33);
  assert.equal(proposal.summary, "The function stays small.");
  assert.deepEqual(proposal.claims.map((item) => item.statement), [
    "Pass the tone in as an argument.",
    "Keep the string template in the function.",
    "Name the lookup in one place.",
    "Leave the second voice for a later edit."
  ]);
});

test("a numeric confidence string is parsed and an object confidence is not invented", async () => {
  let calls = 0;
  const parsed = await resolveOllamaProposal("gpt", "llama3.1:8b", rawProposal({
    confidence: "0.42"
  }), async () => {
    calls += 1;
    return { confidence: 0.5 };
  });
  assert.equal(calls, 0);
  assert.equal(parsed.confidence, 0.42);

  let repairCalls = 0;
  const repaired = await resolveOllamaProposal("claude", "mistral:7b", rawProposal({
    confidence: { score: 0.9 }
  }), async (request) => {
    repairCalls += 1;
    assert.equal(request.preserved.confidence, undefined);
    assert.match(request.prompt, /do not substitute a default/i);
    return { confidence: 0.25 };
  });
  assert.equal(repairCalls, 1);
  assert.equal(repaired.confidence, 0.25);
});

test("an invalid assumptions array is repaired without padding claims", async () => {
  const proposal = await resolveOllamaProposal("gpt", "llama3.1:8b", rawProposal({
    assumptions: []
  }), async (request) => {
    assert.ok(request.fields.some((field) => field.path === "assumptions" || field.path.startsWith("assumptions.")));
    return { assumptions: ["The snippet is the whole function."] };
  });

  assert.deepEqual(proposal.assumptions, ["The snippet is the whole function."]);
  assert.equal(proposal.claims.length, 4);
});

test("a wrong-type list that cannot be rendered is not replaced with invented text", async () => {
  let calls = 0;
  const proposal = await resolveOllamaProposal("gpt", "llama3.1:8b", rawProposal({
    assumptions: [{ note: null }]
  }), async (request) => {
    calls += 1;
    assert.equal(request.preserved.assumptions, undefined);
    assert.match(request.prompt, /left unchanged|Expected string, received object|plain strings/);
    return { assumptions: ["Models are local."] };
  });

  assert.equal(calls, 1);
  assert.deepEqual(proposal.assumptions, ["Models are local."]);
});

test("an unsuccessful confidence repair keeps the trace and does not default the number", async () => {
  let calls = 0;
  const original = rawProposal();
  delete original.confidence;

  await assert.rejects(
    () => resolveOllamaProposal("grok", "qwen2.5:7b", original, async (request) => {
      calls += 1;
      assert.equal(request.preserved.confidence, undefined);
      return { confidence: "high" };
    }),
    (error: unknown) => {
      assert.equal(calls, 1);
      assert.ok(error instanceof StructuredOutputError);
      assert.match(error.message, /Proposal failed for grok \(qwen2\.5:7b\): after repair:/);
      assert.match(error.message, /confidence/);
      assert.equal(error.trace.result, "failed");
      assert.equal(error.trace.seat, "grok");
      assert.equal(error.trace.model, "qwen2.5:7b");
      assert.equal((error.trace.raw as { confidence?: unknown }).confidence, undefined);
      assert.deepEqual((error.trace.repairRaw as { confidence?: unknown }).confidence, "high");
      assert.ok(error.trace.validationErrors.some((issue) => issue.path === "confidence"));
      assert.equal((error.trace.repairRequest?.preserved.claims as unknown[]).length, 4);
      assert.equal(error.trace.normalizations.some((note) => note.action.includes("0.5")), false);
      return true;
    }
  );
});

test("object concerns normalize without a repair, and a null evidenceId is not invented", async () => {
  let concernCalls = 0;
  const normalized = await recoverCritique("gpt", "llama3.1:8b", rawCritique({
    concerns: [{ claimId: "claude:c1", concern: "The extra argument spreads the tone choice." }]
  }), {
    claims: [{ id: "claude:c1", evidenceIds: [] }],
    targetAgentId: "claude"
  }, async () => {
    concernCalls += 1;
    return {};
  });
  assert.equal(concernCalls, 0);
  assert.deepEqual(normalized.concerns, [
    "claimId: claude:c1; concern: The extra argument spreads the tone choice."
  ]);

  let evidenceCalls = 0;
  const cleared = await recoverCritique("claude", "mistral:7b", rawCritique({
    evidenceFindings: [{ claimId: "gpt:c1", evidenceId: null, relation: "supports" }]
  }), {
    claims: [{ id: "gpt:c1", evidenceIds: [] }],
    targetAgentId: "gpt"
  }, async (request) => {
    evidenceCalls += 1;
    assert.match(request.prompt, /null evidenceId is not a finding|Do not set evidenceId to null|empty array/);
    assert.equal(request.prompt.includes("fixture:"), false);
    return { evidenceFindings: [] };
  });
  assert.equal(evidenceCalls, 1);
  assert.deepEqual(cleared.evidenceFindings, []);

  await assert.rejects(
    () => recoverCritique("claude", "mistral:7b", rawCritique({
      evidenceFindings: [{ claimId: "gpt:c1", evidenceId: null, relation: "supports" }]
    }), {
      claims: [{ id: "gpt:c1", evidenceIds: [] }],
      targetAgentId: "gpt"
    }, async () => ({
      evidenceFindings: [{ claimId: "gpt:c1", evidenceId: null, relation: "supports" }]
    })),
    (error: unknown) => {
      assert.ok(error instanceof StructuredOutputError);
      assert.match(error.message, /Critique failed for claude \(mistral:7b\)/);
      assert.match(error.message, /Cannot resolve null evidenceId for claude \(mistral:7b\)/);
      assert.match(error.message, /Evidence sources: none/);
      assert.equal(JSON.stringify(error.trace.repairRaw).includes("wikipedia:"), false);
      return true;
    }
  );
});

test("a missing targetAgentId is derived without repair, and a foreign id is not rewritten", async () => {
  let calls = 0;
  const omitted = rawCritique();
  delete omitted.targetAgentId;
  const derived = await recoverCritique("gpt", "llama3.1:8b", omitted, {
    claims: [],
    targetAgentId: "claude"
  }, async () => {
    calls += 1;
    return { targetAgentId: "grok" };
  });
  assert.equal(calls, 0);
  assert.equal(derived.targetAgentId, "claude");

  await assert.rejects(
    () => recoverCritique("grok", "qwen2.5:7b", rawCritique({ targetAgentId: "analyst" }), {
      claims: [],
      targetAgentId: "claude"
    }, async () => ({ targetAgentId: "analyst" })),
    /targetAgentId was "analyst", which is not a council seat/
  );
});

test("a failed proposal is recorded without dropping the seats that succeeded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coe-output-recovery-"));
  try {
    const store = new RunStore(dir);
    await store.initialize();
    const record = store.createRun({
      question: "How should this greeting become more lifelike?",
      context: "",
      mode: "ollama",
      research: false,
      lens: "code"
    });
    const failure = new StructuredOutputError("Proposal failed for gpt (llama3.1:8b): after repair: confidence: Required (number)", {
      seat: "gpt",
      model: "llama3.1:8b",
      stage: "proposal",
      raw: { summary: "missing confidence" },
      normalizations: [],
      validationErrors: [{ path: "confidence", code: "invalid_type", expected: "number", message: "Required (number)" }],
      result: "failed",
      finalValidationErrors: [{ path: "confidence", code: "invalid_type", expected: "number", message: "Required (number)" }]
    });
    const payload = outputFailurePayload(failure);

    await store.appendEvent(record.runId, {
      runId: record.runId,
      type: "proposal.failed",
      agentId: "gpt",
      payload: { message: payload.message, outputTrace: payload.outputTrace }
    });
    await store.appendEvent(record.runId, {
      runId: record.runId,
      type: "proposal.completed",
      agentId: "claude",
      payload: { proposal: storedProposal("claude", "mistral:7b") }
    });
    await store.appendEvent(record.runId, {
      runId: record.runId,
      type: "proposal.completed",
      agentId: "grok",
      payload: { proposal: storedProposal("grok", "qwen2.5:7b") }
    });

    const saved = JSON.parse(await readFile(path.join(dir, `${record.runId}.json`), "utf8")) as {
      proposals: Proposal[];
      events: { type: string; agentId?: string; payload: { outputTrace?: { raw?: unknown } } }[];
    };
    assert.deepEqual(saved.proposals.map((proposal) => proposal.agentId), ["claude", "grok"]);
    const failed = saved.events.find((event) => event.type === "proposal.failed");
    assert.equal(failed?.agentId, "gpt");
    assert.deepEqual(failed?.payload.outputTrace?.raw, { summary: "missing confidence" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function rawCritique(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetAgentId: "claude",
    challengedClaimIds: ["claude:c1"],
    usefulAgreements: ["The function stays small."],
    concerns: ["The extra argument spreads the tone choice."],
    recommendation: "Keep the voice in one lookup.",
    severity: "medium",
    evidenceFindings: [],
    ...overrides
  };
}

function storedProposal(agentId: "claude" | "grok", model: string): Proposal {
  return proposalSchema.parse({
    ...rawProposal(),
    agentId,
    model
  });
}
