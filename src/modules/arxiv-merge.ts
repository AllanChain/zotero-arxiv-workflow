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
        await Zotero.DB.executeTransaction(async function () {
          preprintItem.setType(journalItem.itemTypeID);
          const journalJSON = journalItem.toJSON();
          // Use date and URL form the arXiv item
          ["dateAdded", "dateModified", "url"].forEach((field) => {
            // @ts-ignore some fields are not listed in zotero-type
            delete journalJSON[field];
          });
          ztoolkit.log(journalJSON);
          preprintItem.fromJSON(journalJSON);
          preprintItem.save();
          for (const preprintAttachmentID of preprintItem.getAttachments()) {
            const attachment =
              await Zotero.Items.getAsync(preprintAttachmentID);
            ztoolkit.log(attachment.toJSON());
            // Lower the priority of the old PDF
            attachment.dateAdded = new Date().toISOString();
            attachment.save();
          }
        });
        Zotero.Items.merge(preprintItem, [journalItem]);
      },
      icon: menuIcon,
    });
  }
}
