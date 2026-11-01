import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRedditSearchText,
  loadRedditEvidence,
  normalizeSubreddits,
  type RedditPost
} from "./reddit.js";
import { gather, gatherForRun } from "./service.js";

const now = "2026-11-01T00:00:00.000Z";
const nowMs = Date.parse(now);

function post(overrides: Partial<RedditPost> = {}): RedditPost {
  return {
    title: "A disagreement worth having",
    selftext: "The post body says the claim is still unsettled.",
    score: 10,
    createdUtc: Math.floor(nowMs / 1000) - 86_400,
    permalink: "/r/changemyview/comments/abc/a-disagreement/",
    author: "someone",
    removed: false,
    stickied: false,
    ...overrides
  };
}

test("reddit retrieval keeps the three highest-scoring posts and their permalinks", async () => {
  const retrieval = await loadRedditEvidence({
    query: "Should a local council prefer reliability?",
    client: {
      now: () => now,
      nowMs,
      subreddits: ["r/changemyview", "bad name", "r/AskHistorians"],
      search: async (input) => {
        assert.equal(input.query, "Should a local council prefer reliability?");
        assert.deepEqual(input.subreddits, ["changemyview", "AskHistorians"]);
        return [
          post({ title: "Low", score: 2, permalink: "/r/changemyview/comments/low/low/" }),
          post({ title: "Highest", score: 40, permalink: "/r/changemyview/comments/high/highest/" }),
          post({ title: "Middle", score: 15, permalink: "/r/AskHistorians/comments/mid/middle/" }),
          post({ title: "Newer tie", score: 15, createdUtc: Math.floor(nowMs / 1000) - 3_600, permalink: "/r/explainlikeimfive/comments/new/newer/" })
        ];
      },
      comments: async () => []
    }
  });

  assert.equal(retrieval.failed, 0);
  assert.deepEqual(retrieval.items.map((item) => item.title), ["Highest", "Newer tie", "Middle"]);
  assert.deepEqual(retrieval.items.map((item) => item.id), ["reddit:1", "reddit:2", "reddit:3"]);
  assert.equal(retrieval.items[0]?.sourceUrl, "https://www.reddit.com/r/changemyview/comments/high/highest/");
  assert.equal(retrieval.items[0]?.sourceKind, "reddit");
  assert.equal(retrieval.items[2]?.sourceUrl, "https://www.reddit.com/r/AskHistorians/comments/mid/middle/");
});

test("a rate-limited reddit search returns no items", async () => {
  const retrieval = await loadRedditEvidence({
    query: "Should a local council prefer reliability?",
    client: {
      search: async () => {
        throw new Error("Reddit rate limited");
      }
    }
  });

  assert.deepEqual(retrieval, { items: [], failed: 0 });
});

test("a reddit excerpt prefers the top comment and stays within 800 characters", async () => {
  const longComment = Array.from({ length: 200 }, () => "bounded").join(" ");
  const retrieval = await loadRedditEvidence({
    query: "Should a local council prefer reliability?",
    client: {
      now: () => now,
      nowMs,
      search: async () => [post({ selftext: "Post body that should lose to the comment." })],
      comments: async () => [
        { body: "[removed]", score: 100, author: "someone" },
        { body: longComment, score: 12, author: "reader" },
        { body: "A short aside.", score: 3, author: "reader" }
      ]
    }
  });

  assert.equal(retrieval.items.length, 1);
  assert.ok((retrieval.items[0]?.excerpt.length ?? 0) <= 800);
  assert.match(retrieval.items[0]?.excerpt ?? "", /^bounded/);
  assert.doesNotMatch(retrieval.items[0]?.excerpt ?? "", /Post body/);
});

test("deleted, stickied, low-score, and old reddit posts are skipped", async () => {
  const retrieval = await loadRedditEvidence({
    query: "Should a local council prefer reliability?",
    client: {
      now: () => now,
      nowMs,
      search: async () => [
        post({ title: "Removed", score: 80, removed: true }),
        post({ title: "Stickied", score: 70, stickied: true }),
        post({ title: "Downvoted", score: 0 }),
        post({ title: "Ancient", score: 50, createdUtc: Math.floor(nowMs / 1000) - (400 * 86_400) }),
        post({ title: "Kept", score: 4, selftext: "A recent comment thread remains." })
      ],
      comments: async () => []
    }
  });

  assert.deepEqual(retrieval.items.map((item) => item.title), ["Kept"]);
  assert.equal(retrieval.items[0]?.sourceUrl, "https://www.reddit.com/r/changemyview/comments/abc/a-disagreement/");
});

test("an optional claim is added to the reddit query", () => {
  assert.equal(
    buildRedditSearchText("Should a local council prefer reliability?", "A dropped seat hides its reasoning."),
    "Should a local council prefer reliability? A dropped seat hides its reasoning."
  );
  assert.deepEqual(normalizeSubreddits(), ["changemyview", "AskHistorians", "explainlikeimfive"]);
});

test("reddit results join the shared bundle and a reddit failure leaves wikipedia in place", async () => {
  const question = "Should a local council prefer reliability?";
  const both = await gather({
    query: question,
    mode: "ollama",
    wikipedia: {
      now: () => now,
      search: async () => [{
        title: "Reliability",
        url: "https://en.wikipedia.org/wiki/Reliability",
        snippet: "Reliability snippet"
      }],
      excerpt: async () => "Reliability is the chance a seat finishes."
    },
    reddit: {
      now: () => now,
      nowMs,
      search: async () => [post()],
      comments: async () => []
    },
    scholar: { search: async () => [] }
  });

  assert.equal(both.status, "ok");
  assert.deepEqual(both.items.map((item) => item.sourceKind), ["wikipedia", "reddit"]);
  assert.equal(both.items[0]?.id, "wikipedia:1");
  assert.equal(both.items[1]?.id, "reddit:1");
  assert.equal(both.items[1]?.sourceUrl, "https://www.reddit.com/r/changemyview/comments/abc/a-disagreement/");

  const wikipediaOnly = await gather({
    query: question,
    mode: "ollama",
    wikipedia: {
      now: () => now,
      search: async () => [{
        title: "Reliability",
        url: "https://en.wikipedia.org/wiki/Reliability",
        snippet: "Reliability snippet"
      }],
      excerpt: async () => "Reliability is the chance a seat finishes."
    },
    reddit: {
      search: async () => {
        throw new Error("Reddit unavailable");
      }
    },
    scholar: { search: async () => [] }
  });

  assert.equal(wikipediaOnly.status, "ok");
  assert.deepEqual(wikipediaOnly.items.map((item) => item.id), ["wikipedia:1"]);
});

test("mock mode uses fixtures and does not call reddit", async () => {
  let redditCalls = 0;
  const bundle = await gather({
    query: "How tall is Mount Everest?",
    mode: "mock",
    reddit: {
      search: async () => {
        redditCalls += 1;
        throw new Error("Reddit must not be called in mock mode");
      }
    }
  });

  assert.equal(redditCalls, 0);
  assert.equal(bundle.items[0]?.sourceKind, "fixture");
  assert.equal(bundle.items[0]?.id, "fixture:1");
});

test("research off skips reddit entirely", async () => {
  let calls = 0;
  const bundle = await gatherForRun({
    research: false,
    query: "Should a local council prefer reliability?",
    mode: "ollama",
    wikipedia: {
      search: async () => {
        calls += 1;
        return [];
      }
    },
    reddit: {
      search: async () => {
        calls += 1;
        return [];
      }
    }
  });

  assert.equal(bundle, undefined);
  assert.equal(calls, 0);
});
