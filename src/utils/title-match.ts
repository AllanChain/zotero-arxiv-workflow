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

function titleTokens(title: string): string[] {
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

/** Normalize an author string into lowercase word tokens, dropping numbers. */
function authorTokens(name: string | undefined): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .replace(/\d+/g, " ") // DBLP author disambiguation suffix, e.g. "0001"
    .replace(/[^\p{L}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * Match the arXiv first author's surname against the candidate's first author.
 *
 * The first author is whatever comes before the first comma in the author list
 * (DBLP lists authors comma-separated; PubMed is harmless to split the same way).
 * We then just check that the arXiv surname appears as one of those words, which
 * covers both formats, short surnames, middle names, orderings, and suffix tokens.
 */
export function firstAuthorSurnameMatches(
  arxivSurname: string | undefined,
  candidateAuthorList: string | undefined,
): boolean {
  const arxiv = authorTokens(arxivSurname);
  if (arxiv.length === 0) return false;
  const surname = arxiv[arxiv.length - 1]; // last token (handles compound names)
  if (!candidateAuthorList) return false;
  const commaIndex = candidateAuthorList.indexOf(",");
  const firstAuthor =
    commaIndex === -1
      ? candidateAuthorList
      : candidateAuthorList.slice(0, commaIndex);
  return authorTokens(firstAuthor).includes(surname);
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
 * Year gate: the published version must not predate the preprint. When the
 * preprint year is unknown (user-created preprints often have no date field),
 * the timeline cannot be disproven, so the gate passes as long as the
 * candidate year is known.
 */
export function yearGatePasses(
  arxivYear: string | number | undefined,
  candidateYear: string | number | undefined,
): boolean {
  const preprintYear = extractYear(arxivYear);
  const publishedYear = extractYear(candidateYear);
  if (publishedYear === undefined) return false;
  if (preprintYear === undefined) return true;
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
