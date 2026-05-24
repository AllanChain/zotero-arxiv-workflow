import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { catchError } from "./error";
import { MenuHelper } from "../utils/menu";

export class UpdatePDF {
  static menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;

  static registerRightClickMenuItem() {
    MenuHelper.register({
      id: "update-pdf",
      l10nID: "update-pdf",
      onCommand: async (items) => {
        if (items.length === 1 && items[0].itemType === "journalArticle") {
          await UpdatePDF.update(items[0]);
        }
      },
      onShowing: (setVisible, items) => {
        setVisible(
          items.length === 1 && items[0].itemType === "journalArticle",
        );
      },
    });
  }
  static async update(journalItem: Zotero.Item) {
    if (!journalItem) return;
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
    try {
      const attachmentItem = await Zotero.Attachments.addAvailableFile(
        journalItem,
        { methods: ["doi"] }, // Only download from publisher
      );
      if (attachmentItem) {
        popupWin.changeLine({ text: tr("success"), progress: 100 }).show(1000);
      } else {
        popupWin.changeLine({ text: tr("error"), progress: 100 }).show(2000);
      }
    } catch (err) {
      ztoolkit.log(`Error updating PDF for journal item:`, err);
      popupWin.changeLine({ text: tr("error"), progress: 100 }).show(2000);
    }
  }
}
