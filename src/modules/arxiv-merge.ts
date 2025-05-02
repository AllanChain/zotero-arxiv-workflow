import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { catchError } from "./error";
import { getPref } from "../utils/prefs";

export class arXivMerge {
  static reservedKeys = [
    "collections",
    "dateAdded",
    "dateModified",
    "key",
    "tags",
    "relations",
  ];

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
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        if (items.length !== 2) return false;
        const { preprintItem, publishedItem } = arXivMerge.identifyItems(items);
        if (preprintItem === undefined || publishedItem === undefined)
          return false;
        return true;
      },
      commandListener: async (ev) => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
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
    const publishedTypes: _ZoteroTypes.Item.ItemType[] = [
      "journalArticle",
      "conferencePaper",
      "thesis",
      "book",
      "bookSection",
    ];
    const preprintItem = items.find((item) => item.itemType === "preprint");
    const publishedItem = items.find((item) =>
      publishedTypes.includes(item.itemType),
    );
    return { preprintItem, publishedItem };
  }

  static async merge(
    preprintItem: Zotero.Item,
    publishedItem: Zotero.Item,
    suppressWarn = false,
  ) {
    if (
      !suppressWarn &&
      preprintItem.getDisplayTitle() !== publishedItem.getDisplayTitle()
    ) {
      let confirmMsg = getString("merge-confirm", "msg");
      confirmMsg += `\n- ${preprintItem.getDisplayTitle()}`;
      confirmMsg += `\n- ${publishedItem.getDisplayTitle()}`;
      if (
        !Services.prompt.confirm(
          // @ts-expect-error window is also a valid argument
          Zotero.getMainWindow(),
          getString("merge-confirm"),
          confirmMsg,
        )
      ) {
        return;
      }
    }
    preprintItem.setType(publishedItem.itemTypeID);
    const journalJSON = publishedItem.toJSON();
    const preprintJSON = preprintItem.toJSON();
    // Use date from the arXiv item
    arXivMerge.reservedKeys.forEach((field) => {
      // @ts-ignore some fields are not listed in zotero-type
      journalJSON[field] = preprintJSON[field];
    });
    // Use URL from journal by default, but can be configured to use arXiv URL
    if (getPref("merge.arXivURL")) journalJSON.url = preprintJSON.url;
    // `extra` field need more care
    const preprintExtra = Zotero.Utilities.Internal.extractExtraFields(
      (preprintJSON.extra ?? "") as string,
    );
    journalJSON.extra = Zotero.Utilities.Internal.combineExtraFields(
      (journalJSON.extra ?? "") as string,
      preprintExtra.fields,
    );
    let notes = preprintExtra.extra;
    // We generally want to keep extra information, but remove arXiv info
    if (!getPref("merge.arXivExtra"))
      notes = notes
        .split("\n")
        .filter((line) => !line.startsWith("arXiv:"))
        .join("\n");
    if (notes) journalJSON.extra += "\n" + notes;

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
    const tempExtra = Zotero.Utilities.Internal.combineExtraFields(
      journalJSON.extra as string,
      // @ts-expect-error key not listed in type
      new Map([["Citation Key", crypto.randomUUID()]]),
    );
    publishedItem.setField("extra", tempExtra);
    publishedItem.saveTx();
    preprintItem.fromJSON(journalJSON);
    preprintItem.saveTx();
    /* Create a web link attachment for arXiv URL.
     * Some preprint items already has a snapshot attachment containing the URL.
     * In that case we will skip the creation of the link attachment.
     */
    let hasSnapshot = false;
    for (const attachmentID of preprintItem.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (attachment.isSnapshotAttachment()) {
        hasSnapshot = true;
        break;
      }
    }
    if (!hasSnapshot) {
      Zotero.Attachments.linkFromURL({
        url: preprintJSON.url,
        parentItemID: preprintItem.id,
        title: preprintJSON.archiveID ?? "Preprint URL",
      });
    }
    if (getPref("merge.trashUnannotatedPDF")) {
      for (const attachmentID of preprintItem.getAttachments()) {
        const attachment = await Zotero.Items.getAsync(attachmentID);
        if (!attachment.isPDFAttachment()) continue;
        if (attachment.getAnnotations().length) continue;
        await Zotero.Items.trashTx(attachmentID);
      }
    }
    // Set prefered PDF
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
      await Zotero.Promise.delay(0); // magic sleep
    }
    await Zotero.Items.merge(preprintItem, [publishedItem]);
    preprintItem.clearBestAttachmentState();
  }
}
