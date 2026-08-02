import PQueue from "p-queue";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { requestBounded } from "../../utils/http";
import { arXivMerge } from "../arxiv-merge";
import {
  PaperIdentifier,
  UpdateTableData,
  isTentativePaperIdentifier,
} from "../../types";
import { STATUS_META } from "./status";

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
  const libraryID = Zotero.getActiveZoteroPane()!.getSelectedLibraryIDs()[0];
  const items = await translate.translate({
    libraryID,
    collections,
    saveAttachments: false, // we will do it later
  });
  if (items.length === 0) return false;
  return items[0];
}

/**
 * The published-version finders, as seen by the manager: resolve the
 * published version of a preprint, or its own arXiv self-update. Built at
 * the composition root so tests can inject fakes.
 */
export interface PaperFinderProvider {
  find(item: Zotero.Item): Promise<PaperIdentifier | undefined>;
  arXivPDF(item: Zotero.Item): Promise<PaperIdentifier | undefined>;
}

/** The persisted journal item of an import, and whether its PDF could not be downloaded. */
export interface ImportResult {
  journalItem: Zotero.Item;
  pdfError: boolean;
}

/**
 * The network boundary of the update flow: translate, persist, and download
 * the PDF of the published version. Injected so the confirm/skip flow can run
 * offline in tests; `undefined` means the import failed entirely.
 */
export type ImportStrategy = (
  paper: PaperIdentifier,
  collections: number[],
) => Promise<ImportResult | undefined>;

/**
 * Default `ImportStrategy`: translate the published record, persist it, and
 * download its PDF when configured. Network I/O lives here; status
 * transitions, the merge, and rollback stay in the manager.
 */
export async function importPublishedVersion(
  paper: PaperIdentifier,
  collections: number[],
): Promise<ImportResult | undefined> {
  const journalItem = await createItemByZotero(paper, collections);
  if (!journalItem) return undefined;
  journalItem.saveTx();
  let pdfError = false;
  if (
    getPref("downloadJournalPDF") &&
    Zotero.Attachments.canFindPDFForItem(journalItem)
  ) {
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
        pdfError = true;
      }
    } catch (err) {
      // The journal item is already persisted; remove it so a failed import
      // does not leave an orphan record in the library.
      await journalItem.eraseTx();
      throw err;
    }
  }
  return { journalItem, pdfError };
}

/**
 * Owns the update task queue and the row list backing the update window.
 * Rows are kept in display order; every mutation goes through `updateRow`,
 * which re-sorts and notifies listeners so the dialog can refresh itself.
 */
/**
 * Constructor dependencies of `UpdateManager`. `paperFinder` and
 * `importPublished` are the network seams (see `PaperFinderProvider` /
 * `ImportStrategy`); `log` replaces the ambient `ztoolkit.log` so the manager
 * holds no globals. `concurrency` keeps the previous queue option.
 */
export interface UpdateManagerDeps {
  concurrency?: number;
  paperFinder: PaperFinderProvider;
  importPublished: ImportStrategy;
  log: (...args: unknown[]) => void;
}

export class UpdateManager {
  private rows: UpdateTableData[] = [];
  private queue: PQueue;
  private listeners = new Set<() => void>();
  private deps: UpdateManagerDeps;

