import assert from "node:assert/strict";
import test from "node:test";
import { OLLAMA_CHAT_TIMEOUT_MS, requestOllamaChat } from "./ollamaChat.js";

const endpoint = "http://127.0.0.1:9/api/chat";

test("a transient fetch failure is retried once and then recovers", async () => {
  let calls = 0;
  const content = await requestOllamaChat(endpoint, { model: "qwen2.5:7b" }, async (_url, _payload, timeoutMs) => {
    assert.equal(timeoutMs, OLLAMA_CHAT_TIMEOUT_MS);
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return { status: 200, body: JSON.stringify({ message: { content: "{\"ok\":true}" } }) };
  });

  assert.equal(calls, 2);
  assert.equal(content, "{\"ok\":true}");
});

test("a hard fetch failure stays a fetch error and does not look like a schema failure", async () => {
  let calls = 0;

  await assert.rejects(
    () => requestOllamaChat(endpoint, { model: "qwen2.5:7b" }, async () => {
      calls += 1;
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_HEADERS_TIMEOUT", message: "Headers Timeout Error" }
      });
    }),
    (error: unknown) => {
      assert.equal(calls, 2);
      assert.ok(error instanceof Error);
      assert.equal(error.message, `fetch timed out after ${OLLAMA_CHAT_TIMEOUT_MS / 1000}s`);
      assert.doesNotMatch(error.message, /on the first attempt/);
      assert.doesNotMatch(error.message, /claims/);
      return true;
    }
  );
});

test("an HTTP failure is not retried", async () => {
  let calls = 0;

  await assert.rejects(
    () => requestOllamaChat(endpoint, { model: "qwen2.5:7b" }, async () => {
      calls += 1;
      return { status: 500, body: "nope" };
    }),
    /ollama request failed with 500/
  );
  assert.equal(calls, 1);
});
