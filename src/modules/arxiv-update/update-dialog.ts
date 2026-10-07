import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import type { VirtualizedTableHelper } from "zotero-plugin-toolkit";
import { UpdateManager } from "./manager";
import { DetailDrawer } from "./detail-drawer";
import { STATUS_COLOR, STATUS_EMOJI, simplifyUpdateStatus } from "./status";

/**
 * Owns the update dialog window and table. All row state lives in
 * UpdateManager; this class only renders it and subscribes to changes.
 * Selecting a row opens the detail drawer, which owns its own state.
 */
export class UpdateDialog {
  static window?: WindowProxy;
  static tableHelper?: VirtualizedTableHelper;
  static drawer?: DetailDrawer;

  private static get manager(): UpdateManager {
    return addon.data.arXivUpdate.manager;
  }

  static async open() {
    const loadLock = Zotero.Promise.defer();
    const window = Zotero.getMainWindow().openDialog(
      `chrome://${config.addonRef}/content/update-dialog.xhtml`,
      "_blank",
      "chrome,scroll,centerscreen",
      { loadLock },
    )!;
    UpdateDialog.window = window;
    window.addEventListener("DOMContentLoaded", () => loadLock.resolve());
    await loadLock.promise;
    UpdateDialog.drawer = new DetailDrawer(
      window.document,
      UpdateDialog.manager,
    );

    UpdateDialog.tableHelper = new ztoolkit.VirtualizedTable(window)
      .setContainerId(`${config.addonRef}-status-container`)
      .setProp({
        id: `${config.addonRef}-status-table`,
        columns: [
          {
            dataKey: "title",
            label: getString("update-window", "col-title"),
            width: 100,
          },
          {
            dataKey: "status",
            label: getString("update-window", "col-status"),
            // @ts-expect-error: renderer is not typed
            renderer: UpdateDialog.renderStatusCell, // For Zotero 7.1+
            renderCell: UpdateDialog.renderStatusCell, // For Zotero 10+
          },
        ],
        containerWidth: 500,
        staticColumns: true,
        showHeader: true,
        multiSelect: false,
        getRowCount: () => UpdateDialog.manager.getRows().length,
        getRowData: (index) => UpdateDialog.getRowData(index),
        onSelectionChange: (selection) => {
          const selectedRow = selection.selected.values().next().value;
          if (window.closed) return;
          // A cleared selection is a selection change too: close the drawer.
          if (selectedRow === undefined) {
            UpdateDialog.drawer?.close();
            return;
          }
          // The selection is an index, meaningless across re-sorts; resolve
          // it to the row id now and let the drawer bind to that id.
          const row = UpdateDialog.manager.getRows()[selectedRow];
          if (!row) return;
          Zotero.getMainWindow()?.ZoteroPane.selectItem(row.id);
          UpdateDialog.drawer?.open(row.id);
        },
        onActivate: (_, items) => {
          const paperId = UpdateDialog.manager.getRows()[items[0]].id;
          const win = Zotero.getMainWindow();
          if (win) {
            win.ZoteroPane.selectItem(paperId);
            win.focus();
          }
        },
      })
      .render(-1);

    // Escape closes the drawer; focus stays on the table so arrow keys keep
    // changing selection. The listener is inert while the drawer is closed.
    window.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") UpdateDialog.drawer?.close();
    });

    // Keep the open table and the drawer in sync with row changes.
    UpdateDialog.manager.onChange = () => {
      if (window.closed) return;
      UpdateDialog.tableHelper?.treeInstance?.invalidate();
      if (UpdateDialog.drawer?.isOpen()) UpdateDialog.drawer.render();
    };

    // The manager queue outlives the window, so a late task must not repaint
    // the dead document. Drop the hook + drawer on unload; guard by window
    // identity so an old unload cannot clear a newer dialog's hook.
    window.addEventListener("unload", () => {
      if (UpdateDialog.window !== window) return;
      UpdateDialog.drawer = undefined;
      UpdateDialog.window = undefined;
      UpdateDialog.tableHelper = undefined;
      UpdateDialog.manager.onChange = undefined;
    });
  }

  static refreshOrOpen(options: { openWindow?: boolean } = {}) {
    const { window, tableHelper } = UpdateDialog;
    ztoolkit.log(
      `Update dialog state: window=${window !== undefined}, closed=${window?.closed}, table=${tableHelper !== undefined}`,
    );
    if (window !== undefined && !window.closed && tableHelper !== undefined) {
      // Simply update data if window is open and valid
      tableHelper.treeInstance?.invalidate();
    } else {
      // Clear old data and reopen window otherwise
      UpdateDialog.manager.filterInactive();
      if (options.openWindow ?? true) {
        UpdateDialog.open();
      }
    }
  }

  static getRowData(index: number): { title: string; status: string } {
    const data = UpdateDialog.manager.getRows()[index];
    let message = getString("update-status", data.status);
    if (data.message) {
      message += ": " + data.message;
    }
    // Use Emoji for Zotero < 7.1
    message = STATUS_EMOJI[simplifyUpdateStatus(data.status)] + " " + message;
    return { title: data.title, status: message };
  }

  static renderStatusCell(
    index: number,
    dataString: string,
    column: _ZoteroTypes.ItemTreeManager.ItemTreeColumnOptions & {
      className: string;
    },
  ) {
    const document = UpdateDialog.window?.document;
    const manager = UpdateDialog.manager;
    if (!document || !manager) return;
    const data = manager.getRows()[index];
    const color = STATUS_COLOR[simplifyUpdateStatus(data.status)];

    const div = document.createElement("span");
    const span = document.createElement("span");
    span.className = "tag-swatch";
    span.style.color = color;
    div.appendChild(span);

    const text = document.createElement("span");
    text.className = "status-message";
    // Remove Emoji circle
    text.innerText = dataString.substring(dataString.indexOf(" "));
    div.appendChild(text);

    div.className = `cell ${column.className}`;
    return div;
  }
}