  constructor(options: UpdateManagerDeps) {
    this.deps = options;
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
        this.deps.log(
          `Enqueueing update task for "${preprintItem.getDisplayTitle()}" (queue size=${this.queue.size}, pending=${this.queue.pending})`,
        );
        this.queue.add(() => this.runTask(preprintItem));
      } else {
        this.deps.log(
          `Item "${preprintItem.getDisplayTitle()}" already in update table`,
        );
      }
    }
    this.notify();
  }

  /**
   * Resolve the row for a review action: validate it is awaiting confirmation,
   * clear its pending match, mark it processing, and return its item (or null
   * if the row is not reviewable / its item no longer exists).
   */
  private async resolveReviewAction(id: number): Promise<Zotero.Item | null> {
    const row = this.getRow(id);
    if (!row || row.status !== "needs-confirmation") return null;
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
      return null;
    }
    return preprintItem;
  }

  async confirm(id: number) {
    const paper = this.getRow(id)?.pendingPaper;
    const preprintItem = await this.resolveReviewAction(id);
    if (!preprintItem || !isTentativePaperIdentifier(paper)) return;
    // Run the import through the same queue as every other task so
    // concurrency is respected.
    this.queue.add(() => this.runTask(preprintItem, { initialPaper: paper }));
  }

  async skip(id: number) {
    const preprintItem = await this.resolveReviewAction(id);
    if (!preprintItem) return;
    // Skipping falls back to the preprint's own self-update (arXivPDF). Run
    // it through the same queue as every other task so concurrency is
    // respected; a failure is reported as a normal queue error. If the
    // self-update finds nothing, keep the preprint as-is.
    const skipped = getString("review-message", "skipped");
    if (getPref("updateSource.arXiv")) {
      this.queue.add(() =>
        this.runTask(preprintItem, {
          find: () => this.deps.paperFinder.arXivPDF(preprintItem),
          noPaperMessage: skipped,
        }),
      );
    } else {
      this.updateRow(id, {
        status: "up-to-date",
        message: skipped,
        pendingPaper: undefined,
      });
    }
  }

  /** Drop finished rows (used when the update window is reopened). */
  retainActiveRows() {
    this.rows = this.rows.filter((row) => STATUS_META[row.status].active);
    this.notify();
  }

  /**
   * Executes one update for a preprint. `initialPaper` short-circuits the
   * finder (used by confirm); otherwise `find` (defaulting to the configured
   * published-version finders) locates the paper. `noPaperMessage` is the
   * message shown when no paper is found. Every enqueue point funnels through
   * here so concurrency and error handling live in one place.
   */
  private async runTask(
    preprintItem: Zotero.Item,
    options: {
      initialPaper?: PaperIdentifier;
      find?: () => Promise<PaperIdentifier | undefined>;
      noPaperMessage?: string;
    } = {},
  ) {
    const id = preprintItem.id;
    this.deps.log(
      `Update task started for "${preprintItem.getDisplayTitle()}"`,
    );
    this.updateRow(id, { status: "finding-update" });
    try {
      const find =
        options.find ?? (() => this.deps.paperFinder.find(preprintItem));
      const paper = options.initialPaper ?? (await find());
      if (paper === undefined) {
        this.updateRow(id, {
          status: "up-to-date",
          message: options.noPaperMessage,
          pendingPaper: undefined,
        });
        return;
      }
      if (!options.initialPaper && isTentativePaperIdentifier(paper)) {
        // Fuzzy matches are not imported automatically; the user confirms
        // them in the batch review window after the queue drains.
        this.deps.log(
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
      this.deps.log(err);
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
    const collections =
      Zotero.getActiveZoteroPane()?.getSelectedCollections(true) ?? [];
    // The import strategy (translate + persist + PDF) is the injected network
    // boundary; status transitions, the merge, and rollback stay here.
    const result = await this.deps.importPublished(paper, collections);
    if (!result) {
      this.updateRow(id, { status: "download-error" });
      return;
    }
    const { journalItem, pdfError } = result;
    try {
      await arXivMerge.merge(preprintItem, journalItem, true);
    } catch (err) {
      // The journal item is already persisted; remove it so a failed merge
      // does not leave an orphan record in the library.
      await journalItem.eraseTx();
      throw err;
    }
    this.updateRow(id, {
      status: "updated",
      message: pdfError
        ? getString("update-message", "download-pdf-error")
        : undefined,
    });
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
    // `Array.prototype.sort` is stable, so rows with the same rank keep
    // their insertion order.
    this.rows.sort(
      (a, b) => STATUS_META[a.status].rank - STATUS_META[b.status].rank,
    );
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
