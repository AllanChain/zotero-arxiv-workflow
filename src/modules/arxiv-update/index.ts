import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import { catchError } from "../error";
import { isAlphaXivURL, isKnownPreprintURL } from "./paper-finder";
import { UpdateDialog } from "./update-dialog";

export function isUpdateMenuVisible(
  knownPreprint: boolean[],
  alwaysShowButton: boolean,
): boolean {
  return alwaysShowButton
    ? knownPreprint.some(Boolean)
    : knownPreprint.every(Boolean);
}

export function isUpdatableItem(item: Zotero.Item): boolean {
  if (!item.isRegularItem()) return false;
  const url = item.getField("url");
  // alphaXiv has no preprint translator — Zotero saves its pages as journal
  // articles or web pages — so require the preprint type only for the other
  // preprint servers.
  if (item.itemType !== "preprint" && !isAlphaXivURL(url)) return false;
  return isKnownPreprintURL(url);
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
            ).map(isUpdatableItem);
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
