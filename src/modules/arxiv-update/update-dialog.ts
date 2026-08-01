import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { UpdateStatus } from "../../types";
import { diffWords } from "diff";
import type { VirtualizedTableHelper } from "zotero-plugin-toolkit";

type SimpleUpdateStatus =
  | "pending"
  | "needs-confirmation"
  | "processing"
  | "up-to-date"
  | "updated"
  | "error";

const htmlNS = "http://www.w3.org/1999/xhtml";

function simplifyUpdateStatus(status: UpdateStatus): SimpleUpdateStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "needs-confirmation":
      return "needs-confirmation";
    case "finding-update":
    case "downloading-metadata":
    case "downloading-pdf":
      return "processing";
    case "up-to-date":
      return "up-to-date";
    case "updated":
      return "updated";
    case "download-error":
    case "general-error":
      return "error";
  }
}

export class UpdateDialog {
  /** Row id whose confirmation dialog is currently open; guards against stacking dialogs. */
  static openCandidateDialogId?: number;
  static window?: WindowProxy;
  static tableHelper?: VirtualizedTableHelper;
  /** Manager listener active while the update window is open. */
  static tableChangeListener?: () => void;

  private static get manager() {
    return addon.data.arXivUpdate.manager;
  }

  // Refresh the open progress window with the latest queue state, or clear
  // finished rows and reopen the window when it is not available.
  static refreshOrOpen(options: { openWindow?: boolean } = {}) {
    const window = UpdateDialog.window;
    const tableHelper = UpdateDialog.tableHelper;
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
      // Clear finished rows and reopen the window otherwise
      UpdateDialog.manager.retainActiveRows();
      if (options.openWindow ?? true) {
        UpdateDialog.open();
      }
    }
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
    // React to manager row changes while this window is open.
    UpdateDialog.tableChangeListener = () => UpdateDialog.refreshTable();
    UpdateDialog.manager.subscribe(UpdateDialog.tableChangeListener);
    window.addEventListener("DOMContentLoaded", () => loadLock.resolve());
    await loadLock.promise;

