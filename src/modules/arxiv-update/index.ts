import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import { catchError } from "../error";
import { isKnownPreprintURL } from "./paper-finder";
import { UpdateDialog } from "./update-dialog";

export function isUpdateMenuVisible(
  knownPreprint: boolean[],
  alwaysShowButton: boolean,
): boolean {
  return alwaysShowButton
    ? knownPreprint.some(Boolean)
    : knownPreprint.every(Boolean);
}

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
              return isKnownPreprintURL(item.getField("url"));
            });
            setVisible(
              isUpdateMenuVisible(
                isKnownPreprintItem,
                getPref("update.alwaysShowButton"),
              ),
            );
          },
        },
      ],
    });
  }

  static update(
    preprintItem: Zotero.Item | Zotero.Item[],
    options: { openWindow?: boolean } = {},
  ) {
    addon.data.arXivUpdate.manager.createUpdateTasks(
      Array.isArray(preprintItem) ? preprintItem : [preprintItem],
    );
    UpdateDialog.refreshOrOpen(options);
  }
}
