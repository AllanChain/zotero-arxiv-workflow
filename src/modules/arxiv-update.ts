import { config } from "../../package.json";
import { getString } from "../utils/locale";
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
          text: "Fetching arXiv page...",
          progress: 0,
        });
        popupWin.show(-1);
        const showError = (msg: string) =>
          popupWin.changeLine({ text: msg, progress: 100 }).show(1000);
        let htmlContent: string;
        try {
          const resp = await fetch(arXivURL);
          htmlContent = await resp.text();
          const match = htmlContent.match(/data-doi="(?<doi>.*?)"/);
          if (match?.groups?.doi === undefined) {
            showError("No related DOI found");
            return;
          }

          popupWin.changeLine({ text: "Downloading journal...", progress: 30 });
          popupWin.show(-1);
          const collection = ZoteroPane.getSelectedCollection();
          let collections: number[] = [];
          if (collection) {
            collections = [collection.id];
          }
          const journalItem = await createItemByZotero(
            match.groups.doi,
            collections,
          );
          if (!journalItem) {
            showError("Failed to download");
            return;
          }
          journalItem.saveTx();

          popupWin.changeLine({ text: "Downloading PDF...", progress: 60 });
          popupWin.show(-1);
          if (Zotero.Attachments.canFindPDFForItem(journalItem)) {
            await Zotero.Attachments.addAvailablePDF(journalItem);
          }
          await arXivMerge.merge(preprintItem, journalItem);

          popupWin.changeLine({
            text: "arXiv paper updated to " + match.groups.doi,
            progress: 100,
          });
          popupWin.show(1000);
        } catch (err) {
          ztoolkit.log(err);
          showError("Error updating arXiv");
          return;
        }
      },
    });
  }
}
