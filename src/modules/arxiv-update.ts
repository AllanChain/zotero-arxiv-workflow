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
          if (doi === undefined) return showError("No related DOI found");

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
          await arXivMerge.merge(preprintItem, journalItem);

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
}
