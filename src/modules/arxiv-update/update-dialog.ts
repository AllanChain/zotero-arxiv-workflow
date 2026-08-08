import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import type { VirtualizedTableHelper } from "zotero-plugin-toolkit";
import { UpdateManager } from "./manager";
import { simplifyUpdateStatus, type SimpleUpdateStatus } from "./status";

/**
 * Owns the update dialog window and table. All row state lives in
 * UpdateManager; this class only renders it and subscribes to changes.
 */
export class UpdateDialog {
  static window?: WindowProxy;
  static tableHelper?: VirtualizedTableHelper;

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
          if (selectedRow === undefined) return;
          const paperId = UpdateDialog.manager.getRows()[selectedRow].id;
          Zotero.getMainWindow()?.ZoteroPane.selectItem(paperId);
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
      .render(-1, () => {
        (window.sizeToContentConstrained ?? window.sizeToContent)({
          prefWidth: 500,
          maxHeight: 300,
        });
      });

    // Keep the open table in sync with row changes (status updates, sorting).
    UpdateDialog.manager.onChange = () =>
      UpdateDialog.tableHelper?.treeInstance.invalidate();
  }

  static refreshOrOpen(options: { openWindow?: boolean } = {}) {
    const { window, tableHelper } = UpdateDialog;
    ztoolkit.log(
      `Update dialog state: window=${window !== undefined}, closed=${window?.closed}, table=${tableHelper !== undefined}`,
    );
    if (window !== undefined && !window.closed && tableHelper !== undefined) {
      // Simply update data if window is open and valid
      tableHelper.treeInstance.invalidate();
      (window.sizeToContentConstrained ?? window.sizeToContent)({
        prefWidth: 500,
        maxHeight: 300,
      });
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
    const emojiMap: Record<SimpleUpdateStatus, string> = {
      pending: "⚪",
      processing: "🔵",
      "up-to-date": "🟢",
      updated: "🟢",
      error: "🔴",
    };
    message = emojiMap[simplifyUpdateStatus(data.status)] + " " + message;
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
    if (!document) return;
    const colorMap: Record<SimpleUpdateStatus, string> = {
      pending: "#999999",
      processing: "#2ea8e5",
      updated: "#5fb236",
      "up-to-date": "#5fb236",
      error: "#ff6666",
    };
    const status = simplifyUpdateStatus(
      UpdateDialog.manager.getRows()[index].status,
    );
    const color = colorMap[status];

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
