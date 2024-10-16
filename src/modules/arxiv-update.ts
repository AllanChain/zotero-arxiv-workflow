import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { arXivMerge } from "./arxiv-merge";
import { catchError } from "./error";

interface PaperIdentifier {
  doi?: string;
  url?: string;
  title: string;
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
        if (items.length !== 1) return false;
        const preprintItem = items[0];
        if (preprintItem.itemType !== "preprint") return false;
        const arXivURL = preprintItem.getField("url");
        if (!arXivURL.includes("arxiv")) return false;
        return true;
      },
      commandListener: async (ev) => {
        const preprintItem = Zotero.getActiveZoteroPane().getSelectedItems()[0];
        arXivUpdate.update(preprintItem);
      },
    });
  }

  static async update(preprintItem: Zotero.Item) {
    const tr = (branch: string) => getString("update-prompt", branch);
    const popupWin = new ztoolkit.ProgressWindow(getString("update-prompt"));
    popupWin.createLine({
      icon: arXivUpdate.menuIcon,
      text: tr("find-published"),
      progress: 0,
    });
    popupWin.show(-1);
    const showError = (msg: string) => {
      popupWin.changeLine({ text: tr(msg), progress: 100 }).show(1000);
    };
    try {
      const paper = await new PaperFinder(preprintItem).find();
      if (paper === undefined) return showError("uptodate");
      // Download published version
      popupWin.changeLine({ text: tr("download-paper"), progress: 30 });
      popupWin.show(-1);
      const collection = Zotero.getActiveZoteroPane().getSelectedCollection();
      let collections: number[] = [];
      if (collection) {
        collections = [collection.id];
      }
      const journalItem = await createItemByZotero(paper, collections);
      if (!journalItem) return showError("download-fail");
      journalItem.saveTx();

      if (
        getPref("downloadJournalPDF") &&
        Zotero.Attachments.canFindPDFForItem(journalItem)
      ) {
        popupWin.changeLine({ text: tr("download-pdf"), progress: 60 });
        popupWin.show(-1);
        const attachment = await Zotero.Attachments.addAvailablePDF(
          journalItem,
          {
            // @ts-ignore zotero-type mistake
            methods: ["doi"], // Only download from publisher
          },
        );
        if (attachment) {
          attachment.setField("title", paper.title);
          attachment.saveTx();
        } else {
          showError("download-fail");
        }
      }
      await arXivMerge.merge(preprintItem, journalItem, true);

      popupWin.changeLine({ text: tr("updated"), progress: 100 }).show(1000);
    } catch (err) {
      ztoolkit.log(err);
      return showError("error");
    }
  }
}

class PaperFinder {
  arXivID: string;
  arXivURL: string;
  title: string;
  item: Zotero.Item;

  constructor(preprintItem: Zotero.Item) {
    this.item = preprintItem;
    this.arXivURL = preprintItem.getField("url");
    this.title = preprintItem.getDisplayTitle();
    const idMatch = this.arXivURL.match(/\/(?<arxiv>[^/]+)$/);
    if (idMatch?.groups?.arxiv === undefined) {
      throw `${this.arXivURL} is not a valid arXivURL`;
    }
    this.arXivID = idMatch.groups.arxiv;
  }

  async find(): Promise<PaperIdentifier | undefined> {
    const finders = [
      getPref("updateSource.doi") && this.relatedDOI.bind(this),
      getPref("updateSource.semanticScholar") &&
        this.semanticScholar.bind(this),
      getPref("updateSource.dblp") && this.dblp.bind(this),
      getPref("updateSource.arXiv") && this.arXivPDF.bind(this),
    ];
    for (const finder of finders) {
      if (!finder) continue;
      const result = await finder().catch(ztoolkit.log);
      if (result) return result;
    }
  }

  async relatedDOI(): Promise<PaperIdentifier | undefined> {
    const htmlResp = await fetch(this.arXivURL);
    const htmlContent = await htmlResp.text();
    const doiMatch = htmlContent.match(/data-doi="(?<doi>.*?)"/);
    const doi = doiMatch?.groups?.doi;
    return doi ? { doi, title: "Published PDF" } : undefined;
  }

  async semanticScholar(): Promise<PaperIdentifier | undefined> {
    const semanticAPI = "https://api.semanticscholar.org/graph/v1/paper";
    const semanticURL = `${semanticAPI}/ARXIV:${this.arXivID}?fields=externalIds`;
    const jsonResp = await fetch(semanticURL);
    const semanticJSON = (await jsonResp.json()) as any;
    const doi = semanticJSON.externalIds?.DOI as string | undefined;
    // Retrun undefined if the DOI is an arXiv DOI
    return !doi || doi.toLowerCase()?.includes("arxiv")
      ? undefined
      : { doi, title: "Published PDF" };
  }

  async dblp(): Promise<PaperIdentifier | undefined> {
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
        `DBLP title mismatch: expected "${this.title}", got "${title}"`,
      );
      return;
    }
    // Ignore this DBLP entry if it belongs to CoRR. See also #14
    return !info?.url || info.venue === "CoRR"
      ? undefined
      : { url: info?.url, title: "Published PDF" };
  }

  async arXivPDF(): Promise<PaperIdentifier | undefined> {
    let localVersion = 0;
    for (const attachmentID of this.item.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (!attachment.isPDFAttachment()) continue;
      const fullText = await Zotero.PDFWorker.getFullText(attachmentID, 1);
      const match = fullText.text.match(/arXiv:[\d.]+v(\d+)/);
      if (!match) continue;
      const currentPDFVersion = parseInt(match[1], 10);
      if (currentPDFVersion > localVersion) {
        localVersion = currentPDFVersion;
      }
    }
    ztoolkit.log(`Current arXiv version: ${localVersion}`);
    if (localVersion === 0) return undefined;
    const htmlResp = await fetch(this.item.getField("url"));
    const htmlContent = await htmlResp.text();
    const match = htmlContent.match(/<strong>\[v(\d+)\]<\/strong>/);
    if (!match) return undefined;
    const onlineVersion = parseInt(match[1], 10);
    if (onlineVersion <= localVersion) return undefined;
    return { url: this.arXivURL, title: `v${onlineVersion} PDF` };
  }
}