    // The window's initial about:blank document unloads as the XUL document
    // loads, so register the cleanup listener only after the load: from here
    // on, `unload` fires only when the window really closes.
    window.addEventListener("unload", () => {
      UpdateDialog.unsubscribeFromManager();
      UpdateDialog.window = undefined;
      UpdateDialog.tableHelper = undefined;
    });

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
            // Zotero renamed the column renderer hook from `renderer` to
            // `renderCell` in the item-tree refactor (Zotero 10 beta); old
            // builds check one and new builds check the other, so set both.
            // @ts-expect-error: renderer is not typed
            renderer: UpdateDialog.renderStatusCell, // For Zotero 7.1+
            renderCell: UpdateDialog.renderStatusCell,
          },
        ],
        containerWidth: 500,
        staticColumns: true,
        showHeader: true,
        multiSelect: false,
        getRowCount: () => UpdateDialog.manager.getRows().length,
        getRowData: (index) => {
          const data = UpdateDialog.manager.getRows()[index];
          let message = getString("update-status", data.status);
          if (data.message) {
            message += ": " + data.message;
          }
          // Use Emoji for Zotero < 7.1
          const emojiMap: Record<SimpleUpdateStatus, string> = {
            pending: "⚪",
            "needs-confirmation": "🟠",
            processing: "🔵",
            "up-to-date": "🟢",
            updated: "🟢",
            error: "🔴",
          };
          message = emojiMap[simplifyUpdateStatus(data.status)] + " " + message;
          return { title: data.title, status: message };
        },
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
        // Size the window to its content now that the table exists. Rows are
        // already kept in display order by the manager.
        (window.sizeToContentConstrained ?? window.sizeToContent)({
          prefWidth: 500,
          maxHeight: 300,
        });
      });
  }

  // Render one title line of the word-level diff between the preprint and
  // the candidate, coloring words that differ: preprint-only words are red,
  // candidate-only words green.
  static fillDiffLine(
    document: Document,
    container: Element,
    diff: ReturnType<typeof diffWords>,
    highlight: "removed" | "added",
  ) {
    for (const part of diff) {
      if (!part.added && !part.removed) {
        container.appendChild(document.createTextNode(part.value));
      } else if (
        (highlight === "removed" && part.removed) ||
        (highlight === "added" && part.added)
      ) {
        const b = document.createElementNS(htmlNS, "b") as HTMLElement;
        b.textContent = part.value;
        b.style.color =
          highlight === "removed" ? "var(--accent-red)" : "var(--accent-green)";
        container.appendChild(b);
      }
    }
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
    const data = UpdateDialog.manager.getRows()[index];

    const colorMap: Record<SimpleUpdateStatus, string> = {
      pending: "#999999",
      "needs-confirmation": "#f6c342",
      processing: "#2ea8e5",
      updated: "#5fb236",
      "up-to-date": "#5fb236",
      error: "#ff6666",
    };
    const status = simplifyUpdateStatus(data.status);
    const color = colorMap[status];

    const div = document.createElementNS(htmlNS, "div");
    div.className = `cell ${column.className}`;
    div.classList.add("status-cell");

    const swatch = document.createElementNS(htmlNS, "span") as HTMLElement;
    swatch.className = "tag-swatch";
    swatch.style.color = color;
    div.appendChild(swatch);

    const text = document.createElement("span");
    text.className = "status-message";
    div.appendChild(text);

    const paper = data.pendingPaper;
    const candidate = paper?.candidate;
    if (status === "needs-confirmation" && paper && candidate) {
      // The cell is marked `.clickable` so clicks on the link do not select
      // the row (see virtualized-table's capture handler). update-dialog.css
      // restores the normal cell layout, since Zotero styles `.clickable`
      // cells as centered button cells.
      div.classList.add("clickable");
      text.textContent = getString("review-prompt");
      const link = document.createElementNS(htmlNS, "a");
      link.className = "candidate-link";
      link.textContent = getString("review-action", "click-to-check");
      link.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const row = UpdateDialog.manager.getRows()[index];
        if (row?.status === "needs-confirmation") {
          void UpdateDialog.confirmCandidateWithDialog(row.id);
        }
      });
      div.append(text, document.createTextNode(" "), link);
    } else {
      // getRowData prepends an emoji circle for Zotero < 7.1; the swatch
      // replaces it here, so strip it together with the following space.
      text.textContent = dataString.substring(dataString.indexOf(" ") + 1);
    }
    return div;
  }

  /** React to manager row changes: rows are pre-sorted, so just re-render. */
  static refreshTable() {
    const window = UpdateDialog.window;
    if (window !== undefined && !window.closed) {
      UpdateDialog.tableHelper?.treeInstance.invalidate();
    }
  }

  private static unsubscribeFromManager() {
    const listener = UpdateDialog.tableChangeListener;
    if (listener) {
      UpdateDialog.manager.unsubscribe(listener);
      UpdateDialog.tableChangeListener = undefined;
    }
  }

  // Open the per-row confirmation dialog and route the answer. The dialog is
  // non-modal like the merge-confirm dialog: the row stays pending until the
  // user confirms, skips, or closes the dialog without choosing.
  static async confirmCandidateWithDialog(id: number) {
    // A single confirmation dialog at a time: ignore clicks while one is open
    // so double-clicks cannot stack dialogs for the same or other rows.
    if (UpdateDialog.openCandidateDialogId !== undefined) return;
    const data = UpdateDialog.manager.getRow(id);
    if (!data || data.status !== "needs-confirmation") return;
    const paper = data.pendingPaper;
    const candidate = paper?.candidate;
    if (!paper || !candidate) return;

    UpdateDialog.openCandidateDialogId = id;
    const loadLock = Zotero.Promise.defer();
    const answer = Zotero.Promise.defer();
    const window = Zotero.getMainWindow().openDialog(
      `chrome://${config.addonRef}/content/candidate-confirm.xhtml`,
      "_blank",
      "chrome,scroll,centerscreen",
      { loadLock, answer },
    )!;
    await loadLock.promise;

    // The dialog's initial about:blank document unloads as the XUL document
    // loads, so register the cleanup listener only after the load: from here
    // on, `unload` fires only when the dialog really closes.
    window.addEventListener("unload", () => {
      UpdateDialog.openCandidateDialogId = undefined;
    });
    if (window.closed) {
      // Closed while loading: clear the guard without acting.
      UpdateDialog.openCandidateDialogId = undefined;
      return;
    }

    // The row may have been confirmed or skipped while the window was
    // loading; close the dialog without acting in that case.
    const current = UpdateDialog.manager.getRow(id);
    const currentCandidate = current?.pendingPaper?.candidate;
    if (
      !current ||
      current.status !== "needs-confirmation" ||
      !currentCandidate
    ) {
      window.close();
      return;
    }

    window.document.title = getString("candidate-confirm-title");
    const diff = diffWords(current.title, currentCandidate.candidateTitle, {
      ignoreCase: true,
    });
    const preprintTitle = window.document.getElementById(
      `${config.addonRef}-preprint-title`,
    );
    if (preprintTitle) {
      UpdateDialog.fillDiffLine(
        window.document,
        preprintTitle,
        diff,
        "removed",
      );
    } else {
      ztoolkit.log(
        "Unable to display preprint title: missing candidate-confirm element",
      );
    }
    const candidateTitle = window.document.getElementById(
      `${config.addonRef}-candidate-title`,
    );
    if (candidateTitle) {
      UpdateDialog.fillDiffLine(window.document, candidateTitle, diff, "added");
    } else {
      ztoolkit.log(
        "Unable to display candidate title: missing candidate-confirm element",
      );
    }
    const meta = window.document.getElementById(
      `${config.addonRef}-candidate-meta`,
    );
    if (meta) {
      const source = getString(
        "review-candidate",
        currentCandidate.source.toLowerCase(),
      );
      meta.textContent = [
        source,
        currentCandidate.publication,
        currentCandidate.year,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    const linkContainer = window.document.getElementById(
      `${config.addonRef}-candidate-link`,
    ) as HTMLElement | null;
    if (linkContainer) {
      const candidateURL = currentCandidate.url;
      if (candidateURL) {
        const link = window.document.createElementNS(
          htmlNS,
          "a",
        ) as HTMLAnchorElement;
        link.className = "candidate-link";
        link.setAttribute("href", candidateURL);
        link.textContent = getString("review-action", "view-candidate");
        link.addEventListener("click", (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          Zotero.launchURL(candidateURL);
        });
        linkContainer.appendChild(link);
      } else {
        // No review link derivable for this candidate; keep the dialog
        // compact rather than showing a dead link.
        linkContainer.style.display = "none";
      }
    }
    const dialog = window.document.documentElement as unknown as {
      getButton(type: "accept" | "extra1"): { label: string };
    };
    dialog.getButton("accept").label = getString("review-action", "confirm");
    dialog.getButton("extra1").label = getString("review-action", "skip");

    const result = (await answer.promise) as unknown as
      "confirm" | "skip" | "cancel";
    window.close();
    UpdateDialog.openCandidateDialogId = undefined;
    if (result === "confirm") {
      await UpdateDialog.manager.confirm(id);
    } else if (result === "skip") {
      UpdateDialog.manager.skip(id);
    }
    // "cancel": the dialog was closed without choosing; leave the row pending.
  }
}
