import { getPref } from "../../utils/prefs";
import {
  evaluateTitlePair,
  extractYear,
  firstAuthorSurnameMatches,
  yearGatePasses,
} from "../../utils/title-match";
import { fetchJSONBounded, fetchTextBounded } from "../../utils/http";
import {
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

/** Shared fuzzy gates for DBLP and PubMed: author must match, and the
 * published year cannot predate the preprint. Returns a reject reason to log,
 * or undefined when the candidate passes and may be considered. */
function fuzzyGateReason(
  preprintItem: Zotero.Item,
  candidateFirstAuthor: string | undefined,
  candidateYear: string | undefined,
): string | undefined {
  const preprintFirstAuthor = preprintItem.getCreators()[0]?.lastName;
  if (!firstAuthorSurnameMatches(preprintFirstAuthor, candidateFirstAuthor)) {
    return "author mismatch";
  }
  if (!yearGatePasses(preprintItem.getField("year"), candidateYear)) {
    return "year gate";
  }
  return undefined;
}

// Keep the strongest fuzzy candidate: higher similarity wins, then a DOI,
// then the most recent year. All ranking metadata lives on the candidate
// itself (`candidate.score`, `candidate.year`, `doi`), so we rank the tagged
// `TentativePaperIdentifier` directly with no wrapper.
function isBetterCandidate(
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
  private log: (...args: unknown[]) => void;

  constructor(
    preprintItem: Zotero.Item,
    log: (...args: unknown[]) => void = ztoolkit.log,
  ) {
    this.item = preprintItem;
    this.preprintURL = preprintItem.getField("url");
    this.title = preprintItem.getDisplayTitle();
    this.log = log;
    const urlHost = new URL(this.preprintURL).hostname;
    if (!Object.values(KNOWN_PREPRINT_SERVERS).includes(urlHost)) {
      throw `${this.preprintURL} is not a valid preprint server URL`;
    }
  }

  async find(): Promise<PaperIdentifier | undefined> {
    // Published-version finders, in priority order: a definitive result wins,
    // otherwise the first fuzzy match is held for user confirmation.
    const publishedFinders: {
      name: string;
      enabled: boolean;
      run: () => Promise<PaperIdentifier | undefined>;
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
    // Collect fuzzy candidates from every enabled finder and keep only the best
    // one across sources, so e.g. a strong PubMed result wins over a weak DBLP
    // one regardless of finder order. A definitive result still short-circuits.
    let best: TentativePaperIdentifier | undefined;
    for (const finder of publishedFinders) {
      if (!finder.enabled) continue;
      const result = await finder
        .run()
        .catch((e) => this.log(finder.name, "failed:", String(e)));
      if (!result) continue;
      if (isTentativePaperIdentifier(result)) {
        if (isBetterCandidate(best, result)) best = result;
        continue;
      }
      return result;
    }
    if (best) {
      this.log(
        `Tentative match "${best.candidate.candidateTitle}" (score=${best.candidate.score})`,
      );
      return best;
    }
    // Last resort: self-update the arXiv abstract's own published version.
    // The arXiv self-update is strictly worse than a published-version
    // candidate, so it only runs when there is no tentative match at all.
    return getPref("updateSource.arXiv") ? this.arXivPDF() : undefined;
  }

  async relatedDOI(): Promise<PaperIdentifier | undefined> {
    const urlHost = new URL(this.preprintURL).hostname;
    if (urlHost === KNOWN_PREPRINT_SERVERS.arxiv) {
      const htmlContent = await fetchTextBounded(this.preprintURL);
      const doiMatch = htmlContent.match(/data-doi="(?<doi>.*?)"/);
      const doi = doiMatch?.groups?.doi;
      return doi ? { doi, title: "Published PDF" } : undefined;
    } else if (
      urlHost === KNOWN_PREPRINT_SERVERS.biorxiv ||
      urlHost === KNOWN_PREPRINT_SERVERS.medrxiv
    ) {
      const arxivID = this.preprintURL.match(/\/(?<arxivID>[\d./]+)v\d+$/)
        ?.groups?.arxivID;
      if (!arxivID) return undefined;
      const apiURL =
        urlHost === KNOWN_PREPRINT_SERVERS.biorxiv
          ? `https://api.biorxiv.org/details/biorxiv/${arxivID}`
          : `https://api.medrxiv.org/details/medrxiv/${arxivID}`;
      const json = await fetchJSONBounded(apiURL);
      const doi = json.collection?.[0]?.published as string | undefined;
      return doi ? { doi, title: "Published PDF" } : undefined;
    } else if (urlHost == KNOWN_PREPRINT_SERVERS.chemrxiv) {
      const arxivID = this.preprintURL.match(/\/(?<arxivID>[\da-f]+)$/)?.groups
        ?.arxivID;
      if (!arxivID) return undefined;
      const apiURL = `https://chemrxiv.org/engage/chemrxiv/public-api/v1/items/${arxivID}`;
      const json = await fetchJSONBounded(apiURL);
      const doi = json.vor?.vorDoi as string | undefined;
      return doi ? { doi, title: "Published PDF" } : undefined;
    } else {
      return undefined;
    }
  }

  async semanticScholar(): Promise<PaperIdentifier | undefined> {
    // Currently, only searching arXiv paper on semanticScholar is supported
    const urlHost = new URL(this.preprintURL).hostname;
    if (urlHost !== KNOWN_PREPRINT_SERVERS.arxiv) return undefined;
    const idMatch = this.preprintURL.match(/\/(?<arxiv>[^/]+)$/);
    if (idMatch?.groups?.arxiv === undefined) {
      return undefined;
    }
    const arXivID = idMatch.groups.arxiv;
    const semanticAPI = "https://api.semanticscholar.org/graph/v1/paper";
    const semanticURL = `${semanticAPI}/ARXIV:${arXivID}?fields=externalIds`;
    const semanticJSON = await fetchJSONBounded(semanticURL);
    const doi = semanticJSON.externalIds?.DOI as string | undefined;
    // Retrun undefined if the DOI is an arXiv DOI
    return !doi || doi.toLowerCase()?.includes("arxiv")
      ? undefined
      : { doi, title: "Published PDF" };
  }

  async dblp(): Promise<PaperIdentifier | undefined> {
    // Well, CS guys won't use preprint servers other than arXiv
    const urlHost = new URL(this.preprintURL).hostname;
    if (urlHost !== KNOWN_PREPRINT_SERVERS.arxiv) return undefined;
    const dblpAPI = "https://dblp.org/search/publ/api";
    // DBLP sends at most 100 hits per query, ordered by year descending.
    // A title-only query for a popular paper can match hundreds of records
    // and even homonymous titles by other authors, so narrow the search with
    // the first author whenever the item has one.
    const firstAuthor = this.item.getCreators()[0]?.lastName;
    const query = firstAuthor ? `${this.title} ${firstAuthor}` : this.title;
    this.log(`DBLP query: ${query}`);
    const dblpURL = `${dblpAPI}?q=${encodeURIComponent(query)}&format=json&h=100`;
    const json = await fetchJSONBounded<{
      result?: { hits?: { hit?: Array<{ info?: DBLPHitInfo }> } };
    }>(dblpURL);
    const hits = json.result?.hits?.hit ?? [];
    this.log(`DBLP returned ${hits.length} hits`);
    let bestCandidate: TentativePaperIdentifier | undefined;
    for (const hit of hits) {
      const info = hit?.info;
      if (!info) continue;
      const title = info.title;
      if (typeof title !== "string") continue;
      const match = evaluateTitlePair(this.title, title);
      if (match.kind === "reject") continue;
      // Ignore this DBLP entry if it belongs to CoRR. See also #14
      if (info.venue === "CoRR") {
        this.log(`DBLP: skipping CoRR record ${info.key}`);
        continue;
      }
      const hasDOI =
        Boolean(info.doi) && !String(info.doi).toLowerCase().includes("arxiv");
      if (match.kind === "exact") {
        // Exact matches keep the previous behavior: accept immediately.
        // Prefer the DOI when DBLP has one: importing by identifier is more
        // robust than scraping an arbitrary publisher page.
        if (hasDOI) {
          this.log(`DBLP matched ${info.key} via DOI ${info.doi}`);
          return { doi: info.doi, title: "Published PDF" };
        }
        // Prefer electron edition (ee) which points to the official website
        // instead of DBLP
        let url = info.ee || info.url;
        if (!url) continue;
        // Records without a real venue page (e.g. early ICLR) point back to
        // arXiv itself; updating from them would re-import the preprint.
        const host = safeHost(url);
        if (!host) continue; // malformed URL: skip this record
        if (host === "arxiv.org" || host.endsWith(".arxiv.org")) {
          this.log(`DBLP: skipping arXiv-hosted record ${info.key}`);
          continue;
        }
        // openreview.net serves a script-only page behind an anti-bot
        // challenge, impossible to import headlessly; import from the BibTeX
        // view of the DBLP record itself instead.
        if (host === "openreview.net" || host.endsWith(".openreview.net")) {
          url = `https://dblp.org/rec/${info.key}.html?view=bibtex`;
        }
        this.log(
          `DBLP matched ${info.key} (${info.venue} ${info.year}): ${url}`,
        );
        return { url, title: "Published PDF" };
      }
      // Fuzzy matches must additionally match the first author and satisfy
      // the year gate (the published version cannot predate the preprint).
      const dblpAuthors = info.authors?.author;
      const firstAuthorName = Array.isArray(dblpAuthors)
        ? dblpAuthors[0]?.text
        : dblpAuthors?.text;
      const gateReason = fuzzyGateReason(this.item, firstAuthorName, info.year);
      if (gateReason) {
        this.log(`DBLP: fuzzy candidate ${info.key} rejected (${gateReason})`);
        continue;
      }
      let url = info.ee || info.url;
      if (!hasDOI && !url) continue;
      if (url) {
        const host = safeHost(url);
        if (!host) continue; // malformed URL: skip this record
        if (host === "arxiv.org" || host.endsWith(".arxiv.org")) {
          this.log(`DBLP: skipping arXiv-hosted record ${info.key}`);
          continue;
        }
        if (host === "openreview.net" || host.endsWith(".openreview.net")) {
          url = `https://dblp.org/rec/${info.key}.html?view=bibtex`;
        }
      }
      const candidate: TentativePaperIdentifier = {
        ...(hasDOI ? { doi: info.doi } : { url: url as string }),
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
          // This is independent of `url` above, which may have been
          // rewritten to the DBLP BibTeX view for OpenReview imports.
          url:
            info.ee ||
            info.url ||
            (hasDOI ? `https://doi.org/${info.doi}` : undefined),
        },
      };
      if (isBetterCandidate(bestCandidate, candidate)) {
        bestCandidate = candidate;
      }
    }
    if (bestCandidate) {
      this.log(
        `DBLP: tentative match "${bestCandidate.candidate.candidateTitle}" (score=${bestCandidate.candidate.score})`,
      );
      return bestCandidate;
    }
    this.log(`No published version found on DBLP for "${this.title}"`);
    return undefined;
  }

  async pubMed(): Promise<PaperIdentifier | undefined> {
    const pubMedSearchAPI =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed";
    const pubMedSearchURL = `${pubMedSearchAPI}&term=${encodeURIComponent(this.title)}&retmode=json`;
    const searchJson = await fetchJSONBounded<{
      esearchresult?: { idlist?: string[] };
    }>(pubMedSearchURL);
    const idList = searchJson.esearchresult?.idlist ?? [];
    if (idList.length === 0) return undefined;
    // Relevance ranking is not perfect, so check several candidates instead
    // of only the first hit.
    const paperIds = idList.slice(0, PUBMED_CANDIDATE_LIMIT);
    const pubMedPaperAPI =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed";
    const pubMedPaperURL = `${pubMedPaperAPI}&id=${paperIds.join(",")}&retmode=json`;
    const paperJson = await fetchJSONBounded<{
      result?: Record<string, PubMedPaper>;
    }>(pubMedPaperURL);
    let bestCandidate: TentativePaperIdentifier | undefined;
    for (const paperId of paperIds) {
      const info = paperJson.result?.[paperId];
      if (!info) continue;
      const title = info?.title;
      if (typeof title !== "string") continue;
      const match = evaluateTitlePair(this.title, title);
      if (match.kind === "reject") continue;
      const doi = pubmedDOI(info);
      if (match.kind === "exact") {
        if (doi) {
          this.log(`PubMed matched ${paperId} via DOI ${doi}`);
          return { doi, title: "Published PDF" };
        }
        continue; // Exact match without a DOI is not importable
      }
      const firstAuthorName = info.authors?.[0]?.name;
      const gateReason = fuzzyGateReason(
        this.item,
        firstAuthorName,
        info.pubdate,
      );
      if (gateReason) {
        this.log(`PubMed: fuzzy candidate ${paperId} rejected (${gateReason})`);
        continue;
      }
      if (!doi) continue;
      const candidate: TentativePaperIdentifier = {
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
      if (isBetterCandidate(bestCandidate, candidate)) {
        bestCandidate = candidate;
      }
    }
    if (bestCandidate) {
      this.log(
        `PubMed: tentative match "${bestCandidate.candidate.candidateTitle}" (score=${bestCandidate.candidate.score})`,
      );
      return bestCandidate;
    }
    this.log(`No published version found on PubMed for "${this.title}"`);
    return undefined;
  }

  async arXivPDF(): Promise<PaperIdentifier | undefined> {
    const urlHost = new URL(this.preprintURL).hostname;
    if (urlHost !== KNOWN_PREPRINT_SERVERS.arxiv) return undefined;
    // Having a local PDF does not mean we can extract version from it.
    // We skip updating if we fail to extract version, but we will try to
    // download a version if there is no local PDF.
    let hasPDF = false;
    let localVersion = 0;
    for (const attachmentID of this.item.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (!attachment || !attachment.isPDFAttachment()) continue;
      hasPDF = true;
      const fullText = await Zotero.PDFWorker.getFullText(attachmentID, 1);
      const match = fullText.text.match(/arXiv:[\d.]+v(\d+)/);
      if (!match) continue;
      const currentPDFVersion = parseInt(match[1], 10);
      if (currentPDFVersion > localVersion) {
        localVersion = currentPDFVersion;
      }
    }
    this.log(`Current arXiv version: ${localVersion}`);
    if (hasPDF && localVersion === 0) return undefined;
    const htmlContent = await fetchTextBounded(this.item.getField("url"));
    const match = htmlContent.match(/<strong>\[v(\d+)\]<\/strong>/);
    if (!match) return undefined;
    const onlineVersion = parseInt(match[1], 10);
    if (hasPDF && onlineVersion <= localVersion) return undefined;
    return { url: this.preprintURL, title: `v${onlineVersion} PDF` };
  }
}
