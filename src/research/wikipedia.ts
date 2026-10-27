import { htmlToText, safeFetch } from "./safeFetch.js";
import type { SearchLead, SearchProvider } from "./types.js";

const API_URL = "https://en.wikipedia.org/w/api.php";

export const wikipediaSearch: SearchProvider = {
  async search(query: string): Promise<SearchLead[]> {
    const url = new URL(API_URL);
    url.searchParams.set("action", "query");
    url.searchParams.set("list", "search");
    url.searchParams.set("srsearch", query.slice(0, 300));
    url.searchParams.set("srlimit", "3");
    url.searchParams.set("format", "json");
    url.searchParams.set("utf8", "1");

    const response = await safeFetch(url.toString());
    const body = JSON.parse(response.text) as {
      query?: {
        search?: Array<{ title?: string; snippet?: string }>;
      };
    };

    return (body.query?.search ?? []).flatMap((hit) => {
      const title = hit.title?.trim();
      if (!title) {
        return [];
      }

      return [{
        title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        snippet: htmlToText(hit.snippet ?? "")
      }];
    });
  }
};

export async function fetchWikipediaExcerpt(title: string): Promise<string> {
  const url = new URL(API_URL);
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("exchars", "800");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", title);
  url.searchParams.set("format", "json");
  url.searchParams.set("utf8", "1");

  const response = await safeFetch(url.toString());
  const body = JSON.parse(response.text) as {
    query?: {
      pages?: Record<string, { extract?: string; missing?: string }>;
    };
  };
  const page = Object.values(body.query?.pages ?? {}).find((candidate) => candidate.extract && !candidate.missing);
  const extract = page?.extract?.replace(/\s+/g, " ").trim() ?? "";

  if (!extract) {
    throw new Error(`Wikipedia returned no extract for ${title}`);
  }

  return extract;
}
