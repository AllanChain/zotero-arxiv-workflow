import PQueue from "p-queue";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { arXivMerge } from "../arxiv-merge";
import { Fetcher, defaultFetcher, requestBounded } from "./fetcher";
import { PaperFinder, PaperIdentifier } from "./paper-finder";
import { UpdateStatus, UpdateTableData } from "../../types";
import { simplifyUpdateStatus, sortByStatusPriority } from "./status";

type ReportProgress = (status: UpdateStatus, msg?: string) => void;

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

/**
 * Injectable seams for UpdateManager. Production uses the defaults (the
 * bounded production fetcher and the translator-based import); tests pass
 * stubs so the whole update pipeline runs without the network.
 */
export interface UpdateManagerOptions {
  /** Network seam for the finder. Defaults to the bounded production fetcher. */
  fetcher?: Fetcher;
  /**
   * Creates the journal item from a found identifier. Defaults to
   * `createItemByZotero` (translator-based DOI/URL import).
   */
  createItem?: (
    paper: PaperIdentifier,
    collections: number[],
  ) => Promise<Zotero.Item | false>;
}

/**
 * Owns the update task queue and the row list backing the update dialog.
 * Rows are kept in display order; every mutation goes through the methods
 * here, which re-sort and notify `onChange` so the dialog can refresh.
 */
export class UpdateManager {
  unregisterObserver?: () => void;
  /** Set by the update dialog to refresh the open table on row changes. */
  onChange?: () => void;
  private tableData: UpdateTableData[] = [];
  private readonly fetcher: Fetcher;
  private readonly createItem: NonNullable<UpdateManagerOptions["createItem"]>;

  constructor(
    public queue: PQueue,
    options: UpdateManagerOptions = {},
  ) {
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.createItem = options.createItem ?? createItemByZotero;
  }

  /** The canonical row list. Read-only by convention; mutate through the methods here. */
  getRows(): UpdateTableData[] {
    return this.tableData;
  }

  createUpdateTasks(preprintItems: Zotero.Item[]) {
    for (const preprintItem of preprintItems) {
      if (
        this.tableData.findIndex((data) => data.id === preprintItem.id) == -1
      ) {
        this.tableData.push({
          id: preprintItem.id,
          title: preprintItem.getDisplayTitle(),
          status: "pending",
          message: undefined,
        });
        ztoolkit.log(
          `Enqueueing update task for "${preprintItem.getDisplayTitle()}" (queue size=${this.queue.size}, pending=${this.queue.pending})`,
        );
        this.queue.add(() =>
          this.updateItemWithProgress(preprintItem, (status, msg) =>
            this.updateRow(preprintItem.id, { status, message: msg }),
          ),
        );
      } else {
        ztoolkit.log(
          `Item "${preprintItem.getDisplayTitle()}" already in update table`,
        );
      }
    }
    this.sort();
    this.onChange?.();
  }

  /** The single row mutation path: apply a patch, keep rows sorted, notify. */
  updateRow(
    id: number,
    patch: Partial<Pick<UpdateTableData, "status" | "message">>,
  ) {
    const row = this.tableData.find((data) => data.id === id);
    if (!row) return;
    Object.assign(row, patch);
    this.sort();
    this.onChange?.();
  }

  /** Drop finished rows when the dialog is reopened. */
  filterInactive() {
    const active = this.tableData.filter((data) =>
      ["processing", "pending"].includes(simplifyUpdateStatus(data.status)),
    );
    if (active.length !== this.tableData.length) {
      this.tableData.splice(0, this.tableData.length, ...active);
      this.onChange?.();
    }
  }

  private sort() {
    const sorted = sortByStatusPriority(this.tableData);
    this.tableData.splice(0, this.tableData.length, ...sorted);
  }

  private async updateItemWithProgress(
    preprintItem: Zotero.Item,
    reportProgress: ReportProgress,
  ) {
    ztoolkit.log(`Update task started for "${preprintItem.getDisplayTitle()}"`);
    reportProgress("finding-update");
    try {
      const paper = await new PaperFinder(preprintItem, this.fetcher).find();
      if (paper === undefined) return reportProgress("up-to-date");
      // Download published version
      reportProgress("downloading-metadata");
      const pane = Zotero.getActiveZoteroPane();
      const collections = pane?.getSelectedCollections
        ? pane.getSelectedCollections(true)
        : pane?.getSelectedCollection
          ? [pane.getSelectedCollection(true)]
          : [];
      const journalItem = await this.createItem(paper, collections);
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
}
