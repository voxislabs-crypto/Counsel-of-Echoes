import { collectEvidenceItems, MAX_EVIDENCE_ITEMS, type EvidenceRetrieval } from "./collectEvidence.js";
import { buildSourceQuery } from "./searchText.js";
import { safeFetch } from "./safeFetch.js";
import type { SearchLead } from "./types.js";

const SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
const SCHOLAR_HEADERS = {
  Accept: "application/json",
  "User-Agent": "CounselOfEchoes/0.1 (research; local)"
};

export type ScholarPaper = {
  title: string;
  abstract: string;
  url: string;
  paperId?: string;
  doi?: string;
  arxivId?: string;
  citationCount: number;
  year?: number;
};

export type ScholarSearchRequest = {
  query: string;
};

export type ScholarClient = {
  search?: (input: ScholarSearchRequest) => Promise<ScholarPaper[]>;
  now?: () => string;
};

export function buildScholarSearchText(question: string, claim?: string): string {
  return buildSourceQuery(question, claim);
}

// Analyst retrieval. A failed or rate-limited Semantic Scholar call returns no items.
export async function loadScholarEvidence(input: {
  query: string;
  claim?: string;
  client?: ScholarClient;
}): Promise<EvidenceRetrieval> {
  try {
    const query = buildScholarSearchText(input.query, input.claim);
    if (!query) return { items: [], failed: 0 };

    const search = input.client?.search ?? defaultSearch;
    const papers = await search({ query });
    const chosen = rankPapers(papers).slice(0, MAX_EVIDENCE_ITEMS);
    const nowIso = input.client?.now?.() ?? new Date().toISOString();
    const leads: SearchLead[] = [];
    let failed = 0;

    for (const paper of chosen) {
      const url = scholarSourceUrl(paper);
      if (!url || !paper.abstract.trim() || !paper.title.trim()) {
        failed += 1;
        continue;
      }
      leads.push({
        title: paper.title.trim(),
        url,
        snippet: paper.abstract
      });
    }

    const collected = await collectEvidenceItems(
      leads,
      "scholar",
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

export function scholarSourceUrl(paper: Pick<ScholarPaper, "doi" | "arxivId" | "url" | "paperId">): string | undefined {
  const doi = paper.doi?.trim();
  if (doi && /^10\.\d{4,9}\/\S+$/.test(doi)) {
    return `https://doi.org/${doi}`;
  }

  const arxiv = paper.arxivId?.trim().replace(/^arxiv:/i, "");
  if (arxiv && /^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(v\d+)?)$/i.test(arxiv)) {
    return `https://arxiv.org/abs/${arxiv}`;
  }

  const page = paper.url?.trim() ?? "";
  if (/^https:\/\/(?:www\.)?semanticscholar\.org\/paper\/\S+$/.test(page)) {
    return page;
  }

  const paperId = paper.paperId?.trim() ?? "";
  if (/^[a-f0-9]{40}$/i.test(paperId)) {
    return `https://www.semanticscholar.org/paper/${paperId}`;
  }

  return undefined;
}

function rankPapers(papers: ScholarPaper[]): ScholarPaper[] {
  return papers
    .filter((paper) => paper.title.trim().length > 0 && paper.abstract.trim().length > 0 && scholarSourceUrl(paper))
    .sort((left, right) => right.citationCount - left.citationCount || (right.year ?? 0) - (left.year ?? 0));
}

function defaultSearch(input: ScholarSearchRequest): Promise<ScholarPaper[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("query", input.query);
  url.searchParams.set("limit", "10");
  url.searchParams.set("fields", "paperId,title,abstract,url,externalIds,citationCount,year");
  return safeFetch(url.toString(), undefined, SCHOLAR_HEADERS).then((response) => parseScholarPapers(response.text));
}

function parseScholarPapers(text: string): ScholarPaper[] {
  const body = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
  return (body.data ?? []).flatMap((paper) => {
    const title = typeof paper.title === "string" ? paper.title : "";
    if (!title.trim()) return [];
    const externalIds = paper.externalIds && typeof paper.externalIds === "object"
      ? paper.externalIds as Record<string, unknown>
      : {};
    return [{
      title,
      abstract: typeof paper.abstract === "string" ? paper.abstract : "",
      url: typeof paper.url === "string" ? paper.url : "",
      paperId: typeof paper.paperId === "string" ? paper.paperId : undefined,
      doi: typeof externalIds.DOI === "string" ? externalIds.DOI : undefined,
      arxivId: typeof externalIds.ArXiv === "string" ? externalIds.ArXiv : undefined,
      citationCount: typeof paper.citationCount === "number" ? paper.citationCount : 0,
      year: typeof paper.year === "number" ? paper.year : undefined
    }];
  });
}
