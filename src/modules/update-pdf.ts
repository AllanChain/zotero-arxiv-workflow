import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { catchError } from "./error";

export class UpdatePDF {
  static menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;

  @catchError
  static registerRightClickMenuItem() {
    Zotero.MenuManager.registerMenu({
      menuID: `${config.addonRef}-update-pdf`,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          l10nID: `${config.addonRef}-menuitem-update-pdf`,
          icon: UpdatePDF.menuIcon,
          onCommand: async () => {
            const journalItem =
              Zotero.getActiveZoteroPane().getSelectedItems()[0];
            UpdatePDF.update(journalItem);
          },
          onShowing: (ev, { setVisible }) => {
            const items = Zotero.getActiveZoteroPane().getSelectedItems();
            setVisible(
              items.length === 1 && items[0].itemType === "journalArticle",
            );
          },
        },
      ],
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
    const attachmentItem = await Zotero.Attachments.addAvailableFile(
      journalItem,
      { methods: ["doi"] }, // Only download from publisher
    );
    if (attachmentItem) {
      popupWin.changeLine({ text: tr("success"), progress: 100 }).show(1000);
    } else {
      popupWin.changeLine({ text: tr("error"), progress: 100 }).show(1000);
    }
  }
}
