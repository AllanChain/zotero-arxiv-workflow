import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { catchError } from "./error";

export class PreferPDF {
  @catchError
  static registerRightClickMenuItem() {
    const menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;
    Zotero.MenuManager.registerMenu({
      menuID: `${config.addonRef}-prefer`,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          l10nID: `${config.addonRef}-menuitem-prefer`,
          icon: menuIcon,
          onCommand: async () => {
            const selectedAttachment =
              Zotero.getActiveZoteroPane().getSelectedItems()[0];
            PreferPDF.prefer(selectedAttachment);
          },
          onShowing: (ev, { setVisible }) => {
            const items = Zotero.getActiveZoteroPane().getSelectedItems();
            setVisible(items.length === 1 && items[0].isPDFAttachment());
          },
        },
      ],
    });
  }

  /* Tell Zotero to perfer selected PDF
   *
   * Zotero determines the prefered PDF by checking:
   * - If the URL of the attachment matches the URL of the parentItem
   * - If it's the first-added PDF
   */
  static async prefer(selectedAttachment: Zotero.Item) {
    const item = selectedAttachment.parentItem!;
    let oldestPDFDate = new Date();
    for (const attachmentID of item.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (!attachment.isPDFAttachment()) continue;
      ztoolkit.log(attachment.toJSON());
      const attachmentDate = new Date(attachment.dateAdded);
      if (attachmentDate.getTime() < oldestPDFDate.getTime()) {
        oldestPDFDate = attachmentDate;
      }
    }
    oldestPDFDate = new Date(oldestPDFDate.getTime() - 100);
    selectedAttachment.setField("url", item.getField("url"));
    selectedAttachment.dateAdded = oldestPDFDate.toISOString();
    selectedAttachment.saveTx();
    item.clearBestAttachmentState();
  }
}
