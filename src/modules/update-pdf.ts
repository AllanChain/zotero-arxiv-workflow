import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { catchError } from "./error";

export class UpdatePDF {
  @catchError
  static registerRightClickMenuItem() {
    const menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;
    // item menuitem with icon
    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "zotero-arxiv-workflow-update-pdf",
      label: getString("menuitem-update-pdf"),
      icon: menuIcon,
      getVisibility: () => {
        const items = ZoteroPane.getSelectedItems();
        if (items.length !== 1) return false;
        const preprintItem = items[0];
        if (preprintItem.itemType !== "journalArticle") return false;
        return true;
      },
      commandListener: async (ev) => {
        const journalItem = ZoteroPane.getSelectedItems()[0];
        const popupWin = new ztoolkit.ProgressWindow("Find published PDF");
        popupWin.createLine({
          icon: menuIcon,
          text: "Downloading PDF...",
          progress: 0,
        });
        popupWin.show(-1);
        const showError = (msg: string) => {
          popupWin.changeLine({ text: msg, progress: 100 }).show(1000);
        };
        const attachmentItem = await Zotero.Attachments.addAvailablePDF(
          journalItem,
          // @ts-ignore zotero-type mistake
          { methods: ["doi"] }, // Only download from publisher },
        );
        if (attachmentItem) {
          popupWin.changeLine({ text: "PDF Downloaded", progress: 100 });
          popupWin.show(1000);
        } else {
          showError("Error downloading PDF");
        }
      },
    });
  }
}
