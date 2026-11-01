import { collectEvidenceItems, MAX_EVIDENCE_ITEMS, type EvidenceRetrieval } from "./collectEvidence.js";
import { safeFetch } from "./safeFetch.js";
import type { SearchLead } from "./types.js";

export const DEFAULT_REDDIT_SUBREDDITS = ["changemyview", "AskHistorians", "explainlikeimfive"] as const;
export const DEFAULT_REDDIT_MIN_SCORE = 1;
export const DEFAULT_REDDIT_MAX_AGE_DAYS = 365;

const MAX_SUBREDDITS = 8;
const MAX_COMMENT_LOOKUPS = 6;
const REDDIT_HEADERS = {
  Accept: "application/json",
  "User-Agent": "CounselOfEchoes/0.1 (research; local)"
};

export type RedditPost = {
  title: string;
  selftext: string;
  score: number;
  createdUtc: number;
  permalink: string;
  author: string;
  removed: boolean;
  stickied: boolean;
};

export type RedditComment = {
  body: string;
  score: number;
  author: string;
};

export type RedditSearchRequest = {
  query: string;
  subreddits: string[];
};

export type RedditClient = {
  search?: (input: RedditSearchRequest) => Promise<RedditPost[]>;
  comments?: (post: RedditPost) => Promise<RedditComment[]>;
  subreddits?: string[];
  minScore?: number;
  maxAgeDays?: number;
  now?: () => string;
  nowMs?: number;
};

