import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { arXivMerge } from "./arxiv-merge";
import { catchError } from "./error";
import { UpdateStatus, UpdateTableData } from "../types";

const KNOWN_PREPRINT_SERVERS = {
  arxiv: "arxiv.org",
  biorxiv: "www.biorxiv.org",
  medrxiv: "www.medrxiv.org",
  chemrxiv: "chemrxiv.org",
  psyarxiv: "osf.io",
};

interface PaperIdentifier {
  doi?: string;
  url?: string;
  title: string;
}

type SimpleUpdateStatus = "pending" | "processing" | "done" | "error";
type ReportProgress = (status: UpdateStatus, msg?: string) => void;

function simplifyUpdateStatus(status: UpdateStatus): SimpleUpdateStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "finding-update":
    case "downloading-metadata":
    case "downloading-pdf":
      return "processing";
    case "up-to-date":
    case "updated":
      return "done";
    case "download-error":
    case "general-error":
      return "error";
  }
}

async function createItemByZotero(
  paper: PaperIdentifier,
  collections: number[],
): Promise<Zotero.Item | false> {
  let translate;
  if (paper.doi) {
    translate = new Zotero.Translate.Search();
    translate.setIdentifier({ DOI: paper.doi });
    const translators = await translate.getTranslators();
    translate.setTranslator(translators);
  } else if (paper.url) {
    translate = new Zotero.Translate.Web();
    const doc = await Zotero.HTTP.processDocuments(paper.url, (doc) => doc);
    translate.setDocument(doc[0]);
    const translators = await translate.getTranslators();
    translate.setTranslator(translators);
  }
  const libraryID = Zotero.getActiveZoteroPane().getSelectedLibraryID();
  const items = await translate.translate({
    libraryID,
    collections,
    saveAttachments: false, // we will do it later
  });
  if (items.length === 0) return false;
  return items[0];
}

export class arXivUpdate {
  static menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;

