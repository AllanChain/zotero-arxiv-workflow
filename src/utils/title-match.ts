/**
 * Pure helpers for fuzzy title matching against bibliographic databases
 * (DBLP, PubMed). Keep this module free of Zotero/plugin dependencies so the
 * matching logic can be unit-tested in isolation.
 */

export const FUZZY_TITLE_THRESHOLD = 0.8;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

export function normalizeTitle(title: string): string {
  if (!title) return "";
  return (
    title
      .trim()
      // DBLP/PubMed sometimes append a trailing period
      .replace(/\.$/, "")
      .replace(/&amp;|&quot;|&apos;|&#39;|&lt;|&gt;/g, (m) => HTML_ENTITIES[m])
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

export function titleTokens(title: string): string[] {
  const normalized = normalizeTitle(title);
  return normalized === "" ? [] : normalized.split(" ");
}

/**
 * Sørensen–Dice coefficient over the normalized token sets.
 * 1 means identical token sets, 0 means disjoint sets.
 */
export function diceSimilarity(base: string, candidate: string): number {
  const tokensA = new Set(titleTokens(base));
  const tokensB = new Set(titleTokens(candidate));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  return (2 * intersection) / (tokensA.size + tokensB.size);
}

/**
 * Extract the last name from author strings in either common format:
 * "Michael I. Jordan", "Jordan, Michael I." (DBLP) or "Jordan MI" (PubMed).
 *
 * Trailing tokens that are not part of the family name are dropped:
 * - 1-2 character tokens are initials ("Jordan M Jr" -> "Jordan");
 * - all-digit tokens are DBLP's author-disambiguation suffix, appended when
 *   several authors share the same name ("Nikhil Vyas 0001" -> "Vyas").
 */
export function extractLastName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const commaIndex = name.indexOf(",");
  if (commaIndex !== -1) {
    return extractLastName(name.slice(0, commaIndex));
  }
  const cleaned = name
    .replace(/[^\p{L}\p{N}-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!cleaned) return undefined;
  const parts = cleaned.split(" ");
  // "0001" in "Nikhil Vyas 0001" is a DBLP author ID, not the family name.
  // Digits are kept by the normalizer above, so drop trailing digit tokens
  // explicitly, just like trailing initials.
  while (
    parts.length > 1 &&
    (parts[parts.length - 1].length <= 2 ||
      /^\d+$/.test(parts[parts.length - 1]))
  ) {
    parts.pop();
  }
  return parts[parts.length - 1];
}

export function firstAuthorMatches(
  arxivLastName: string | undefined,
  candidateAuthorName: string | undefined,
): boolean {
  const preprintLastName = extractLastName(arxivLastName);
  const candidateLastName = extractLastName(candidateAuthorName);
  return Boolean(
    preprintLastName &&
    candidateLastName &&
    preprintLastName === candidateLastName,
  );
}

export function extractYear(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const match = String(value).match(/\d{4}/);
  if (!match) return undefined;
  const year = parseInt(match[0], 10);
  return Number.isFinite(year) ? year : undefined;
}

/**
 * Strict year gate: both years must be known and the published version must
 * not predate the preprint.
 */
export function yearGatePasses(
  arxivYear: string | number | undefined,
  candidateYear: string | number | undefined,
): boolean {
  const preprintYear = extractYear(arxivYear);
  const publishedYear = extractYear(candidateYear);
  if (preprintYear === undefined || publishedYear === undefined) return false;
  return publishedYear >= preprintYear;
}

export type TitleMatchKind = "exact" | "fuzzy" | "reject";

export function evaluateTitlePair(
  base: string,
  candidate: string,
): { kind: TitleMatchKind; score: number } {
  const baseNorm = normalizeTitle(base);
  const candidateNorm = normalizeTitle(candidate);
  if (!baseNorm || !candidateNorm) return { kind: "reject", score: 0 };
  if (baseNorm === candidateNorm) return { kind: "exact", score: 1 };
  const score = diceSimilarity(baseNorm, candidateNorm);
  return score >= FUZZY_TITLE_THRESHOLD
    ? { kind: "fuzzy", score }
    : { kind: "reject", score };
}