export function normalizeSubreddits(values?: string[]): string[] {
  if (!values || values.length === 0) return [...DEFAULT_REDDIT_SUBREDDITS];

  const names: string[] = [];
  for (const value of values) {
    const name = value.trim().replace(/^\/?r\//i, "").replace(/\/+$/, "");
    if (!/^[A-Za-z0-9_]{2,21}$/.test(name)) continue;
    if (names.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue;
    names.push(name);
    if (names.length === MAX_SUBREDDITS) break;
  }
  return names;
}

export function buildRedditSearchText(question: string, claim?: string): string {
  const asked = question.trim();
  const extra = claim?.trim() ?? "";
  const parts = [asked];
  if (extra && extra.toLowerCase() !== asked.toLowerCase()) {
    parts.push(extra);
  }
  return parts.filter(Boolean).join(" ").slice(0, 300);
}

// Chaos Gremlin retrieval. A failed or rate-limited Reddit call returns no items.
export async function loadRedditEvidence(input: {
  query: string;
  claim?: string;
  client?: RedditClient;
}): Promise<EvidenceRetrieval> {
  try {
    const subreddits = normalizeSubreddits(input.client?.subreddits);
    const query = buildRedditSearchText(input.query, input.claim);
    if (subreddits.length === 0 || !query) return { items: [], failed: 0 };

    const nowIso = input.client?.now?.() ?? new Date().toISOString();
    const nowMs = input.client?.nowMs ?? Date.parse(nowIso);
    const search = input.client?.search ?? defaultSearch;
    const comments = input.client?.comments ?? defaultComments;
    const posts = await search({ query, subreddits });
    const ranked = rankPosts(posts, {
      minScore: input.client?.minScore ?? DEFAULT_REDDIT_MIN_SCORE,
      maxAgeDays: input.client?.maxAgeDays ?? DEFAULT_REDDIT_MAX_AGE_DAYS,
      nowMs
    });

    const leads: SearchLead[] = [];
    let failed = 0;
    let lookups = 0;
    for (const post of ranked) {
      if (leads.length >= MAX_EVIDENCE_ITEMS || lookups >= MAX_COMMENT_LOOKUPS) break;
      lookups += 1;
      const url = redditPermalink(post.permalink);
      if (!url) {
        failed += 1;
        continue;
      }
      const excerpt = await excerptForPost(post, comments);
      if (!excerpt) {
        failed += 1;
        continue;
      }
      leads.push({ title: post.title.trim(), url, snippet: excerpt });
    }

    const collected = await collectEvidenceItems(
      leads,
      "reddit",
      async (lead) => lead.snippet,
      () => nowIso
    );
    return {
      items: collected.items,
      failed: failed + collected.failed
    };
  } catch {
    return { items: [], failed: 0 };
  }
}

function rankPosts(
  posts: RedditPost[],
  options: { minScore: number; maxAgeDays: number; nowMs: number }
): RedditPost[] {
  const maxAgeSeconds = options.maxAgeDays * 24 * 60 * 60;
  const nowSeconds = options.nowMs / 1000;
  return posts
    .filter((post) => usablePost(post, options.minScore, nowSeconds, maxAgeSeconds))
    .sort((left, right) => right.score - left.score || right.createdUtc - left.createdUtc);
}

function usablePost(post: RedditPost, minScore: number, nowSeconds: number, maxAgeSeconds: number): boolean {
  const title = post.title.trim();
  if (!title || title === "[deleted]" || title === "[removed]") return false;
  if (post.removed || post.stickied) return false;
  if (!Number.isFinite(post.score) || post.score < minScore) return false;
  if (!Number.isFinite(post.createdUtc)) return false;
  const ageSeconds = nowSeconds - post.createdUtc;
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) return false;
  return redditPermalink(post.permalink) !== undefined;
}

async function excerptForPost(
  post: RedditPost,
  comments: (post: RedditPost) => Promise<RedditComment[]>
): Promise<string> {
  try {
    const best = bestComment(await comments(post));
    if (best) return best;
  } catch {
    // The post body still stands when the comment listing fails.
  }
  return usableText(post.selftext) ? post.selftext : "";
}

function bestComment(comments: RedditComment[]): string {
  const usable = comments.filter((comment) => {
    if (comment.author === "AutoModerator" || comment.author === "[deleted]") return false;
    return usableText(comment.body);
  });
  usable.sort((left, right) => right.score - left.score);
  return usable[0]?.body ?? "";
}

function usableText(value: string): boolean {
  const text = value.trim();
  return text.length > 0 && text !== "[removed]" && text !== "[deleted]";
}

export function redditPermalink(permalink: string): string | undefined {
  const trimmed = permalink.trim();
  if (trimmed.startsWith("/r/")) {
    return `https://www.reddit.com${trimmed}`;
  }
  if (trimmed.startsWith("https://www.reddit.com/r/") || trimmed.startsWith("https://old.reddit.com/r/")) {
    return trimmed;
  }
  return undefined;
}

function redditSearchUrl(query: string, subreddits: string[]): string {
  const url = new URL(`https://www.reddit.com/r/${subreddits.join("+")}/search.json`);
  url.searchParams.set("q", query);
  url.searchParams.set("restrict_sr", "on");
  url.searchParams.set("sort", "top");
  url.searchParams.set("t", "year");
  url.searchParams.set("limit", "25");
  url.searchParams.set("raw_json", "1");
  return url.toString();
}

async function defaultSearch(input: RedditSearchRequest): Promise<RedditPost[]> {
  const response = await safeFetch(redditSearchUrl(input.query, input.subreddits), undefined, REDDIT_HEADERS);
  return parseRedditPosts(response.text);
}

async function defaultComments(post: RedditPost): Promise<RedditComment[]> {
  const page = redditPermalink(post.permalink);
  if (!page) return [];
  const url = new URL(page);
  url.pathname = `${url.pathname.replace(/\/$/, "")}.json`;
  url.searchParams.set("limit", "8");
  url.searchParams.set("sort", "top");
  url.searchParams.set("raw_json", "1");
  const response = await safeFetch(url.toString(), undefined, REDDIT_HEADERS);
  return parseRedditComments(response.text);
}

function parseRedditPosts(text: string): RedditPost[] {
  const body = JSON.parse(text) as {
    data?: { children?: Array<{ kind?: string; data?: Record<string, unknown> }> };
  };
  return (body.data?.children ?? []).flatMap((child) => {
    if (child.kind && child.kind !== "t3") return [];
    if (!child.data) return [];
    return [readPost(child.data)];
  });
}

function readPost(data: Record<string, unknown>): RedditPost {
  const selftext = typeof data.selftext === "string" ? data.selftext : "";
  return {
    title: typeof data.title === "string" ? data.title : "",
    selftext,
    score: typeof data.score === "number" ? data.score : 0,
    createdUtc: typeof data.created_utc === "number" ? data.created_utc : Number.NaN,
    permalink: typeof data.permalink === "string" ? data.permalink : "",
    author: typeof data.author === "string" ? data.author : "",
    removed: Boolean(data.removed_by_category) || selftext === "[removed]" || selftext === "[deleted]",
    stickied: data.stickied === true
  };
}

function parseRedditComments(text: string): RedditComment[] {
  const body = JSON.parse(text) as unknown;
  if (!Array.isArray(body) || body.length < 2) return [];
  const listing = body[1] as {
    data?: { children?: Array<{ kind?: string; data?: Record<string, unknown> }> };
  };
  return (listing.data?.children ?? []).flatMap((child) => {
    if (child.kind && child.kind !== "t1") return [];
    const data = child.data;
    if (!data) return [];
    return [{
      body: typeof data.body === "string" ? data.body : "",
      score: typeof data.score === "number" ? data.score : 0,
      author: typeof data.author === "string" ? data.author : ""
    }];
  });
}
