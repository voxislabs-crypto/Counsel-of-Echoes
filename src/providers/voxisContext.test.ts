import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { composeSeatPrompt } from "./ollamaProvider.js";
import { createVoxisContextClient, loadSeatContexts } from "./voxisContext.js";

test("composeSeatPrompt adds a persona block only when Voxis returned one", () => {
  assert.equal(composeSeatPrompt("You are Ara.", ""), "You are Ara.");
  assert.equal(
    composeSeatPrompt("You are Ara.", "Mood: focused"),
    "You are Ara.\n\nPersona context:\nMood: focused"
  );
});

test("loadSeatContexts returns distinct blocks and empty strings when Voxis is down", async () => {
  const calls: string[] = [];
  const client = {
    async fetchSeatContext(seatId: "gpt" | "claude" | "grok") {
      calls.push(seatId);
      if (seatId === "claude") throw new Error("down");
      return `context for ${seatId}`;
    },
    async writeRound() {
      return { ok: true, written: 0 };
    }
  };

  const loaded = await loadSeatContexts(client, ["gpt", "claude", "grok"], "harbor vote", true);
  assert.deepEqual(calls.sort(), ["claude", "gpt", "grok"]);
  assert.equal(loaded.get("gpt"), "context for gpt");
  assert.equal(loaded.get("claude"), "");
  assert.equal(loaded.get("grok"), "context for grok");

  const down = createVoxisContextClient({
    voxisContext: true,
    voxisUrl: "http://127.0.0.1:9",
    voxisTimeoutMs: 200,
    voxisMaxChars: 700
  });
  assert.equal(await down.fetchSeatContext("gpt", "harbor vote"), "");
  assert.deepEqual(await down.writeRound({
    topic: "harbor vote",
    outcome: "Delay it.",
    seats: ["gpt"]
  }), { ok: false, written: 0 });
});

test("context fetch reads the context field and writeRound does not throw", async () => {
  const seen: Array<{ url?: string; body?: unknown }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { seatId?: string };
      seen.push({ url: req.url, body });
      if (req.url === "/api/internal/context") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ context: `Mood for ${body.seatId}` }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, written: [{ seatId: "gpt" }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const client = createVoxisContextClient({
    voxisContext: true,
    voxisUrl: `http://127.0.0.1:${port}`,
    voxisTimeoutMs: 1000,
    voxisMaxChars: 700
  });

  try {
    const loaded = await loadSeatContexts(client, ["gpt", "grok"], "harbor", true);
    assert.equal(loaded.get("gpt"), "Mood for gpt");
    assert.equal(loaded.get("grok"), "Mood for grok");
    assert.deepEqual(await client.writeRound({
      topic: "harbor",
      outcome: "Delay the vote.",
      seats: ["gpt", "grok"]
    }), { ok: true, written: 1 });
    assert.equal(seen.filter((entry) => entry.url === "/api/internal/context").length, 2);
    assert.equal(seen.filter((entry) => entry.url === "/api/internal/round").length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
