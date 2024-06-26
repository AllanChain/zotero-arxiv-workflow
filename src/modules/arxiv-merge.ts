import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { catchError } from "./error";
import { getPref } from "../utils/prefs";

export class arXivMerge {
  static reservedKeys = ["dateAdded", "dateModified", "url", "extra"];

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
        const { preprintItem, publishedItem } = arXivMerge.identifyItems(items);
        if (preprintItem === undefined || publishedItem === undefined)
          return false;
        return true;
      },
      commandListener: async (ev) => {
        const items = ZoteroPane.getSelectedItems();
        if (items.length !== 2) {
          // @ts-expect-error null is also a valid argument
          Zotero.alert(null, "Impossible", "Only supports merging 2 items.");
          return;
        }
        const { preprintItem, publishedItem } = arXivMerge.identifyItems(items);
        if (preprintItem === undefined || publishedItem === undefined) {
          // @ts-expect-error null is also a valid argument
          Zotero.alert(null, "Impossible", "Select one arXiv and one journal");
          return;
        }
        await this.merge(preprintItem, publishedItem);
      },
    });
  }

  static identifyItems(items: Zotero.Item[]) {
    const preprintItem = items.find((item) => item.itemType === "preprint");
    const publishedItem = items.find((item) =>
      (
        ["journalArticle", "conferencePaper"] as Zotero.Item.ItemType[]
      ).includes(item.itemType),
    );
    return { preprintItem, publishedItem };
  }

  static async merge(preprintItem: Zotero.Item, publishedItem: Zotero.Item) {
    preprintItem.setType(publishedItem.itemTypeID);
    const journalJSON = publishedItem.toJSON();
    const preprintJSON = preprintItem.toJSON();
    // Use date and URL from the arXiv item
    arXivMerge.reservedKeys.forEach((field) => {
      // @ts-ignore some fields are not listed in zotero-type
      journalJSON[field] = preprintJSON[field];
    });
    /* Avoid citation key collision after preprint item updates (say year)
     * For example, no collision:
     * - Published item: li_wang_2024-1
     * - Preprint item: li_wang_2024
     * Thing will work without problem.
     * Collision:
     * - Published item: li_wang_2024
     * - Preprint item: li_wang_2023
     * If we do nothing, after `preprintItem.saveTx`, the citation key will update
     * to li_wang_2024-1, which is something we don't want. One approach is to fix
     * the citation key for the preprint item. But it involves working with BBT.
     * The workaround here is to set a random citation key for the published item.
     * TODO: What if the user wants to keep the citation key (not fixed in BBT)?
     */
    publishedItem.setField("extra", `Citation Key: ${crypto.randomUUID()}`);
    publishedItem.saveTx();
    preprintItem.fromJSON(journalJSON);
    preprintItem.saveTx();
    if (getPref("mergePreferJournalPDF")) {
      let oldestPDFDate = new Date();
      for (const attachmentID of preprintItem.getAttachments()) {
        const attachment = await Zotero.Items.getAsync(attachmentID);
        const attachmentDate = new Date(attachment.dateAdded);
        if (attachmentDate.getTime() < oldestPDFDate.getTime()) {
          oldestPDFDate = attachmentDate;
        }
      }
      oldestPDFDate = new Date(oldestPDFDate.getTime() - 100);
      for (const attachmentID of publishedItem.getAttachments()) {
        const attachment = await Zotero.Items.getAsync(attachmentID);
        if (attachment.isPDFAttachment()) {
          attachment.dateAdded = oldestPDFDate.toISOString();
          attachment.saveTx();
        }
      }
    } else {
      // @ts-ignore delay is not added to zotero-type
      await Zotero.Promise.delay(); // magic sleep
    }
    await Zotero.Items.merge(preprintItem, [publishedItem]);
    preprintItem.clearBestAttachmentState();
  }
}