  @catchError
  static registerRightClickMenuItem() {
    // item menuitem with icon
    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "zotero-arxiv-workflow-update",
      label: getString("menuitem-update"),
      icon: arXivUpdate.menuIcon,
      getVisibility: () => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        for (const preprintItem of items) {
          if (preprintItem.itemType !== "preprint") return false;
          const arXivURL = preprintItem.getField("url");
          const urlHost = new URL(arXivURL).hostname;
          if (!Object.values(KNOWN_PREPRINT_SERVERS).includes(urlHost))
            return false;
        }
        return true;
      },
      commandListener: async () => {
        const preprintItems = Zotero.getActiveZoteroPane().getSelectedItems();
        arXivUpdate.update(preprintItems);
      },
    });
  }

  static async update(
    preprintItem: Zotero.Item | Zotero.Item[],
    options: { openWindow?: boolean } = {},
  ) {
    arXivUpdate.createUpdateTasks(
      Array.isArray(preprintItem) ? preprintItem : [preprintItem],
    );
    arXivUpdate.sortTableData();
    const window = addon.data.arXivUpdate.window;
    const tableHelper = addon.data.arXivUpdate.tableHelper;
    if (window !== undefined && !window.closed && tableHelper !== undefined) {
      // Simply update data if window is open and valid
      tableHelper.treeInstance.invalidate();
      (window.sizeToContentConstrained ?? window.sizeToContent)({
        prefWidth: 500,
        maxHeight: 300,
      });
    } else {
      // Clear old data and reopen window otherwise
      addon.data.arXivUpdate.tableData =
        addon.data.arXivUpdate.tableData.filter((data) =>
          ["processing", "pending"].includes(simplifyUpdateStatus(data.status)),
        );
      if (options.openWindow ?? true) {
        arXivUpdate.openDialog();
      }
    }
  }

  static async updateItemWithProgress(
    preprintItem: Zotero.Item,
    reportProgress: ReportProgress,
  ) {
    reportProgress("finding-update");
    try {
      const paper = await new PaperFinder(preprintItem).find();
      if (paper === undefined) return reportProgress("up-to-date");
      // Download published version
      reportProgress("downloading-metadata");
      const collection = Zotero.getActiveZoteroPane().getSelectedCollection();
      let collections: number[] = [];
      if (collection) {
        collections = [collection.id];
      }
      const journalItem = await createItemByZotero(paper, collections);
      if (!journalItem) return reportProgress("download-error");
      journalItem.saveTx();

      let hasErrorDownloadingPDF = false;
      if (
        getPref("downloadJournalPDF") &&
        Zotero.Attachments.canFindPDFForItem(journalItem)
      ) {
        reportProgress("downloading-pdf");
        const attachment = await Zotero.Attachments.addAvailableFile(
          journalItem,
          // Only download from publisher
          { methods: ["doi"] },
        );
        if (attachment) {
          attachment.setField("title", paper.title);
          attachment.saveTx();
        } else {
          hasErrorDownloadingPDF = true;
        }
      }
      await arXivMerge.merge(preprintItem, journalItem, true);

      if (hasErrorDownloadingPDF) {
        reportProgress(
          "updated",
          getString("update-message", "download-pdf-error"),
        );
      } else {
        reportProgress("updated");
      }
    } catch (err) {
      ztoolkit.log(err);
      reportProgress(
        "general-error",
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unknown error",
      );
    }
  }

  static createUpdateTasks(preprintItems: Zotero.Item[]) {
    for (const preprintItem of preprintItems) {
      if (
        addon.data.arXivUpdate.tableData.findIndex(
          (data) => data.id === preprintItem.id,
        ) == -1
      ) {
        addon.data.arXivUpdate.tableData.push({
          id: preprintItem.id,
          title: preprintItem.getDisplayTitle(),
          status: "pending",
          message: undefined,
        });
        addon.data.arXivUpdate.queue.add(() =>
          arXivUpdate.updateItemWithProgress(preprintItem, (status, msg) => {
            const data = addon.data.arXivUpdate.tableData.find(
              (item) => item.id === preprintItem.id,
            )!;
            data.status = status;
            data.message = msg;
            arXivUpdate.sortTableData();
          }),
        );
      }
    }
  }

  static async openDialog() {
    const loadLock = Zotero.Promise.defer();
    const window = Zotero.getMainWindow().openDialog(
      `chrome://${config.addonRef}/content/update-dialog.xhtml`,
      "_blank",
      "chrome,scroll,centerscreen",
      { loadLock },
    )!;
    addon.data.arXivUpdate.window = window;
    window.addEventListener("DOMContentLoaded", () => loadLock.resolve());
    await loadLock.promise;

    addon.data.arXivUpdate.tableHelper = new ztoolkit.VirtualizedTable(window)
      .setContainerId(`${config.addonRef}-status-container`)
      .setProp({
        id: `${config.addonRef}-status-table`,
        columns: [
          {
            dataKey: "title",
            label: getString("update-window", "col-title"),
            width: 100,
          },
          {
            dataKey: "status",
            label: getString("update-window", "col-status"),
            // @ts-expect-error: renderer is not typed
            renderer: this.renderStatusCell, // For Zotero 7.1+
          },
        ],
        containerWidth: 500,
        staticColumns: true,
        showHeader: true,
        isSelectable: () => false,
      })
      .setProp("getRowCount", () => addon.data.arXivUpdate.tableData.length)
      .setProp("getRowData", (index) => {
        const data = addon.data.arXivUpdate.tableData[index];
        let message = getString("update-status", data.status);
        if (data.message) {
          message += ": " + data.message;
        }
        // Use Emoji for Zotero < 7.1
        const emojiMap: Record<SimpleUpdateStatus, string> = {
          pending: "⚪",
          processing: "🔵",
          done: "🟢",
          error: "🔴",
        };
        message = emojiMap[simplifyUpdateStatus(data.status)] + " " + message;
        return { title: data.title, status: message };
      })
      .render(-1, () => {
        (window.sizeToContentConstrained ?? window.sizeToContent)({
          prefWidth: 500,
          maxHeight: 300,
        });
      });
  }

  static renderStatusCell(
    index: number,
    dataString: string,
    column: _ZoteroTypes.ItemTreeManager.ItemTreeColumnOptions & {
      className: string;
    },
  ) {
    const document = addon.data.arXivUpdate.window?.document;
    if (!document) return;
    const colorMap: Record<SimpleUpdateStatus, string> = {
      pending: "#999999",
      processing: "#2ea8e5",
      done: "#5fb236",
      error: "#ff6666",
    };
    const status = simplifyUpdateStatus(
      addon.data.arXivUpdate.tableData[index].status,
    );
    const color = colorMap[status];

    const div = document.createElement("span");
    const span = document.createElement("span");
    span.className = "tag-swatch";
    span.style.color = color;
    div.appendChild(span);

    const text = document.createElement("span");
    text.className = "status-message";
    // Remove Emoji circle
    text.innerText = dataString.substring(dataString.indexOf(" "));
    div.appendChild(text);

    div.className = `cell ${column.className}`;
    return div;
  }

  static sortTableData() {
    const newTableData: UpdateTableData[] = [];
    for (const tableDatum of addon.data.arXivUpdate.tableData) {
      if (simplifyUpdateStatus(tableDatum.status) === "error") {
        newTableData.push(tableDatum);
      }
    }
    for (const tableDatum of addon.data.arXivUpdate.tableData) {
      if (simplifyUpdateStatus(tableDatum.status) === "processing") {
        newTableData.push(tableDatum);
      }
    }
    for (const tableDatum of addon.data.arXivUpdate.tableData) {
      if (simplifyUpdateStatus(tableDatum.status) === "pending") {
        newTableData.push(tableDatum);
      }
    }
    for (const tableDatum of addon.data.arXivUpdate.tableData) {
      if (simplifyUpdateStatus(tableDatum.status) === "done") {
        newTableData.push(tableDatum);
      }
    }
    addon.data.arXivUpdate.tableData.splice(
      0,
      addon.data.arXivUpdate.tableData.length,
      ...newTableData,
    );
    addon.data.arXivUpdate.tableHelper?.treeInstance.invalidate();
  }
}

