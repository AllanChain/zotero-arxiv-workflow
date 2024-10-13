import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { catchError } from "./error";

export class UpdatePDF {
  static menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;

  @catchError
  static registerRightClickMenuItem() {
    // item menuitem with icon
    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "zotero-arxiv-workflow-update-pdf",
      label: getString("menuitem-update-pdf"),
      icon: UpdatePDF.menuIcon,
      getVisibility: () => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        if (items.length !== 1) return false;
        const publishedItem = items[0];
        if (publishedItem.itemType !== "journalArticle") return false;
        return true;
      },
      commandListener: async (ev) => {
        const journalItem = Zotero.getActiveZoteroPane().getSelectedItems()[0];
        UpdatePDF.update(journalItem);
      },
    });
  }
  static async update(journalItem: Zotero.Item) {
    const tr = (branch: string) => getString("update-pdf-prompt", branch);
    const popupWin = new ztoolkit.ProgressWindow(
      getString("update-pdf-prompt"),
    );
    popupWin.createLine({
      icon: UpdatePDF.menuIcon,
      text: tr("download"),
      progress: 0,
    });
    popupWin.show(-1);
    const attachmentItem = await Zotero.Attachments.addAvailablePDF(
      journalItem,
      // @ts-ignore zotero-type mistake
      { methods: ["doi"] }, // Only download from publisher
    );
    if (attachmentItem) {
      popupWin.changeLine({ text: tr("success"), progress: 100 }).show(1000);
    } else {
      popupWin.changeLine({ text: tr("error"), progress: 100 }).show(1000);
    }
  }
}
