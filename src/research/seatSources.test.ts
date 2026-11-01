import assert from "node:assert/strict";
import test from "node:test";
import { sourceAdapterFor } from "./seatSources.js";
import { gather } from "./service.js";
import type { SearchLead } from "./types.js";
import { loadWikipediaEvidence } from "./wikipedia.js";

const now = "2026-11-01T00:00:00.000Z";

function lead(title: string, url: string): SearchLead {
  return { title, url, snippet: `${title} snippet` };
}

const quietReddit = {
  search: async () => []
};

const quietScholar = {
  search: async () => []
};

test("each seat reads its own source", () => {
  assert.equal(sourceAdapterFor("gpt")?.seat, "gpt");
  assert.equal(sourceAdapterFor("gpt")?.sourceKind, "wikipedia");
  assert.equal(sourceAdapterFor("claude")?.seat, "claude");
  assert.equal(sourceAdapterFor("claude")?.sourceKind, "scholar");
  assert.equal(sourceAdapterFor("grok")?.seat, "grok");
  assert.equal(sourceAdapterFor("grok")?.sourceKind, "reddit");
  assert.equal(sourceAdapterFor("voxis"), undefined);
});

test("wikipedia retrieval keeps at most three items, their urls, and a bounded excerpt", async () => {
  const seen: string[] = [];
  const longExcerpt = Array.from({ length: 200 }, () => "bounded").join(" ");
  const retrieval = await loadWikipediaEvidence("local council reliability", {
    now: () => now,
    search: async (query) => {
      seen.push(query);
      return [
        lead("One", "https://en.wikipedia.org/wiki/One"),
        lead("Two", "https://en.wikipedia.org/wiki/Two"),
        lead("Three", "https://en.wikipedia.org/wiki/Three"),
        lead("Four", "https://en.wikipedia.org/wiki/Four")
      ];
    },
    excerpt: async (title) => `${title} ${longExcerpt}`
  });

  assert.deepEqual(seen, ["local council reliability"]);
  assert.equal(retrieval.failed, 0);
  assert.equal(retrieval.items.length, 3);
  assert.deepEqual(retrieval.items.map((item) => item.id), ["wikipedia:1", "wikipedia:2", "wikipedia:3"]);
  assert.equal(retrieval.items[0]?.sourceUrl, "https://en.wikipedia.org/wiki/One");
  assert.equal(retrieval.items[0]?.sourceKind, "wikipedia");
  assert.equal(retrieval.items[0]?.retrievedAt, now);
  assert.ok((retrieval.items[0]?.excerpt.length ?? 0) <= 800);
  assert.equal(retrieval.items.some((item) => item.title === "Four"), false);
});

test("a failed wikipedia search returns no items", async () => {
  const retrieval = await loadWikipediaEvidence("local council reliability", {
    search: async () => {
      throw new Error("Wikipedia rate limited");
    }
  });

  assert.deepEqual(retrieval, { items: [], failed: 0 });
});

test("a failed excerpt is skipped and the remaining item keeps the next id", async () => {
  const retrieval = await loadWikipediaEvidence("local council reliability", {
    now: () => now,
    search: async () => [
      lead("Missing", "https://en.wikipedia.org/wiki/Missing"),
      lead("Kept", "https://en.wikipedia.org/wiki/Kept")
    ],
    excerpt: async (title) => {
      if (title === "Missing") throw new Error("no extract");
      return "Kept excerpt from the article.";
    }
  });

  assert.equal(retrieval.failed, 1);
  assert.equal(retrieval.items.length, 1);
  assert.equal(retrieval.items[0]?.id, "wikipedia:1");
  assert.equal(retrieval.items[0]?.title, "Kept");
  assert.equal(retrieval.items[0]?.sourceUrl, "https://en.wikipedia.org/wiki/Kept");
});

test("research on fills the shared bundle from the strategist adapter", async () => {
  const bundle = await gather({
    query: "Should a local council prefer reliability?",
    mode: "ollama",
    wikipedia: {
      now: () => now,
      search: async (query) => {
        assert.equal(query, "Should a local council prefer reliability?");
        return [lead("Reliability", "https://en.wikipedia.org/wiki/Reliability")];
      },
      excerpt: async () => "Reliability is the chance a seat finishes its answer."
    },
    reddit: quietReddit,
    scholar: quietScholar
  });

  assert.equal(bundle.status, "ok");
  assert.equal(bundle.items.length, 1);
  assert.equal(bundle.items[0]?.id, "wikipedia:1");
  assert.equal(bundle.items[0]?.sourceKind, "wikipedia");
  assert.equal(bundle.items[0]?.sourceUrl, "https://en.wikipedia.org/wiki/Reliability");
});

test("a wikipedia failure during research on leaves an empty bundle", async () => {
  const bundle = await gather({
    query: "Should a local council prefer reliability?",
    mode: "ollama",
    wikipedia: {
      search: async () => {
        throw new Error("Wikipedia unavailable");
      }
    },
    reddit: quietReddit,
    scholar: quietScholar
  });

  assert.equal(bundle.status, "empty");
  assert.deepEqual(bundle.items, []);
});

test("a partial wikipedia retrieval keeps the items that succeeded", async () => {
  const bundle = await gather({
    query: "Should a local council prefer reliability?",
    mode: "live",
    wikipedia: {
      now: () => now,
      search: async () => [
        lead("Missing", "https://en.wikipedia.org/wiki/Missing"),
        lead("Kept", "https://en.wikipedia.org/wiki/Kept")
      ],
      excerpt: async (title) => {
        if (title === "Missing") return "   ";
        return "Kept excerpt from the article.";
      }
    },
    reddit: quietReddit,
    scholar: quietScholar
  });

  assert.equal(bundle.status, "partial");
  assert.equal(bundle.items.length, 1);
  assert.equal(bundle.items[0]?.title, "Kept");
});

test("mock research still uses fixtures and does not call wikipedia", async () => {
  const bundle = await gather({
    query: "How tall is Mount Everest?",
    mode: "mock",
    wikipedia: {
      search: async () => {
        throw new Error("Wikipedia must not be called in mock mode");
      }
    },
    reddit: {
      search: async () => {
        throw new Error("Reddit must not be called in mock mode");
      }
    },
    scholar: {
      search: async () => {
        throw new Error("Semantic Scholar must not be called in mock mode");
      }
    }
  });

  assert.equal(bundle.status, "ok");
  assert.equal(bundle.items[0]?.sourceKind, "fixture");
  assert.equal(bundle.items[0]?.id, "fixture:1");
  assert.equal(bundle.items[0]?.sourceUrl, "https://en.wikipedia.org/wiki/Mount_Everest");
  assert.match(bundle.items[0]?.excerpt ?? "", /8,848\.86 metres/);
});
