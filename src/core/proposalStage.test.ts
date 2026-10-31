import assert from "node:assert/strict";
import test from "node:test";
import { settleSeatTasks } from "./proposalStage.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("one seat failing still reports the proposals that are in flight", async () => {
  let slowFinished = false;

  await assert.rejects(
    () => settleSeatTasks([
      {
        agentId: "claude",
        modelName: "mistral:7b",
        run: async () => {
          throw new Error("Proposal failed for claude (mistral:7b): assumptions[0] was an object");
        }
      },
      {
        agentId: "gpt",
        modelName: "llama3.1:8b",
        run: async () => {
          await wait(20);
          return "gpt-proposal";
        }
      },
      {
        agentId: "grok",
        modelName: "qwen2.5:7b",
        run: async () => {
          await wait(40);
          slowFinished = true;
          return "grok-proposal";
        }
      }
    ], "Proposal stage"),
    (error: unknown) => {
      assert.equal(slowFinished, true);
      assert.ok(error instanceof Error);
      assert.match(error.message, /Proposal stage failed for 1 of 3 seats/);
      assert.match(error.message, /claude \(mistral:7b\): failed: assumptions\[0\] was an object/);
      assert.match(error.message, /gpt \(llama3\.1:8b\): completed/);
      assert.match(error.message, /grok \(qwen2\.5:7b\): completed/);
      assert.doesNotMatch(error.message, /completed without synthesis/);
      return true;
    }
  );
});

test("a repaired-seat failure still reports the proposals that completed", async () => {
  await assert.rejects(
    () => settleSeatTasks([
      {
        agentId: "gpt",
        modelName: "llama3.1:8b",
        run: async () => "gpt-proposal"
      },
      {
        agentId: "claude",
        modelName: "mistral:7b",
        run: async () => "claude-proposal"
      },
      {
        agentId: "grok",
        modelName: "qwen2.5:7b",
        run: async () => {
          throw new Error("Proposal failed for grok (qwen2.5:7b): after repair (first attempt had 1 claim(s)): Array must contain at least 2 element(s)");
        }
      }
    ], "Proposal stage"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Proposal stage failed for 1 of 3 seats/);
      assert.match(error.message, /gpt \(llama3\.1:8b\): completed/);
      assert.match(error.message, /claude \(mistral:7b\): completed/);
      assert.match(error.message, /grok \(qwen2\.5:7b\): failed: after repair \(first attempt had 1 claim\(s\)\)/);
      return true;
    }
  );
});

test("a hard fetch failure still preserves the other seats when proposals run in order", async () => {
  const order: string[] = [];

  await assert.rejects(
    () => settleSeatTasks([
      {
        agentId: "gpt",
        modelName: "llama3.1:8b",
        run: async () => {
          order.push("gpt");
          return "gpt-proposal";
        }
      },
      {
        agentId: "grok",
        modelName: "qwen2.5:7b",
        run: async () => {
          order.push("grok");
          throw new Error("Proposal failed for grok (qwen2.5:7b): fetch failed");
        }
      },
      {
        agentId: "claude",
        modelName: "mistral:7b",
        run: async () => {
          order.push("claude");
          return "claude-proposal";
        }
      }
    ], "Proposal stage", { sequential: true }),
    (error: unknown) => {
      assert.deepEqual(order, ["gpt", "grok", "claude"]);
      assert.ok(error instanceof Error);
      assert.match(error.message, /gpt \(llama3\.1:8b\): completed/);
      assert.match(error.message, /claude \(mistral:7b\): completed/);
      assert.match(error.message, /grok \(qwen2\.5:7b\): failed: fetch failed/);
      assert.doesNotMatch(error.message, /Array must contain at least 2 element/);
      return true;
    }
  );
});

test("all seats completing returns their results in seat order", async () => {
  const results = await settleSeatTasks([
    { agentId: "gpt", modelName: "llama3.1:8b", run: async () => "first" },
    { agentId: "claude", modelName: "mistral:7b", run: async () => "second" },
    { agentId: "grok", modelName: "qwen2.5:7b", run: async () => "third" }
  ], "Proposal stage");

  assert.deepEqual(results, ["first", "second", "third"]);
});
