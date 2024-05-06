import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { catchError } from "./error";

export class arXivMerge {
  @catchError
  static registerRightClickMenuItem() {
    const menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;
    // item menuitem with icon
    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "zotero-arxiv-workflow-merge",
      label: getString("menuitem-merge"),
      icon: menuIcon,
      getVisibility: () => {
        const items = ZoteroPane.getSelectedItems();
        if (items.length !== 2) return false;
        const itemTypes = items.map((item) => item.itemType);
        if (!itemTypes.includes("preprint")) return false;
        if (!itemTypes.includes("journalArticle")) return false;
        return true;
      },
      commandListener: async (ev) => {
        ztoolkit.log(ev);
        const items = ZoteroPane.getSelectedItems();
        if (items.length !== 2) {
          // @ts-expect-error null is also a valid argument
          Zotero.alert(null, "Impossible", "Only supports merging 2 items.");
          return;
        }
        const preprintItem = items.find((item) => item.itemType === "preprint");
        const journalItem = items.find(
          (item) => item.itemType === "journalArticle",
        );
        if (preprintItem === undefined || journalItem === undefined) {
          // @ts-expect-error null is also a valid argument
          Zotero.alert(null, "Impossible", "Select one arXiv and one journal");
          return;
        }
        await this.merge(preprintItem, journalItem);
      },
    });
  }

  static async merge(preprintItem: Zotero.Item, journalItem: Zotero.Item) {
    preprintItem.setType(journalItem.itemTypeID);
    const journalJSON = journalItem.toJSON();
    // Use date and URL form the arXiv item
    ["dateAdded", "dateModified", "url"].forEach((field) => {
      // @ts-ignore some fields are not listed in zotero-type
      delete journalJSON[field];
    });
    preprintItem.fromJSON(journalJSON);
    preprintItem.saveTx();
    let oldestPDFDate = new Date();
    for (const attachmentID of preprintItem.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      const attachmentDate = new Date(attachment.dateAdded);
      if (attachmentDate.getTime() < oldestPDFDate.getTime()) {
        oldestPDFDate = attachmentDate;
      }
    }
    oldestPDFDate = new Date(oldestPDFDate.getTime() - 100);
    for (const attachmentID of journalItem.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (attachment.isPDFAttachment()) {
        attachment.dateAdded = oldestPDFDate.toISOString();
        attachment.saveTx();
      }
    }
    await Zotero.Items.merge(preprintItem, [journalItem]);
    preprintItem.clearBestAttachmentState();
  }
}
