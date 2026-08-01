import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import { catchError } from "../error";
import { KNOWN_PREPRINT_SERVERS } from "./paper-finder";
import { UpdateDialog } from "./update-dialog";

export class arXivUpdate {
  static menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;

  @catchError
  static registerRightClickMenuItem() {
    Zotero.MenuManager.registerMenu({
      menuID: `${config.addonRef}-update`,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          l10nID: `${config.addonRef}-menuitem-update`,
          icon: arXivUpdate.menuIcon,
          onCommand: async () => {
            const preprintItems =
              Zotero.getActiveZoteroPane()?.getSelectedItems();
            if (!preprintItems) return;
            ztoolkit.log(
              `Update command: ${preprintItems.length} items selected`,
            );
            arXivUpdate.update(preprintItems);
          },
          onShowing: (ev, { setVisible }) => {
            const isKnownPreprintItem = (
              Zotero.getActiveZoteroPane()?.getSelectedItems() ?? []
            ).map((item) => {
              if (item.itemType !== "preprint") return false;
              const arXivURL = item.getField("url");
              const urlHost = new URL(arXivURL).hostname;
              return Object.values(KNOWN_PREPRINT_SERVERS).includes(urlHost);
            });
            if (getPref("update.alwaysShowButton"))
              setVisible(isKnownPreprintItem.some(Boolean));
            else setVisible(isKnownPreprintItem.every(Boolean));
          },
        },
      ],
    });
  }

  static update(
    preprintItem: Zotero.Item | Zotero.Item[],
    options: { openWindow?: boolean } = {},
  ) {
    addon.data.arXivUpdate.manager.enqueue(
      Array.isArray(preprintItem) ? preprintItem : [preprintItem],
    );
    UpdateDialog.refreshOrOpen(options);
  }
}
