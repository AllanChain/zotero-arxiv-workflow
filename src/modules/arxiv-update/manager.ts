import PQueue from "p-queue";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { arXivMerge } from "../arxiv-merge";
import { Fetcher, defaultFetcher, requestBounded } from "./fetcher";
import { PaperFinder } from "./paper-finder";
import {
  FinderIterator,
  PaperIdentifier,
  TentativePaperIdentifier,
  UpdateStatus,
  UpdateTableData,
} from "../../types";
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

/** Options of one queued update task. */
type TaskOptions = {
  /** Import this paper directly instead of running the finder (confirm). */
  paper?: PaperIdentifier;
  /** Resume this finder where it paused (skip). */
  iterator?: FinderIterator;
  /** Message shown when the finder ends without a paper. */
  noPaperMessage?: string;
};

/** A paused review: the candidate the user is confirming, and the finder to resume on skip. */
type Review = {
  item: Zotero.Item;
  paper: TentativePaperIdentifier;
  iterator: FinderIterator;
};

/**
 * Owns the update task queue and the row list backing the update dialog.
 * Rows are kept in display order; every mutation goes through the methods
 * here, which re-sort and notify `onChange` so the dialog can refresh.
 *
 * Queue discipline: a task that lands on `needs-confirmation` ends there —
 * it parks the review in `reviews` and returns, releasing its concurrency
 * slot, so waiting rows never block other items. Confirm and skip never do
 * work inline; both re-enter through the queue.
 */
export class UpdateManager {
  unregisterObserver?: () => void;
  /** Set by the update dialog to refresh the open table on row changes. */
  onChange?: () => void;
  private tableData: UpdateTableData[] = [];
  private readonly fetcher: Fetcher;
  private readonly createItem: NonNullable<UpdateManagerOptions["createItem"]>;
  /**
   * Paused reviews keyed by item id; a row is in `needs-confirmation` iff
   * it has an entry. Read-only by convention — entries are created by the
   * task body and deleted by confirm/skip.
   */
  readonly reviews = new Map<number, Review>();

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

  getRow(id: number): UpdateTableData | undefined {
    return this.tableData.find((data) => data.id === id);
  }

  /** The candidate awaiting confirmation for the item, if any. */
  getPendingPaper(id: number): TentativePaperIdentifier | undefined {
    return this.reviews.get(id)?.paper;
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
        this.runTask(preprintItem);
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

  /** Drop finished rows when the dialog is reopened; pending confirmations are kept. */
  filterInactive() {
    const active = this.tableData.filter((data) =>
      ["processing", "pending", "needs-confirmation"].includes(
        simplifyUpdateStatus(data.status),
      ),
    );
    if (active.length !== this.tableData.length) {
      this.tableData.splice(0, this.tableData.length, ...active);
      this.onChange?.();
    }
  }

  /**
   * Confirm the paused candidate: import exactly what the user approved.
   * The paused finder is discarded — resuming it is only meaningful when
   * the candidate was rejected (see skip). The import runs through the
   * queue so it stays throttled with the other tasks.
   */
  async confirm(id: number) {
    const review = this.reviews.get(id);
    if (!review) return;
    this.reviews.delete(id);
    this.runTask(review.item, { paper: review.paper });
  }

  /**
   * Skip the paused candidate: resume the finder, which decides what to try
   * next (currently the arXiv self-update, but the manager does not need to
   * know the stage list).
   */
  async skip(id: number) {
    const review = this.reviews.get(id);
    if (!review) return;
    this.reviews.delete(id);
    this.runTask(review.item, {
      iterator: review.iterator,
      noPaperMessage: getString("review-message", "skipped"),
    });
  }

  private sort() {
    const sorted = sortByStatusPriority(this.tableData);
    this.tableData.splice(0, this.tableData.length, ...sorted);
  }

  /** The single enqueue point: every task funnels through here. */
  private runTask(preprintItem: Zotero.Item, options: TaskOptions = {}) {
    this.queue.add(() =>
      this.updateItemWithProgress(
        preprintItem,
        (status, message) =>
          this.updateRow(preprintItem.id, { status, message }),
        options,
      ),
    );
  }

  private async updateItemWithProgress(
    preprintItem: Zotero.Item,
    reportProgress: ReportProgress,
    options: TaskOptions = {},
  ) {
    ztoolkit.log(`Update task started for "${preprintItem.getDisplayTitle()}"`);
    try {
      reportProgress("finding-update");
      if (options.paper) {
        await this.importPaper(preprintItem, options.paper, reportProgress);
        return;
      }
      const iterator =
        options.iterator ?? new PaperFinder(preprintItem, this.fetcher).find();
      const step = await iterator.next();
      if (!step.done) {
        // The finder paused for confirmation; park the candidate and the
        // finder until the user confirms or skips.
        this.reviews.set(preprintItem.id, {
          item: preprintItem,
          paper: step.value,
          iterator,
        });
        return reportProgress("needs-confirmation");
      }
      if (!step.value) {
        return reportProgress("up-to-date", options.noPaperMessage);
      }
      await this.importPaper(preprintItem, step.value, reportProgress);
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

  /** Import, merge, and report progress for a final paper. */
  private async importPaper(
    preprintItem: Zotero.Item,
    paper: PaperIdentifier,
    reportProgress: ReportProgress,
  ) {
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
      try {
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
      } catch (err) {
        // The journal item is already persisted; remove it so a failed
        // import does not leave an orphan record in the library.
        await journalItem.eraseTx();
        throw err;
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
  }
}
