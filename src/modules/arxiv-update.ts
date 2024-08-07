import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { arXivMerge } from "./arxiv-merge";
import { catchError } from "./error";

async function createItemByZotero(
  doi: string,
  collections: number[],
): Promise<Zotero.Item | false> {
  const translate = new Zotero.Translate.Search();
  translate.setIdentifier({ DOI: doi });
  const translators = await translate.getTranslators();
  translate.setTranslator(translators);
  const libraryID = ZoteroPane.getSelectedLibraryID();
  const items = await translate.translate({
    libraryID,
    collections,
    saveAttachments: false, // we will do it later
  });
  if (items.length === 0) return false;
  return items[0];
}

export class arXivUpdate {
  @catchError
  static registerRightClickMenuItem() {
    const menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;
    // item menuitem with icon
    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "zotero-arxiv-workflow-update",
      label: getString("menuitem-update"),
      icon: menuIcon,
      getVisibility: () => {
        const items = ZoteroPane.getSelectedItems();
        if (items.length !== 1) return false;
        const preprintItem = items[0];
        if (preprintItem.itemType !== "preprint") return false;
        const arXivURL = preprintItem.getField("url");
        if (!arXivURL.includes("arxiv")) return false;
        return true;
      },
      commandListener: async (ev) => {
        const preprintItem = ZoteroPane.getSelectedItems()[0];
        const arXivURL = preprintItem.getField("url");
        const popupWin = new ztoolkit.ProgressWindow("Update arXiv");
        popupWin.createLine({
          icon: menuIcon,
          text: "Searching for published versions...",
          progress: 0,
        });
        popupWin.show(-1);
        const showError = (msg: string) => {
          popupWin.changeLine({ text: msg, progress: 100 }).show(1000);
        };
        try {
          const doi = await arXivUpdate.findPublishedDOI(arXivURL);
          if (doi === undefined) {
            // Find new arXiv version instead
            popupWin.changeLine({
              text: "Searching for new arXiv version...",
              progress: 30,
            });
            popupWin.show(-1);
            const onlineVersion =
              await arXivUpdate.arXivHasNewVersion(preprintItem);
            if (onlineVersion === false) return showError("Already up-to-date");
            popupWin.changeLine({ text: "Downloading PDF...", progress: 60 });
            const attachment = await Zotero.Attachments.addPDFFromURLs(
              preprintItem,
              Zotero.Attachments.getPDFResolvers(preprintItem, ["url"]),
            );
            if (!attachment) return showError("Failed to download PDF");
            attachment.setField("title", `v${onlineVersion} PDF`);
            attachment.saveTx();
            popupWin.changeLine({
              text: "arXiv paper updated.",
              progress: 100,
            });
            popupWin.show(1000);
            return;
          }
          // Download published version
          popupWin.changeLine({ text: "Downloading journal...", progress: 30 });
          popupWin.show(-1);
          const collection = ZoteroPane.getSelectedCollection();
          let collections: number[] = [];
          if (collection) {
            collections = [collection.id];
          }
          const journalItem = await createItemByZotero(doi, collections);
          if (!journalItem) return showError("Failed to download");
          journalItem.saveTx();

          if (
            getPref("downloadJournalPDF") &&
            Zotero.Attachments.canFindPDFForItem(journalItem)
          ) {
            popupWin.changeLine({ text: "Downloading PDF...", progress: 60 });
            popupWin.show(-1);
            await Zotero.Attachments.addAvailablePDF(journalItem, {
              // @ts-ignore zotero-type mistake
              methods: ["doi"], // Only download from publisher
            });
          }
          await arXivMerge.merge(preprintItem, journalItem, true);

          popupWin.changeLine({ text: "arXiv paper updated.", progress: 100 });
          popupWin.show(1000);
        } catch (err) {
          ztoolkit.log(err);
          return showError("Error updating arXiv");
        }
      },
    });
  }

  static async findPublishedDOI(arXivURL: string): Promise<string | undefined> {
    try {
      const htmlResp = await fetch(arXivURL);
      const htmlContent = await htmlResp.text();
      const doiMatch = htmlContent.match(/data-doi="(?<doi>.*?)"/);
      if (doiMatch?.groups?.doi) return doiMatch.groups.doi;
    } catch (err) {
      ztoolkit.log(err);
    }
    const idMatch = arXivURL.match(/\/(?<arxiv>[^/]+)$/);
    if (idMatch?.groups?.arxiv === undefined) return;
    const arXivID = idMatch.groups.arxiv;
    const semanticAPI = "https://api.semanticscholar.org/graph/v1/paper";
    const semanticURL = `${semanticAPI}/ARXIV:${arXivID}?fields=externalIds`;
    try {
      const jsonResp = await fetch(semanticURL);
      const semanticJSON = (await jsonResp.json()) as any;
      const doi = semanticJSON.externalIds?.DOI as string | undefined;
      return doi?.toLowerCase()?.includes("arxiv") ? undefined : doi;
    } catch (err) {
      ztoolkit.log(err);
    }
  }

  static async arXivHasNewVersion(
    preprintItem: Zotero.Item,
  ): Promise<false | number> {
    let localVersion = 0;
    for (const attachmentID of preprintItem.getAttachments()) {
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
    if (localVersion === 0) return false;
    const htmlResp = await fetch(preprintItem.getField("url"));
    const htmlContent = await htmlResp.text();
    const match = htmlContent.match(/<strong>\[v(\d+)\]<\/strong>/);
    if (!match) return false;
    const onlineVersion = parseInt(match[1], 10);
    return onlineVersion > localVersion ? onlineVersion : false;
  }
}
