import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { catchError } from "./error";

export class PreferPDF {
  @catchError
  static registerRightClickMenuItem() {
    const menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;
    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "zotero-arxiv-workflow-prefer",
      label: getString("menuitem-prefer"),
      getVisibility: () => {
        const items = ZoteroPane.getSelectedItems();
        if (items.length !== 1) return false;
        ztoolkit.log(items[0].itemType);
        if (!items[0].itemType.startsWith("attachment")) return false;
        return true;
      },
      commandListener: async (ev) => {
        ztoolkit.log(ev);
        const selectedAttachment = ZoteroPane.getSelectedItems()[0];
        const item = selectedAttachment.parentItem!;
        let oldestPDFDate = new Date();
        for (const attachmentID of item.getAttachments()) {
          const attachment = await Zotero.Items.getAsync(attachmentID);
          if (!attachment.itemType.startsWith("attachment")) continue;
          ztoolkit.log(attachment.toJSON());
          const attachmentDate = new Date(attachment.dateAdded);
          if (attachmentDate.getTime() < oldestPDFDate.getTime()) {
            oldestPDFDate = attachmentDate;
          }
        }
        await Zotero.DB.executeTransaction(async function () {
          oldestPDFDate = new Date(oldestPDFDate.getTime() - 100);
          selectedAttachment.dateAdded = oldestPDFDate.toISOString();
          selectedAttachment.save();
        });
      },
      icon: menuIcon,
    });
  }
}
