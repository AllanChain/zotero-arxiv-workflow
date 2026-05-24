import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { catchError } from "./error";
import { MenuHelper } from "../utils/menu";

export class PreferPDF {
  static registerRightClickMenuItem() {
    MenuHelper.register({
      id: "prefer",
      l10nID: "prefer",
      onCommand: async (items) => {
        if (items.length === 1 && items[0].isPDFAttachment()) {
          await PreferPDF.prefer(items[0]);
        }
      },
      onShowing: (setVisible, items) => {
        setVisible(
          items.length === 1 &&
            items[0].isPDFAttachment() &&
            !!items[0].parentItem,
        );
      },
    });
  }

  /* Tell Zotero to perfer selected PDF
   *
   * Zotero determines the prefered PDF by checking:
   * - If the URL of the attachment matches the URL of the parentItem
   * - If it's the first-added PDF
   */
  static async prefer(selectedAttachment: Zotero.Item) {
    const item = selectedAttachment.parentItem;
    if (!item) {
      ztoolkit.log("No parent item found for attachment");
      return;
    }
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
