export type SearchLead = {
  title: string;
  url: string;
  snippet: string;
};

export interface SearchProvider {
  search(query: string): Promise<SearchLead[]>;
}
