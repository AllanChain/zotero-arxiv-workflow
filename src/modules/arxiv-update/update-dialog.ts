import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { diffWords } from "diff";
import type { VirtualizedTableHelper } from "zotero-plugin-toolkit";
import { UpdateManager } from "./manager";
import { TentativePaperIdentifier } from "../../types";
import { simplifyUpdateStatus, type SimpleUpdateStatus } from "./status";

const htmlNS = "http://www.w3.org/1999/xhtml";

/**
 * Owns the update dialog window and table. All row state lives in
 * UpdateManager; this class only renders it and subscribes to changes.
 */
export class UpdateDialog {
  static window?: WindowProxy;
  static tableHelper?: VirtualizedTableHelper;
  /**
   * The last confirmation dialog opened, kept only to ignore clicks while it
   * is still on screen. Written once when the dialog opens and never cleared:
   * `window.closed` is what reports whether it still blocks, so stale entries
   * are harmless and no cleanup path can race with a newer dialog.
   */
  static openCandidateDialog?: WindowProxy;

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
      "needs-confirmation": "🟠",
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
    const manager = UpdateDialog.manager;
    if (!document || !manager) return;
    const data = manager.getRows()[index];
    const colorMap: Record<SimpleUpdateStatus, string> = {
      pending: "#999999",
      processing: "#2ea8e5",
      "needs-confirmation": "#f6c342",
      updated: "#5fb236",
      "up-to-date": "#5fb236",
      error: "#ff6666",
    };
    const color = colorMap[simplifyUpdateStatus(data.status)];

    // A row in `needs-confirmation` always has a pending candidate in the
    // manager's review state (the two are updated together), so the status
    // check alone decides which cell to render.
    const paper = manager.getPendingPaper(data.id);
    if (data.status === "needs-confirmation" && paper) {
      // The cell is marked `.clickable` so clicks on the link do not select
      // the row (see virtualized-table's capture handler). update-dialog.css
      // restores the normal cell layout, since Zotero styles `.clickable`
      // cells as centered button cells.
      const div = document.createElementNS(htmlNS, "div");
      div.className = `cell ${column.className} clickable status-cell`;

      const swatch = document.createElementNS(htmlNS, "span") as HTMLElement;
      swatch.className = "tag-swatch";
      swatch.style.color = color;
      div.appendChild(swatch);

      const text = document.createElementNS(htmlNS, "span");
      text.className = "status-message";
      text.textContent = getString("review-prompt");
      div.appendChild(text);

      const link = document.createElementNS(htmlNS, "a");
      link.className = "candidate-link";
      link.textContent = getString("review-action", "click-to-check");
      // Bind the click to this row's id, not to `index`: rows are re-sorted on
      // every status change, so by click time `index` may name another row.
      const rowId = data.id;
      link.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const row = manager.getRow(rowId);
        if (row?.status === "needs-confirmation") {
          void UpdateDialog.confirmCandidateWithDialog(row.id);
        }
      });
      div.append(text, document.createTextNode(" "), link);
      return div;
    }

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

  // Open the per-row confirmation dialog and route the answer. The dialog is
  // non-modal like the merge-confirm dialog: the row stays pending until the
  // user confirms, skips, or closes the dialog without choosing.
  static async confirmCandidateWithDialog(id: number) {
    // Ignore clicks while a confirmation dialog is still on screen, so a
    // double-click cannot stack two of them (for this row or for another).
    if (
      UpdateDialog.openCandidateDialog &&
      !UpdateDialog.openCandidateDialog.closed
    ) {
      return;
    }
    const manager = UpdateDialog.manager;
    const data = manager.getRow(id);
    if (!data || data.status !== "needs-confirmation") return;
    const paper = manager.getPendingPaper(id);
    if (!paper) return;

    const loadLock = Zotero.Promise.defer();
    const answer = Zotero.Promise.defer();
    const window = Zotero.getMainWindow().openDialog(
      `chrome://${config.addonRef}/content/candidate-confirm.xhtml`,
      "_blank",
      "chrome,scroll,centerscreen",
      { loadLock, answer },
    )!;
    UpdateDialog.openCandidateDialog = window;
    // A dialog that never finishes loading must not block the feature
    // forever: give the load a bound, then bail out.
    const loadTimeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 10000),
    );
    const loaded = await Promise.race([
      loadLock.promise.then(() => "loaded" as const),
      loadTimeout,
    ]);
    if (loaded === "timeout") {
      window.close();
      return;
    }
    if (window.closed) {
      // Closed while loading, so its script never ran and `answer` would never
      // resolve; there is nothing to act on.
      return;
    }

    // The row may have been confirmed or skipped while the window was
    // loading; close the dialog without acting in that case.
    const current = manager.getRow(id);
    const currentPaper = manager.getPendingPaper(id);
    if (!current || current.status !== "needs-confirmation" || !currentPaper) {
      window.close();
      return;
    }
    try {
      UpdateDialog.fillCandidateWindow(window, current.title, currentPaper);
    } catch (e) {
      // A dialog that cannot be filled is worse than no dialog at all: close
      // it and leave the row awaiting confirmation, so the user can retry.
      ztoolkit.log("Unable to fill the candidate confirmation dialog:", e);
      window.close();
      return;
    }

    const result = (await answer.promise) as unknown as
      "confirm" | "skip" | "cancel";
    window.close();
    if (result === "confirm") {
      await manager.confirm(id);
    } else if (result === "skip") {
      await manager.skip(id);
    }
    // "cancel": the dialog was closed without choosing; leave the row pending.
  }

  /** Fill the candidate-confirm window with the row's pending candidate. */
  private static fillCandidateWindow(
    window: WindowProxy,
    preprintTitleText: string,
    paper: TentativePaperIdentifier,
  ) {
    const candidate = paper.candidate;

    window.document.title = getString("candidate-confirm-title");
    const diff = diffWords(preprintTitleText, candidate.candidateTitle, {
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
        candidate.source.toLowerCase(),
      );
      meta.textContent = [source, candidate.publication, candidate.year]
        .filter(Boolean)
        .join(" · ");
    }
    const linkContainer = window.document.getElementById(
      `${config.addonRef}-candidate-link`,
    ) as HTMLElement | null;
    if (linkContainer) {
      const candidateURL = candidate.url;
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
    // Localize the button labels last and non-fatally: the XUL defaults
    // already read "Confirm" / "Skip", so a root without `getButton` still
    // leaves a usable dialog instead of throwing away the candidate.
    const dialog = window.document.documentElement as unknown as {
      getButton?: (type: "accept" | "extra1") => { label: string } | undefined;
    };
    const accept = dialog?.getButton?.("accept");
    if (accept) accept.label = getString("review-action", "confirm");
    const skip = dialog?.getButton?.("extra1");
    if (skip) skip.label = getString("review-action", "skip");
  }
}
