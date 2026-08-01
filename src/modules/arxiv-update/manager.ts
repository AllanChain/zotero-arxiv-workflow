import PQueue from "p-queue";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { requestBounded } from "../../utils/http";
import { arXivMerge } from "../arxiv-merge";
import { PaperIdentifier, UpdateStatus, UpdateTableData } from "../../types";
import { PaperFinder } from "./paper-finder";

/**
 * Display priority for each raw status: rows with a lower rank come first.
 * The manager keeps the row list in this order, so the dialog never needs to
 * re-sort. `Array.prototype.sort` is stable, so rows with the same status
 * keep their insertion order.
 */
const STATUS_PRIORITY: Record<UpdateStatus, number> = {
  "download-error": 0,
  "general-error": 0,
  "needs-confirmation": 1,
  "finding-update": 2,
  "downloading-metadata": 2,
  "downloading-pdf": 2,
  pending: 3,
  updated: 4,
  "up-to-date": 4,
};

/** Statuses that keep their row when the update window is reopened. */
const ACTIVE_STATUSES: UpdateStatus[] = [
  "pending",
  "finding-update",
  "downloading-metadata",
  "downloading-pdf",
  "needs-confirmation",
];

function errorMessage(err: unknown): string {
  return err instanceof Error
    ? err.message
    : typeof err === "string"
      ? err
      : "Unknown error";
}

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
  const libraryID = Zotero.getActiveZoteroPane()!.getSelectedLibraryID();
  const items = await translate.translate({
    libraryID,
    collections,
    saveAttachments: false, // we will do it later
  });
  if (items.length === 0) return false;
  return items[0];
}

/**
 * Owns the update task queue and the row list backing the update window.
 * Rows are kept in display order; every mutation goes through `updateRow`,
 * which re-sorts and notifies listeners so the dialog can refresh itself.
 */
export class UpdateManager {
  private rows: UpdateTableData[] = [];
  private queue: PQueue;
  private listeners = new Set<() => void>();

  constructor(options: { concurrency?: number } = {}) {
    this.queue = new PQueue({ concurrency: options.concurrency });
  }

  /** The canonical row list. Read-only by convention; only this class mutates it. */
  getRows(): UpdateTableData[] {
    return this.rows;
  }

  getRow(id: number): UpdateTableData | undefined {
    return this.rows.find((row) => row.id === id);
  }

  setConcurrency(concurrency: number) {
    this.queue.concurrency = concurrency;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
  }

  unsubscribe(listener: () => void) {
    this.listeners.delete(listener);
  }

  /** Clear all rows, queued tasks, and listeners (used by tests). */
  reset() {
    this.rows = [];
    this.queue.clear();
    this.listeners.clear();
  }

  enqueue(preprintItems: Zotero.Item[]) {
    for (const preprintItem of preprintItems) {
      if (this.rows.findIndex((row) => row.id === preprintItem.id) === -1) {
        this.rows.push({
          id: preprintItem.id,
          title: preprintItem.getDisplayTitle(),
          status: "pending",
          message: undefined,
        });
        ztoolkit.log(
          `Enqueueing update task for "${preprintItem.getDisplayTitle()}" (queue size=${this.queue.size}, pending=${this.queue.pending})`,
        );
        this.queue.add(() => this.runTask(preprintItem));
      } else {
        ztoolkit.log(
          `Item "${preprintItem.getDisplayTitle()}" already in update table`,
        );
      }
    }
    this.notify();
  }

  /**
   * Confirm a fuzzy match: mark the row as processing, then run the import
   * through the same queue as every other task so concurrency is respected.
   */
  async confirm(id: number) {
    const row = this.getRow(id);
    if (!row || row.status !== "needs-confirmation") return;
    const paper = row.pendingPaper;
    if (!paper) return;
    this.updateRow(id, {
      status: "finding-update",
      message: undefined,
      pendingPaper: undefined,
    });
    const preprintItem = await Zotero.Items.getAsync(id);
    if (!preprintItem) {
      this.updateRow(id, {
        status: "general-error",
        message: "Item not found",
      });
      return;
    }
    this.queue.add(() => this.runTask(preprintItem, paper));
  }

  skip(id: number) {
    const row = this.getRow(id);
    if (!row || row.status !== "needs-confirmation") return;
    this.updateRow(id, {
      status: "up-to-date",
      message: getString("review-message", "skipped"),
      pendingPaper: undefined,
    });
  }

  /** Drop finished rows (used when the update window is reopened). */
  retainActiveRows() {
    this.rows = this.rows.filter((row) => ACTIVE_STATUSES.includes(row.status));
    this.notify();
  }

  private async runTask(
    preprintItem: Zotero.Item,
    confirmedPaper?: PaperIdentifier,
  ) {
    const id = preprintItem.id;
    ztoolkit.log(`Update task started for "${preprintItem.getDisplayTitle()}"`);
    this.updateRow(id, { status: "finding-update" });
    try {
      const paper =
        confirmedPaper ?? (await new PaperFinder(preprintItem).find());
      if (paper === undefined) {
        this.updateRow(id, { status: "up-to-date" });
        return;
      }
      if (!confirmedPaper && paper.tentative) {
        // Fuzzy matches are not imported automatically; the user confirms
        // them in the batch review window after the queue drains.
        ztoolkit.log(
          `Tentative match for "${preprintItem.getDisplayTitle()}": awaiting confirmation`,
        );
        this.updateRow(id, {
          status: "needs-confirmation",
          pendingPaper: paper,
        });
        return;
      }
      await this.importAndMerge(preprintItem, paper, id);
    } catch (err) {
      ztoolkit.log(err);
      this.updateRow(id, {
        status: "general-error",
        message: errorMessage(err),
      });
    }
  }

  private async importAndMerge(
    preprintItem: Zotero.Item,
    paper: PaperIdentifier,
    id: number,
  ) {
    // Download published version
    this.updateRow(id, { status: "downloading-metadata" });
    const collection = Zotero.getActiveZoteroPane()?.getSelectedCollection();
    let collections: number[] = [];
    if (collection) {
      collections = [collection.id];
    }
    const journalItem = await createItemByZotero(paper, collections);
    if (!journalItem) {
      this.updateRow(id, { status: "download-error" });
      return;
    }
    journalItem.saveTx();

    let hasErrorDownloadingPDF = false;
    if (
      getPref("downloadJournalPDF") &&
      Zotero.Attachments.canFindPDFForItem(journalItem)
    ) {
      this.updateRow(id, { status: "downloading-pdf" });
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
      this.updateRow(id, {
        status: "updated",
        message: getString("update-message", "download-pdf-error"),
      });
    } else {
      this.updateRow(id, { status: "updated" });
    }
  }

  /** The single mutation path: update a row, keep rows sorted, notify. */
  private updateRow(
    id: number,
    patch: Partial<
      Pick<UpdateTableData, "status" | "message" | "pendingPaper">
    >,
  ) {
    const row = this.getRow(id);
    if (!row) return;
    Object.assign(row, patch);
    this.rows.sort(
      (a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status],
    );
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
