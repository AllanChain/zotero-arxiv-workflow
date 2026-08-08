import { config } from "../../../package.json";
import PQueue from "p-queue";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { arXivMerge } from "../arxiv-merge";
import { catchError } from "../error";
import {
  Fetcher,
  isKnownPreprintURL,
  PaperFinder,
  PaperIdentifier,
} from "./paper-finder";
import { UpdateStatus, UpdateTableData } from "../../types";

type SimpleUpdateStatus =
  "pending" | "processing" | "up-to-date" | "updated" | "error";
type ReportProgress = (status: UpdateStatus, msg?: string) => void;

export function simplifyUpdateStatus(status: UpdateStatus): SimpleUpdateStatus {
  switch (status) {
    case "pending":
      return "pending";
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

export function sortByStatusPriority(
  tableData: UpdateTableData[],
): UpdateTableData[] {
  const newTableData: UpdateTableData[] = [];
  for (const status of [
    "error",
    "processing",
    "pending",
    "updated",
    "up-to-date",
  ]) {
    for (const tableDatum of tableData) {
      if (simplifyUpdateStatus(tableDatum.status) === status) {
        newTableData.push(tableDatum);
      }
    }
  }
  return newTableData;
}

// Limit concurrent requests per host to avoid being rate-limited.
const hostQueues = new Map<string, PQueue>();
function hostQueue(host: string): PQueue {
  let queue = hostQueues.get(host);
  if (!queue) {
    queue = new PQueue({
      concurrency: 1,
      intervalCap: 1,
      interval: 1500,
    });
    hostQueues.set(host, queue);
  }
  return queue;
}

// Bound requests so a slow request can't hang the update queue.
// Zotero.HTTP (not bare `fetch`) routes through Zotero's proxy
// rewriting, which campus users rely on, and shares the translator
// framework's HTTP/proxy/cookie footing for follow-up requests.
// errorDelayMax: 30000 caps Zotero's 5xx retry backoff at 30s (default 1h)
// so a failing host can't stall the queue. throwOnTimeout: true is a runtime
// no-op (no queue timeout is set) but narrows p-queue add()'s return type to
// the task result instead of `TaskResultType | void`.
function requestBounded(
  url: string,
  options: { timeout?: number; responseType?: string } = {},
): Promise<XMLHttpRequest> {
  return hostQueue(new URL(url).hostname).add(
    () =>
      Zotero.HTTP.request("GET", url, {
        timeout: 15000,
        errorDelayMax: 30000,
        ...options,
      }),
    { throwOnTimeout: true },
  );
}

async function fetchTextBounded(url: string): Promise<string> {
  return (await requestBounded(url)).responseText!;
}

async function fetchJSONBounded<T = any>(url: string): Promise<T> {
  return JSON.parse((await requestBounded(url)).responseText!) as T;
}

// Fetcher implementation used by PaperFinder; routes through the per-host
// bounded queue above.
const fetcher: Fetcher = {
  fetchText: fetchTextBounded,
  fetchJSON: fetchJSONBounded,
};

async function createItemByZotero(
  paper: PaperIdentifier,
  collections: number[],
): Promise<Zotero.Item | false> {
  let translate;
  if (paper.doi) {
    translate = new Zotero.Translate.Search();
    translate.setIdentifier({ DOI: paper.doi });
    const translators = await translate.getTranslators();
    translate.setTranslator(translators);
  } else if (paper.url) {
    translate = new Zotero.Translate.Web();
    // Imports can re-hit a host (e.g. the DBLP BibTeX view used
    // for OpenReview records), so they share the per-host queue.
    const xhr = await requestBounded(paper.url, {
      timeout: 30000,
      responseType: "document",
    });
    const doc = Zotero.HTTP.wrapDocument(
      xhr.response as Document,
      xhr.responseURL || paper.url,
    );
    translate.setDocument(doc);
    const translators = await translate.getTranslators();
    translate.setTranslator(translators);
  }
  const pane = Zotero.getActiveZoteroPane()!;
  const libraryID = pane.getSelectedLibraryIDs
    ? pane.getSelectedLibraryIDs()[0]
    : pane.getSelectedLibraryID();
  const items = await translate.translate({
    libraryID,
    collections,
    saveAttachments: false, // we will do it later
  });
  if (items.length === 0) return false;
  return items[0];
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
            if (getPref("update.alwaysShowButton"))
              setVisible(isKnownPreprintItem.some(Boolean));
            else setVisible(isKnownPreprintItem.every(Boolean));
          },
        },
      ],
    });
  }

  static async update(
    preprintItem: Zotero.Item | Zotero.Item[],
    options: { openWindow?: boolean } = {},
  ) {
    arXivUpdate.createUpdateTasks(
      Array.isArray(preprintItem) ? preprintItem : [preprintItem],
    );
    arXivUpdate.sortTableData();
    const window = addon.data.arXivUpdate.window;
    const tableHelper = addon.data.arXivUpdate.tableHelper;
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
      addon.data.arXivUpdate.tableData =
        addon.data.arXivUpdate.tableData.filter((data) =>
          ["processing", "pending"].includes(simplifyUpdateStatus(data.status)),
        );
      if (options.openWindow ?? true) {
        arXivUpdate.openDialog();
      }
    }
  }

  static async updateItemWithProgress(
    preprintItem: Zotero.Item,
    reportProgress: ReportProgress,
  ) {
    ztoolkit.log(`Update task started for "${preprintItem.getDisplayTitle()}"`);
    reportProgress("finding-update");
    try {
      const paper = await new PaperFinder(preprintItem, fetcher).find();
      if (paper === undefined) return reportProgress("up-to-date");
      // Download published version
      reportProgress("downloading-metadata");
      const pane = Zotero.getActiveZoteroPane();
      const collections = pane?.getSelectedCollections
        ? pane.getSelectedCollections(true)
        : pane?.getSelectedCollection
          ? [pane.getSelectedCollection(true)]
          : [];
      const journalItem = await createItemByZotero(paper, collections);
      if (!journalItem) return reportProgress("download-error");
      journalItem.saveTx();

      let hasErrorDownloadingPDF = false;
      if (
        getPref("downloadJournalPDF") &&
        Zotero.Attachments.canFindPDFForItem(journalItem)
      ) {
        reportProgress("downloading-pdf");
        const attachment = await Zotero.Attachments.addAvailableFile(
          journalItem,
          // Only download from publisher
          { methods: ["doi"] },
        );
        if (attachment) {
          attachment.setField("title", paper.title);
          attachment.saveTx();
        } else {
          hasErrorDownloadingPDF = true;
        }
      }
      await arXivMerge.merge(preprintItem, journalItem, true);

      if (hasErrorDownloadingPDF) {
        reportProgress(
          "updated",
          getString("update-message", "download-pdf-error"),
        );
      } else {
        reportProgress("updated");
      }
    } catch (err) {
      ztoolkit.log(err);
      reportProgress(
        "general-error",
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unknown error",
      );
    }
  }

  static createUpdateTasks(preprintItems: Zotero.Item[]) {
    for (const preprintItem of preprintItems) {
      if (
        addon.data.arXivUpdate.tableData.findIndex(
          (data) => data.id === preprintItem.id,
        ) == -1
      ) {
        addon.data.arXivUpdate.tableData.push({
          id: preprintItem.id,
          title: preprintItem.getDisplayTitle(),
          status: "pending",
          message: undefined,
        });
        ztoolkit.log(
          `Enqueueing update task for "${preprintItem.getDisplayTitle()}" (queue size=${addon.data.arXivUpdate.queue.size}, pending=${addon.data.arXivUpdate.queue.pending})`,
        );
        addon.data.arXivUpdate.queue.add(() =>
          arXivUpdate.updateItemWithProgress(preprintItem, (status, msg) => {
            const data = addon.data.arXivUpdate.tableData.find(
              (item) => item.id === preprintItem.id,
            )!;
            data.status = status;
            data.message = msg;
            arXivUpdate.sortTableData();
          }),
        );
      } else {
        ztoolkit.log(
          `Item "${preprintItem.getDisplayTitle()}" already in update table`,
        );
      }
    }
  }

  static async openDialog() {
    const loadLock = Zotero.Promise.defer();
    const window = Zotero.getMainWindow().openDialog(
      `chrome://${config.addonRef}/content/update-dialog.xhtml`,
      "_blank",
      "chrome,scroll,centerscreen",
      { loadLock },
    )!;
    addon.data.arXivUpdate.window = window;
    window.addEventListener("DOMContentLoaded", () => loadLock.resolve());
    await loadLock.promise;

    addon.data.arXivUpdate.tableHelper = new ztoolkit.VirtualizedTable(window)
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
            renderer: arXivUpdate.renderStatusCell, // For Zotero 7.1+
            renderCell: arXivUpdate.renderStatusCell, // For Zotero 10+
          },
        ],
        containerWidth: 500,
        staticColumns: true,
        showHeader: true,
        multiSelect: false,
        getRowCount: () => addon.data.arXivUpdate.tableData.length,
        getRowData: (index) => {
          const data = addon.data.arXivUpdate.tableData[index];
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
        },
        onSelectionChange: (selection) => {
          const selectedRow = selection.selected.values().next().value;
          if (selectedRow === undefined) return;
          const paperId = addon.data.arXivUpdate.tableData[selectedRow].id;
          Zotero.getMainWindow()?.ZoteroPane.selectItem(paperId);
        },
        onActivate: (_, items) => {
          const paperId = addon.data.arXivUpdate.tableData[items[0]].id;
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
  }

  static renderStatusCell(
    index: number,
    dataString: string,
    column: _ZoteroTypes.ItemTreeManager.ItemTreeColumnOptions & {
      className: string;
    },
  ) {
    const document = addon.data.arXivUpdate.window?.document;
    if (!document) return;
    const colorMap: Record<SimpleUpdateStatus, string> = {
      pending: "#999999",
      processing: "#2ea8e5",
      updated: "#5fb236",
      "up-to-date": "#5fb236",
      error: "#ff6666",
    };
    const status = simplifyUpdateStatus(
      addon.data.arXivUpdate.tableData[index].status,
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

  static sortTableData() {
    const newTableData = sortByStatusPriority(addon.data.arXivUpdate.tableData);
    addon.data.arXivUpdate.tableData.splice(
      0,
      addon.data.arXivUpdate.tableData.length,
      ...newTableData,
    );
    addon.data.arXivUpdate.tableHelper?.treeInstance.invalidate();
  }
}