class PaperFinder {
  preprintURL: string;
  title: string;
  item: Zotero.Item;

  constructor(preprintItem: Zotero.Item) {
    this.item = preprintItem;
    this.preprintURL = preprintItem.getField("url");
    this.title = preprintItem.getDisplayTitle();
    const urlHost = new URL(this.preprintURL).hostname;
    if (!Object.values(KNOWN_PREPRINT_SERVERS).includes(urlHost)) {
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
      const result = await finder().catch(ztoolkit.log);
      if (result) return result;
    }
  }

  async relatedDOI(): Promise<PaperIdentifier | undefined> {
    const urlHost = new URL(this.preprintURL).hostname;
    if (urlHost === KNOWN_PREPRINT_SERVERS.arxiv) {
      const htmlResp = await fetch(this.preprintURL);
      const htmlContent = await htmlResp.text();
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
      const jsonResp = await fetch(apiURL);
      const json = (await jsonResp.json()) as any;
      const doi = json.collection?.[0]?.published as string | undefined;
      return doi ? { doi, title: "Published PDF" } : undefined;
    } else if (urlHost == KNOWN_PREPRINT_SERVERS.chemrxiv) {
      const arxivID = this.preprintURL.match(/\/(?<arxivID>[\da-f]+)$/)?.groups
        ?.arxivID;
      if (!arxivID) return undefined;
      const apiURL = `https://chemrxiv.org/engage/chemrxiv/public-api/v1/items/${arxivID}`;
      const jsonResp = await fetch(apiURL);
      const json = (await jsonResp.json()) as any;
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
    const jsonResp = await fetch(semanticURL);
    const semanticJSON = (await jsonResp.json()) as any;
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
    const dblpURL = `${dblpAPI}?q=${encodeURIComponent(this.title)}&format=json`;
    const jsonResp = await fetch(dblpURL);
    const json = (await jsonResp.json()) as any;
    const info = json?.result?.hits?.hit?.[0]?.info;
    // Remove final `.` in title (idk why dblp has this)
    const title = info?.title?.replace(/\.$/, "");
    // Require exact title match
    if (this.title !== title) {
      ztoolkit.log(
        title
          ? `DBLP title mismatch: expected "${this.title}", got "${title}"`
          : "Paper not found on DBLP",
      );
      return;
    }
    // Ignore this DBLP entry if it belongs to CoRR. See also #14
    return !info?.url || info.venue === "CoRR"
      ? undefined
      : { url: info?.url, title: "Published PDF" };
  }

  async pubMed(): Promise<PaperIdentifier | undefined> {
    const pubMedSearchAPI =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed";
    const pubMedSearchURL = `${pubMedSearchAPI}&term=${encodeURIComponent(this.title)}&retmode=json`;
    const searchJsonResp = await fetch(pubMedSearchURL);
    const searchJson = (await searchJsonResp.json()) as any;
    const paperId = searchJson?.esearchresult?.idlist?.[0];
    if (!paperId) return undefined;
    const pubMedPaperAPI =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed";
    const pubMedPaperURL = `${pubMedPaperAPI}&id=${paperId}&retmode=json`;
    const paperJsonResp = await fetch(pubMedPaperURL);
    const paperJson = (await paperJsonResp.json()) as any;
    // Remove final `.` in title (idk why PubMed has this)
    const info = paperJson?.result?.[paperId];
    const title = info?.title?.replace(/\.$/, "");
    // Require exact title match
    if (this.title !== title) {
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
    let hasPDF = false;
    let localVersion = 0;
    for (const attachmentID of this.item.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (!attachment.isPDFAttachment()) continue;
      hasPDF = true;
      const fullText = await Zotero.PDFWorker.getFullText(attachmentID, 1);
      const match = fullText.text.match(/arXiv:[\d.]+v(\d+)/);
      if (!match) continue;
      const currentPDFVersion = parseInt(match[1], 10);
      if (currentPDFVersion > localVersion) {
        localVersion = currentPDFVersion;
      }
    }
    ztoolkit.log(`Current arXiv version: ${localVersion}`);
    if (hasPDF && localVersion === 0) return undefined;
    const htmlResp = await fetch(this.item.getField("url"));
    const htmlContent = await htmlResp.text();
    const match = htmlContent.match(/<strong>\[v(\d+)\]<\/strong>/);
    if (!match) return undefined;
    const onlineVersion = parseInt(match[1], 10);
    if (hasPDF && onlineVersion <= localVersion) return undefined;
    return { url: this.preprintURL, title: `v${onlineVersion} PDF` };
  }
}
