import { config } from "../../package.json";
import { catchError } from "../modules/error";

export interface MenuItemConfig {
  id: string;
  l10nID: string;
  onCommand: (items: Zotero.Item[]) => Promise<void> | void;
  onShowing: (
    setVisible: (visible: boolean) => void,
    items: Zotero.Item[],
  ) => void;
}

export class MenuHelper {
  @catchError
  static register(menuConfig: MenuItemConfig) {
    const menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;
    Zotero.MenuManager.registerMenu({
      menuID: `${config.addonRef}-${menuConfig.id}`,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          l10nID: `${config.addonRef}-menuitem-${menuConfig.l10nID}`,
          icon: menuIcon,
          onCommand: async () => {
            try {
              const items = Zotero.getActiveZoteroPane().getSelectedItems();
              await menuConfig.onCommand(items);
            } catch (err) {
              ztoolkit.log(
                `Error running command for menu ${menuConfig.id}:`,
                err,
              );
            }
          },
          onShowing: (ev, { setVisible }) => {
            try {
              const items = Zotero.getActiveZoteroPane().getSelectedItems();
              menuConfig.onShowing(setVisible, items);
            } catch (err) {
              ztoolkit.log(`Error showing menu ${menuConfig.id}:`, err);
              setVisible(false);
            }
          },
        },
      ],
    });
  }
}
