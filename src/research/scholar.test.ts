import assert from "node:assert/strict";
import test from "node:test";
import { buildScholarSearchText, loadScholarEvidence, scholarSourceUrl, type ScholarPaper } from "./scholar.js";
import { gather, gatherForRun } from "./service.js";

const now = "2026-11-01T00:00:00.000Z";
const paperId = "a".repeat(40);

function paper(overrides: Partial<ScholarPaper> = {}): ScholarPaper {
  return {
    title: "A measured result",
    abstract: "The abstract states the finding in one paragraph.",
    url: `https://www.semanticscholar.org/paper/A-measured-result/${paperId}`,
    paperId,
    citationCount: 10,
    year: 2020,
    ...overrides
  };
}

test("scholar retrieval keeps three papers and prefers a DOI", async () => {
  const seen: string[] = [];
  const retrieval = await loadScholarEvidence({
    query: "Should a local council prefer reliability?",
    claim: "A dropped seat hides its reasoning.",
    client: {
      now: () => now,
      search: async (input) => {
        seen.push(input.query);
        return [
          paper({
            title: "ArXiv only",
            arxivId: "1706.03762",
            doi: undefined,
            citationCount: 500,
            url: ""
          }),
          paper({
            title: "No abstract",
            abstract: "   ",
            doi: "10.1000/no-abstract",
            citationCount: 900
          }),
          paper({
            title: "No identifier",
            doi: undefined,
            arxivId: undefined,
            url: "",
            paperId: undefined,
            citationCount: 800
          }),
          paper({
            title: "Most cited DOI",
            doi: "10.1145/3292500.3330701",
            citationCount: 40
          }),
          paper({
            title: "Second DOI",
            doi: "10.1145/3292500.3330702",
            citationCount: 30
          }),
          paper({
            title: "Third DOI",
            doi: "10.1145/3292500.3330703",
            citationCount: 20
          }),
          paper({
            title: "Fourth DOI",
            doi: "10.1145/3292500.3330704",
            citationCount: 5
          })
        ];
      }
    }
  });

  assert.deepEqual(seen, [
    "Should a local council prefer reliability? A dropped seat hides its reasoning."
  ]);
  assert.equal(retrieval.failed, 0);
  assert.deepEqual(retrieval.items.map((item) => item.title), [
    "ArXiv only",
    "Most cited DOI",
    "Second DOI"
  ]);
  assert.deepEqual(retrieval.items.map((item) => item.id), ["scholar:1", "scholar:2", "scholar:3"]);
  assert.equal(retrieval.items[0]?.sourceUrl, "https://arxiv.org/abs/1706.03762");
  assert.equal(retrieval.items[1]?.sourceUrl, "https://doi.org/10.1145/3292500.3330701");
  assert.equal(retrieval.items[0]?.sourceKind, "scholar");
  assert.equal(retrieval.items[0]?.retrievedAt, now);
});

test("an arXiv id and a Semantic Scholar page are kept when no DOI is present", () => {
  assert.equal(
    scholarSourceUrl(paper({ doi: "10.1145/3292500.3330701", arxivId: "1706.03762" })),
    "https://doi.org/10.1145/3292500.3330701"
  );
  assert.equal(
    scholarSourceUrl(paper({ doi: undefined, arxivId: "1706.03762", url: "" })),
    "https://arxiv.org/abs/1706.03762"
  );
  assert.equal(
    scholarSourceUrl(paper({ doi: undefined, arxivId: undefined })),
    `https://www.semanticscholar.org/paper/A-measured-result/${paperId}`
  );
  assert.equal(
    buildScholarSearchText("Should a local council prefer reliability?"),
    "Should a local council prefer reliability?"
  );
});

test("a rate-limited scholar search returns no items", async () => {
  const retrieval = await loadScholarEvidence({
    query: "Should a local council prefer reliability?",
    client: {
      search: async () => {
        throw new Error("Semantic Scholar rate limited");
      }
    }
  });

  assert.deepEqual(retrieval, { items: [], failed: 0 });
});

