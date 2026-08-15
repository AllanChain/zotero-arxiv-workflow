import { getPref } from "../../utils/prefs";
import type { Fetcher } from "./fetcher";
import {
  evaluateTitlePair,
  extractYear,
  firstAuthorSurnameMatches,
  yearGatePasses,
} from "../../utils/title-match";
import {
  FinderIterator,
  PaperIdentifier,
  TentativePaperIdentifier,
  isTentativePaperIdentifier,
} from "../../types";

export const KNOWN_PREPRINT_SERVERS = {
  arxiv: "arxiv.org",
  biorxiv: "www.biorxiv.org",
  medrxiv: "www.medrxiv.org",
  chemrxiv: "chemrxiv.org",
  psyarxiv: "osf.io",
};

export function isKnownPreprintURL(url: string): boolean {
  const urlHost = new URL(url).hostname;
  return Object.values(KNOWN_PREPRINT_SERVERS).includes(urlHost);
}

// Extract the arXiv version (e.g. 3 from "arXiv:1234.5678v3") embedded in a
// PDF's full text.
export function extractPDFVersion(fullText: string): number | undefined {
  const match = fullText.match(/arXiv:[\d.]+v(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

// Highest arXiv version across an item's PDF full texts. `hasPDF` is true iff
// at least one PDF attachment contributed text.
export function localarXivVersion(pdfFullTexts: string[]): {
  hasPDF: boolean;
  version: number;
} {
  let version = 0;
  for (const fullText of pdfFullTexts) {
    const v = extractPDFVersion(fullText);
    if (v !== undefined && v > version) version = v;
  }
  return { hasPDF: pdfFullTexts.length > 0, version };
}

// Extract the latest arXiv version shown on the abstract page
// (e.g. 2 from '<strong>[v2]</strong>').
export function extractOnlineVersion(html: string): number | undefined {
  const match = html.match(/<strong>\[v(\d+)\]<\/strong>/);
  return match ? parseInt(match[1], 10) : undefined;
}

// Number of esummary records to check per PubMed search: relevance ranking
// is not perfect, so a fuzzy match further down the list is still worth
// surfacing for confirmation.
const PUBMED_CANDIDATE_LIMIT = 10;

// Narrow typed views of the external API responses the finders actually read.
interface DBLPHitInfo {
  title?: string;
  venue?: string;
  year?: string;
  doi?: string;
  ee?: string;
  url?: string;
  key?: string;
  authors?: { author?: { text?: string } | Array<{ text?: string }> };
}

interface PubMedPaper {
  title?: string;
  pubdate?: string;
  fulljournalname?: string;
  authors?: Array<{ name?: string }>;
  articleids?: Array<{ idtype?: string; value?: string }>;
}

/**
 * Shared fuzzy gates for DBLP and PubMed: the candidate's first author must
 * match the preprint's, and the published year cannot predate the preprint.
 * Returns a reject reason to log, or undefined when the candidate passes and
 * may be considered. Pure: callers extract the preprint fields once.
 */
export function fuzzyGateReason(
  preprintFirstAuthor: string | undefined,
  preprintYear: string | number | undefined,
  candidateFirstAuthor: string | undefined,
  candidateYear: string | undefined,
): string | undefined {
  if (!firstAuthorSurnameMatches(preprintFirstAuthor, candidateFirstAuthor)) {
    return "author mismatch";
  }
  if (!yearGatePasses(preprintYear, candidateYear)) {
    return "year gate";
  }
  return undefined;
}

// Keep the strongest fuzzy candidate: higher similarity wins, then a DOI,
// then the most recent year. All ranking metadata lives on the candidate
// itself (`candidate.score`, `candidate.year`, `doi`).
export function isBetterCandidate(
  current: TentativePaperIdentifier | undefined,
  next: TentativePaperIdentifier,
): boolean {
  if (!current) return true;
  if (next.candidate.score !== current.candidate.score) {
    return next.candidate.score > current.candidate.score;
  }
  if (Boolean(next.doi) !== Boolean(current.doi)) return Boolean(next.doi);
  return (
    (extractYear(next.candidate.year) ?? -1) >
    (extractYear(current.candidate.year) ?? -1)
  );
}

/** Resolve a hostname, returning undefined for a malformed URL. */
function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function pubmedDOI(info: PubMedPaper): string | undefined {
  for (const idInfo of info.articleids ?? []) {
    if (idInfo.idtype === "doi") return idInfo.value;
  }
  return undefined;
}

export class PaperFinder {
  preprintURL: string;
  title: string;
  item: Zotero.Item;

  constructor(
    preprintItem: Zotero.Item,
    private fetch: Fetcher,
  ) {
    this.item = preprintItem;
    this.preprintURL = preprintItem.getField("url");
    this.title = preprintItem.getDisplayTitle();
    if (!isKnownPreprintURL(this.preprintURL)) {
      throw `${this.preprintURL} is not a valid preprint server URL`;
    }
  }

  async *find(): FinderIterator {
    // Every published-version finder yields its candidates in preference
    // order; find() makes the only decision. A definitive (exact) match is
    // "good enough": it wins immediately, and later sources are never
    // queried. Fuzzy matches are never good enough: the strongest one across
    // *all* sources is held for user confirmation, so e.g. a strong PubMed
    // result beats a weak DBLP one regardless of finder order.
    const publishedFinders: {
      name: string;
      enabled: boolean;
      run: () => Promise<PaperIdentifier[]>;
    }[] = [
      {
        name: "relatedDOI",
        enabled: getPref("updateSource.doi"),
        run: () => this.relatedDOI(),
      },
      {
        name: "semanticScholar",
        enabled: getPref("updateSource.semanticScholar"),
        run: () => this.semanticScholar(),
      },
      {
        name: "dblp",
        enabled: getPref("updateSource.dblp"),
        run: () => this.dblp(),
      },
      {
        name: "pubMed",
        enabled: getPref("updateSource.pubmed"),
        run: () => this.pubMed(),
      },
    ];
    // A failing finder must not abort the others. Absence is reported once
    // per source, but a failure is not an absence: a finder that threw only
    // logs the failure.
    let best: TentativePaperIdentifier | undefined;
    for (const finder of publishedFinders) {
      if (!finder.enabled) continue;
      let candidates: PaperIdentifier[];
      try {
        candidates = await finder.run();
      } catch (e) {
        ztoolkit.log(finder.name, "failed:", String(e));
        continue;
      }
      if (candidates.length === 0) {
        ztoolkit.log(
          `No published version found on ${finder.name} for "${this.title}"`,
        );
        continue;
      }
      for (const candidate of candidates) {
        if (isTentativePaperIdentifier(candidate)) {
          if (isBetterCandidate(best, candidate)) best = candidate;
        } else {
          return candidate;
        }
      }
    }
    if (best) {
      ztoolkit.log(
        `Tentative match "${best.candidate.candidateTitle}" (score=${best.candidate.score})`,
      );
      // Pause the whole finding pipeline until the user decides. Yielding
      // the candidate hands it to the caller for confirmation; resuming the
      // pipeline means the candidate was rejected, so the remaining stages
      // below run.
      yield best;
    }
    // The arXiv self-update is just another stage in the same pipeline. It
    // only runs after a tentative candidate has been rejected (or when there
    // was no candidate at all). A failure here is treated as absence.
    if (getPref("updateSource.arXiv")) {
      try {
        const arxivPDF = await this.arXivPDF();
        if (arxivPDF) return arxivPDF;
      } catch (e) {
        ztoolkit.log("arXivPDF failed:", String(e));
      }
    }
    return undefined;
  }

  async relatedDOI(): Promise<PaperIdentifier[]> {
    const urlHost = new URL(this.preprintURL).hostname;
    if (urlHost === KNOWN_PREPRINT_SERVERS.arxiv) {
      const htmlContent = await this.fetch.fetchText(this.preprintURL);
      const doiMatch = htmlContent.match(/data-doi="(?<doi>.*?)"/);
      const doi = doiMatch?.groups?.doi;
      return doi ? [{ doi, title: "Published PDF" }] : [];
    } else if (
      urlHost === KNOWN_PREPRINT_SERVERS.biorxiv ||
      urlHost === KNOWN_PREPRINT_SERVERS.medrxiv
    ) {
      const arxivID = this.preprintURL.match(/\/(?<arxivID>[\d./]+)v\d+$/)
        ?.groups?.arxivID;
      if (!arxivID) return [];
      const apiURL =
        urlHost === KNOWN_PREPRINT_SERVERS.biorxiv
          ? `https://api.biorxiv.org/details/biorxiv/${arxivID}`
          : `https://api.medrxiv.org/details/medrxiv/${arxivID}`;
      const json = await this.fetch.fetchJSON(apiURL);
      const doi = json.collection?.[0]?.published as string | undefined;
      return doi ? [{ doi, title: "Published PDF" }] : [];
    } else if (urlHost == KNOWN_PREPRINT_SERVERS.chemrxiv) {
      const arxivID = this.preprintURL.match(/\/(?<arxivID>[\da-f]+)$/)?.groups
        ?.arxivID;
      if (!arxivID) return [];
      const apiURL = `https://chemrxiv.org/engage/chemrxiv/public-api/v1/items/${arxivID}`;
      const json = await this.fetch.fetchJSON(apiURL);
      const doi = json.vor?.vorDoi as string | undefined;
      return doi ? [{ doi, title: "Published PDF" }] : [];
    } else {
      return [];
    }
  }

  async semanticScholar(): Promise<PaperIdentifier[]> {
    // Currently, only searching arXiv paper on semanticScholar is supported
    const urlHost = new URL(this.preprintURL).hostname;
    if (urlHost !== KNOWN_PREPRINT_SERVERS.arxiv) return [];
    const idMatch = this.preprintURL.match(/\/(?<arxiv>[^/]+)$/);
    if (idMatch?.groups?.arxiv === undefined) {
      return [];
    }
    const arXivID = idMatch.groups.arxiv;
    const semanticAPI = "https://api.semanticscholar.org/graph/v1/paper";
    const semanticURL = `${semanticAPI}/ARXIV:${arXivID}?fields=externalIds`;
    const semanticJSON = await this.fetch.fetchJSON(semanticURL);
    const doi = semanticJSON.externalIds?.DOI as string | undefined;
    // Return nothing if the DOI is an arXiv DOI
    return !doi || doi.toLowerCase()?.includes("arxiv")
      ? []
      : [{ doi, title: "Published PDF" }];
  }

  async dblp(): Promise<PaperIdentifier[]> {
    // Well, CS guys won't use preprint servers other than arXiv
    const urlHost = new URL(this.preprintURL).hostname;
    if (urlHost !== KNOWN_PREPRINT_SERVERS.arxiv) return [];
    const dblpAPI = "https://dblp.org/search/publ/api";
    // DBLP sends at most 100 hits per query, ordered by year descending.
    // A title-only query for a popular paper can match hundreds of records
    // and even homonymous titles by other authors, so narrow the search with
    // the first author whenever the item has one.
    const firstAuthor = this.item.getCreators()[0]?.lastName;
    const query = firstAuthor ? `${this.title} ${firstAuthor}` : this.title;
    ztoolkit.log(`DBLP query: ${query}`);
    const dblpURL = `${dblpAPI}?q=${encodeURIComponent(query)}&format=json&h=100`;
    const json = await this.fetch.fetchJSON<{
      result?: { hits?: { hit?: Array<{ info?: DBLPHitInfo }> } };
    }>(dblpURL);
    const hits = json?.result?.hits?.hit ?? [];
    ztoolkit.log(`DBLP returned ${hits.length} hits`);
    return hits
      .map((hit) => this.toDBLPCandidate(hit?.info))
      .filter((c): c is PaperIdentifier => c !== undefined);
  }

  /**
   * The importable published identifier of a DBLP record: its DOI when it
   * has a real one, otherwise its best page URL. Records whose page only
   * points back at arXiv are skipped, and OpenReview pages are rewritten to
   * the DBLP BibTeX view, which is importable where the script-only page is
   * not. Shared by the exact and fuzzy paths; undefined when the record has
   * nothing importable.
   */
  private resolveDBLPImport(
    info: DBLPHitInfo,
  ): { doi: string } | { url: string } | undefined {
    const { doi } = info;
    if (doi && !String(doi).toLowerCase().includes("arxiv")) {
      return { doi };
    }
    let url = info.ee || info.url;
    if (!url) return undefined;
    const host = safeHost(url);
    if (!host) return undefined; // malformed URL: skip this record
    if (host === "arxiv.org" || host.endsWith(".arxiv.org")) {
      ztoolkit.log(`DBLP: skipping arXiv-hosted record ${info.key}`);
      return undefined;
    }
    // openreview.net serves a script-only page behind an anti-bot
    // challenge, impossible to import headlessly; import from the BibTeX
    // view of the DBLP record itself instead.
    if (host === "openreview.net" || host.endsWith(".openreview.net")) {
      url = `https://dblp.org/rec/${info.key}.html?view=bibtex`;
    }
    return { url };
  }

  /** One candidate per DBLP hit: definitive on an exact title, tentative on a fuzzy one. */
  private toDBLPCandidate(
    info: DBLPHitInfo | undefined,
  ): PaperIdentifier | undefined {
    if (!info) return undefined;
    const title = info.title;
    if (typeof title !== "string") return undefined;
    const match = evaluateTitlePair(this.title, title);
    if (match.kind === "reject") return undefined;
    // Ignore this DBLP entry if it belongs to CoRR. See also #14
    if (info.venue === "CoRR") {
      ztoolkit.log(`DBLP: skipping CoRR record ${info.key}`);
      return undefined;
    }
    const importId = this.resolveDBLPImport(info);
    if (!importId) return undefined;
    if (match.kind === "exact") {
      // Exact matches keep the previous behavior: accept immediately.
      // Prefer the DOI when DBLP has one: importing by identifier is more
      // robust than scraping an arbitrary publisher page.
      if ("doi" in importId) {
        ztoolkit.log(`DBLP matched ${info.key} via DOI ${importId.doi}`);
      } else {
        ztoolkit.log(
          `DBLP matched ${info.key} (${info.venue} ${info.year}): ${importId.url}`,
        );
      }
      return { ...importId, title: "Published PDF" };
    }
    // Fuzzy matches must additionally match the first author and satisfy
    // the year gate (the published version cannot predate the preprint).
    const dblpAuthors = info.authors?.author;
    const firstAuthorName = Array.isArray(dblpAuthors)
      ? dblpAuthors[0]?.text
      : dblpAuthors?.text;
    const gateReason = fuzzyGateReason(
      this.item.getCreators()[0]?.lastName,
      this.item.getField("year"),
      firstAuthorName,
      info.year,
    );
    if (gateReason) {
      ztoolkit.log(
        `DBLP: fuzzy candidate ${info.key} rejected (${gateReason})`,
      );
      return undefined;
    }
    return {
      ...importId,
      title: "Published PDF",
      tentative: true,
      candidate: {
        source: "DBLP",
        candidateTitle: title,
        publication: info.venue,
        year: info.year,
        score: match.score,
        // Human-review link: the publisher page or the DBLP record page,
        // falling back to the DOI resolver when the record has no page.
        // This is independent of the import URL above, which may have been
        // rewritten to the DBLP BibTeX view for OpenReview imports.
        url:
          info.ee ||
          info.url ||
          ("doi" in importId ? `https://doi.org/${importId.doi}` : undefined),
      },
    };
  }

  async pubMed(): Promise<PaperIdentifier[]> {
    const pubMedSearchAPI =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed";
    const pubMedSearchURL = `${pubMedSearchAPI}&term=${encodeURIComponent(this.title)}&retmode=json`;
    const searchJson = await this.fetch.fetchJSON<{
      esearchresult?: { idlist?: string[] };
    }>(pubMedSearchURL);
    const idList = searchJson?.esearchresult?.idlist ?? [];
    if (idList.length === 0) return [];
    // Relevance ranking is not perfect, so check several candidates instead
    // of only the first hit.
    const paperIds = idList.slice(0, PUBMED_CANDIDATE_LIMIT);
    const pubMedPaperAPI =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed";
    const pubMedPaperURL = `${pubMedPaperAPI}&id=${paperIds.join(",")}&retmode=json`;
    const paperJson = await this.fetch.fetchJSON<{
      result?: Record<string, PubMedPaper>;
    }>(pubMedPaperURL);
    return paperIds
      .map((paperId) =>
        this.toPubMedCandidate(paperJson?.result?.[paperId], paperId),
      )
      .filter((c): c is PaperIdentifier => c !== undefined);
  }

  /** One candidate per PubMed record: definitive on an exact title, tentative on a fuzzy one. */
  private toPubMedCandidate(
    info: PubMedPaper | undefined,
    paperId: string,
  ): PaperIdentifier | undefined {
    if (!info) return undefined;
    const title = info.title;
    if (typeof title !== "string") return undefined;
    const match = evaluateTitlePair(this.title, title);
    if (match.kind === "reject") return undefined;
    const doi = pubmedDOI(info);
    if (match.kind === "exact") {
      if (doi) {
        ztoolkit.log(`PubMed matched ${paperId} via DOI ${doi}`);
        return { doi, title: "Published PDF" };
      }
      // Exact match without a DOI is not importable; keep looking.
      return undefined;
    }
    const gateReason = fuzzyGateReason(
      this.item.getCreators()[0]?.lastName,
      this.item.getField("year"),
      info.authors?.[0]?.name,
      info.pubdate,
    );
    if (gateReason) {
      ztoolkit.log(
        `PubMed: fuzzy candidate ${paperId} rejected (${gateReason})`,
      );
      return undefined;
    }
    if (!doi) return undefined;
    return {
      doi,
      title: "Published PDF",
      tentative: true,
      candidate: {
        source: "PubMed",
        candidateTitle: title,
        publication: info.fulljournalname,
        year: info.pubdate,
        score: match.score,
        // PubMed's abstract page is free to view and lets the user verify
        // the title, authors, and journal before confirming the match.
        url: `https://pubmed.ncbi.nlm.nih.gov/${paperId}/`,
      },
    };
  }

  async arXivPDF(): Promise<PaperIdentifier | undefined> {
    const urlHost = new URL(this.preprintURL).hostname;
    if (urlHost !== KNOWN_PREPRINT_SERVERS.arxiv) return undefined;
    // Having a local PDF does not mean we can extract version from it.
    // We skip updating if we fail to extract version, but we will try to
    // download a version if there is no local PDF.
    const pdfTexts: string[] = [];
    for (const attachmentID of this.item.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (!attachment || !attachment.isPDFAttachment()) continue;
      const fullText = await Zotero.PDFWorker.getFullText(attachmentID, 1);
      pdfTexts.push(fullText.text);
    }
    const { hasPDF, version: localVersion } = localarXivVersion(pdfTexts);
    ztoolkit.log(`Current arXiv version: ${localVersion}`);
    if (hasPDF && localVersion === 0) return undefined;
    const htmlContent = await this.fetch.fetchText(this.item.getField("url"));
    const onlineVersion = extractOnlineVersion(htmlContent);
    if (onlineVersion === undefined) return undefined;
    if (hasPDF && onlineVersion <= localVersion) return undefined;
    return { url: this.preprintURL, title: `v${onlineVersion} PDF` };
  }
}
