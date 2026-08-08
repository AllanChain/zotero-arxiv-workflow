import { getPref } from "../../utils/prefs";

// Network seam for PaperFinder. The production implementation (see
// arxiv-update.ts) routes through Zotero's HTTP + per-host queues; tests
// inject stubs so the finder decision logic runs without real requests.
export interface Fetcher {
  fetchText(url: string): Promise<string>;
  fetchJSON<T = any>(url: string): Promise<T>;
}

export interface PaperIdentifier {
  doi?: string;
  url?: string;
  title: string;
}

const KNOWN_PREPRINT_SERVERS = {
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

export function matchTitle(base: string, target: any): boolean {
  if (typeof target !== "string") return false;
  return base.toLowerCase().trim() === target.toLowerCase().trim();
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

  async find(): Promise<PaperIdentifier | undefined> {
    const finders = [
      getPref("updateSource.doi") && this.relatedDOI.bind(this),
      getPref("updateSource.semanticScholar") &&
        this.semanticScholar.bind(this),
      getPref("updateSource.dblp") && this.dblp.bind(this),
      getPref("updateSource.pubmed") && this.pubMed.bind(this),
      getPref("updateSource.arXiv") && this.arXivPDF.bind(this),
    ];
    for (const finder of finders) {
      if (!finder) continue;
      const result = await finder().catch((e) =>
        ztoolkit.log(finder.name, "failed:", String(e)),
      );
      if (result) return result;
    }
  }

  async relatedDOI(): Promise<PaperIdentifier | undefined> {
    const urlHost = new URL(this.preprintURL).hostname;
    if (urlHost === KNOWN_PREPRINT_SERVERS.arxiv) {
      const htmlContent = await this.fetch.fetchText(this.preprintURL);
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
      const json = await this.fetch.fetchJSON(apiURL);
      const doi = json.collection?.[0]?.published as string | undefined;
      return doi ? { doi, title: "Published PDF" } : undefined;
    } else if (urlHost == KNOWN_PREPRINT_SERVERS.chemrxiv) {
      const arxivID = this.preprintURL.match(/\/(?<arxivID>[\da-f]+)$/)?.groups
        ?.arxivID;
      if (!arxivID) return undefined;
      const apiURL = `https://chemrxiv.org/engage/chemrxiv/public-api/v1/items/${arxivID}`;
      const json = await this.fetch.fetchJSON(apiURL);
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
    const semanticJSON = await this.fetch.fetchJSON(semanticURL);
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
    ztoolkit.log(`DBLP query: ${query}`);
    const dblpURL = `${dblpAPI}?q=${encodeURIComponent(query)}&format=json&h=100`;
    const json = await this.fetch.fetchJSON(dblpURL);
    const hits = json?.result?.hits?.hit ?? [];
    ztoolkit.log(`DBLP returned ${hits.length} hits`);
    for (const hit of hits) {
      const info = hit?.info;
      // Remove final `.` in title (idk why dblp has this)
      const title = info?.title?.replace(/\.$/, "");
      if (!matchTitle(this.title, title)) continue;
      // Ignore this DBLP entry if it belongs to CoRR. See also #14
      if (info.venue === "CoRR") {
        ztoolkit.log(`DBLP: skipping CoRR record ${info.key}`);
        continue;
      }
      // Prefer the DOI when DBLP has one: importing by identifier is more
      // robust than scraping an arbitrary publisher page.
      if (info.doi && !String(info.doi).toLowerCase().includes("arxiv")) {
        ztoolkit.log(`DBLP matched ${info.key} via DOI ${info.doi}`);
        return { doi: info.doi, title: "Published PDF" };
      }
      // Prefer electron edition (ee) which points to the official website instead of DBLP
      let url = info.ee || info.url;
      if (!url) continue;
      // Records without a real venue page (e.g. early ICLR) point back to
      // arXiv itself; updating from them would re-import the preprint.
      const host = new URL(url).hostname;
      if (host === "arxiv.org" || host.endsWith(".arxiv.org")) {
        ztoolkit.log(`DBLP: skipping arXiv-hosted record ${info.key}`);
        continue;
      }
      // openreview.net serves a script-only page behind an anti-bot
      // challenge, impossible to import headlessly; import from the BibTeX
      // view of the DBLP record itself instead.
      if (host === "openreview.net" || host.endsWith(".openreview.net")) {
        url = `https://dblp.org/rec/${info.key}.html?view=bibtex`;
      }
      ztoolkit.log(
        `DBLP matched ${info.key} (${info.venue} ${info.year}): ${url}`,
      );
      return { url, title: "Published PDF" };
    }
    ztoolkit.log(`No published version found on DBLP for "${this.title}"`);
    return undefined;
  }

  async pubMed(): Promise<PaperIdentifier | undefined> {
    const pubMedSearchAPI =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed";
    const pubMedSearchURL = `${pubMedSearchAPI}&term=${encodeURIComponent(this.title)}&retmode=json`;
    const searchJson = await this.fetch.fetchJSON(pubMedSearchURL);
    const paperId = searchJson?.esearchresult?.idlist?.[0];
    if (!paperId) return undefined;
    const pubMedPaperAPI =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed";
    const pubMedPaperURL = `${pubMedPaperAPI}&id=${paperId}&retmode=json`;
    const paperJson = await this.fetch.fetchJSON(pubMedPaperURL);
    // Remove final `.` in title (idk why PubMed has this)
    const info = paperJson?.result?.[paperId];
    const title = info?.title?.replace(/\.$/, "");
    if (!matchTitle(this.title, title)) {
      ztoolkit.log(
        title
          ? `PubMed title mismatch: expected "${this.title}", got "${title}"`
          : "Paper not found on PubMed",
      );
      return;
    }
    const idInfos = info?.articleids;
    if (!idInfos) return undefined;
    for (const idInfo of idInfos) {
      if (idInfo.idtype === "doi") {
        return { doi: idInfo.value, title: "Published PDF" };
      }
    }
    return undefined;
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