test("a scholar abstract stays within 800 characters", async () => {
  const longAbstract = Array.from({ length: 200 }, () => "bounded").join(" ");
  const retrieval = await loadScholarEvidence({
    query: "Should a local council prefer reliability?",
    client: {
      now: () => now,
      search: async () => [paper({ abstract: longAbstract, doi: "10.1000/long-abstract" })]
    }
  });

  assert.equal(retrieval.items.length, 1);
  assert.ok((retrieval.items[0]?.excerpt.length ?? 0) <= 800);
  assert.match(retrieval.items[0]?.excerpt ?? "", /^bounded/);
  assert.equal(retrieval.items[0]?.sourceUrl, "https://doi.org/10.1000/long-abstract");
});

test("scholar results follow wikipedia and reddit, and a scholar failure leaves them in place", async () => {
  const question = "Should a local council prefer reliability?";
  const wikipedia = {
    now: () => now,
    search: async () => [{
      title: "Reliability",
      url: "https://en.wikipedia.org/wiki/Reliability",
      snippet: "Reliability snippet"
    }],
    excerpt: async () => "Reliability is the chance a seat finishes."
  };
  const reddit = {
    now: () => now,
    nowMs: Date.parse(now),
    search: async () => [{
      title: "A disagreement worth having",
      selftext: "The post body says the claim is still unsettled.",
      score: 10,
      createdUtc: Math.floor(Date.parse(now) / 1000) - 86_400,
      permalink: "/r/changemyview/comments/abc/a-disagreement/",
      author: "someone",
      removed: false,
      stickied: false
    }],
    comments: async () => []
  };

  const allThree = await gather({
    query: question,
    mode: "ollama",
    wikipedia,
    reddit,
    scholar: {
      now: () => now,
      search: async () => [paper({ doi: "10.1145/3292500.3330701" })]
    }
  });

  assert.equal(allThree.status, "ok");
  assert.deepEqual(allThree.items.map((item) => item.sourceKind), ["wikipedia", "reddit", "scholar"]);
  assert.equal(allThree.items[2]?.id, "scholar:1");
  assert.equal(allThree.items[2]?.sourceUrl, "https://doi.org/10.1145/3292500.3330701");

  const withoutScholar = await gather({
    query: question,
    mode: "ollama",
    wikipedia,
    reddit,
    scholar: {
      search: async () => {
        throw new Error("Semantic Scholar unavailable");
      }
    }
  });

  assert.equal(withoutScholar.status, "ok");
  assert.deepEqual(withoutScholar.items.map((item) => item.sourceKind), ["wikipedia", "reddit"]);
  assert.equal(withoutScholar.items[0]?.id, "wikipedia:1");
  assert.equal(withoutScholar.items[1]?.id, "reddit:1");
});

test("mock mode uses fixtures and does not call semantic scholar", async () => {
  let scholarCalls = 0;
  const bundle = await gather({
    query: "How tall is Mount Everest?",
    mode: "mock",
    scholar: {
      search: async () => {
        scholarCalls += 1;
        throw new Error("Semantic Scholar must not be called in mock mode");
      }
    }
  });

  assert.equal(scholarCalls, 0);
  assert.equal(bundle.items[0]?.sourceKind, "fixture");
  assert.equal(bundle.items[0]?.id, "fixture:1");
});

test("research off skips the scholar adapter entirely", async () => {
  let calls = 0;
  const bundle = await gatherForRun({
    research: false,
    query: "Should a local council prefer reliability?",
    mode: "ollama",
    wikipedia: { search: async () => { calls += 1; return []; } },
    reddit: { search: async () => { calls += 1; return []; } },
    scholar: { search: async () => { calls += 1; return []; } }
  });

  assert.equal(bundle, undefined);
  assert.equal(calls, 0);
});
