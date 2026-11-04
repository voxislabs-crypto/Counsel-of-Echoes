const SEARCH_TEXT_LIMIT = 300;

// Question-only text stays a plain prefix. When a claim is present, both
// pieces stay inside the search limit so the claim is not sliced away.
export function buildSourceQuery(question: string, claim?: string, limit = SEARCH_TEXT_LIMIT): string {
  const asked = question.trim();
  const extra = claim?.trim() ?? "";
  if (!extra || extra.toLowerCase() === asked.toLowerCase()) {
    return asked.slice(0, limit);
  }

  const claimText = extra.slice(0, Math.floor(limit / 2));
  const questionText = asked.slice(0, Math.max(limit - claimText.length - 1, 0));
  return [questionText, claimText].filter(Boolean).join(" ").slice(0, limit);
}

export function seatClaimText(statements: string[]): string | undefined {
  const parts: string[] = [];
  for (const statement of statements) {
    const text = statement.trim();
    if (!text) continue;
    if (parts.some((part) => part.toLowerCase() === text.toLowerCase())) continue;
    parts.push(text);
  }
  return parts.join(" ") || undefined;
}
