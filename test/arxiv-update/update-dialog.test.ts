import { assert } from "chai";
import PQueue from "p-queue";
import type { VirtualizedTableHelper } from "zotero-plugin-toolkit";
import type Addon from "@/addon";
import { config } from "@pkg";
import { arXivUpdate, isUpdateMenuVisible } from "@/modules/arxiv-update";
import { UpdateManager } from "@/modules/arxiv-update/manager";
import { UpdateDialog } from "@/modules/arxiv-update/update-dialog";
import type {
  FinderIterator,
  PaperIdentifier,
  TentativePaperIdentifier,
  UpdateTableData,
} from "@/types";
import { getString } from "@/utils/locale";
import { clearLibrary, getPlugin, setPluginPref } from "@test/helpers";
import {
  createFetcher,
  createJournalItem,
  createPreprintItem,
  createUpdateManager,
  getItem,
  resetUpdateSourcePrefs,
} from "./helpers";

type StatusColumn = Parameters<typeof UpdateDialog.renderStatusCell>[2];

describe("update-dialog", function () {
  this.timeout(60000);

  let plugin: Addon;
  let originalManager: UpdateManager;

  before(function () {
    plugin = getPlugin();
    assert.isDefined(plugin, "Plugin should be initialized");
    originalManager = addon.data.arXivUpdate.manager;
  });

  afterEach(async function () {
    setPluginPref("downloadJournalPDF", true);
    resetUpdateSourcePrefs();
    // Close any candidate-confirm dialogs opened during the test and clear
    // the guard, so a stale dialog cannot leak into the next test.
    for (const dialog of findCandidateDialogs()) {
      dialog.close();
    }
    UpdateDialog.openCandidateDialog = undefined;
    // Close any dialog opened during the test and reset its statics. Fake
    // windows used to stub rendering have no `close`; guard the call.
    if (UpdateDialog.window && !UpdateDialog.window.closed) {
      UpdateDialog.window.close?.();
    }
    UpdateDialog.window = undefined;
    UpdateDialog.tableHelper = undefined;
    addon.data.arXivUpdate.manager = originalManager;
    await clearLibrary();
  });

  // Captures enqueued tasks without executing them, so tests never touch
  // the network. The manager logs `queue.size`/`queue.pending`; both are 0
  // because no task is ever run.
  function capturingQueue() {
    const tasks: Array<() => unknown> = [];
    return {
      queue: {
        add: (fn: () => unknown) => {
          tasks.push(fn);
        },
        size: 0,
        pending: 0,
      },
      tasks,
    };
  }

  function testManager() {
    const { queue, tasks } = capturingQueue();
    const manager = new UpdateManager(queue as unknown as PQueue);
    return { manager, tasks };
  }

  // Point the dialog (which reads `addon.data.arXivUpdate.manager`) at a
  // fresh manager with a capturing queue for the duration of the test.
  function useManager(manager: UpdateManager) {
    addon.data.arXivUpdate.manager = manager;
    return manager;
  }

  // Poll the real dialog until a row renders the given status message. The
  // dialog opens asynchronously and the task runs in the background, so the
  // status text (locale-independent via getString) is the sync point.
  function waitForStatusMessage(
    text: string,
    timeout = 15000,
  ): Promise<WindowProxy> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      const timer = setInterval(() => {
        const w = UpdateDialog.window;
        if (w && !w.closed) {
          const messages = w.document.querySelectorAll(
            `#${config.addonRef}-status-table .status-message`,
          );
          for (const el of messages) {
            if ((el as HTMLElement).innerText.includes(text)) {
              clearInterval(timer);
              resolve(w);
              return;
            }
          }
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`update dialog never showed status "${text}"`));
        }
      }, 100);
    });
  }

  function waitForDialogRows(
    minRows: number,
    timeout = 15000,
  ): Promise<WindowProxy> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      const timer = setInterval(() => {
        const w = UpdateDialog.window;
        if (w && !w.closed) {
          const rows = w.document.querySelectorAll(
            `#${config.addonRef}-status-table .row`,
          );
          if (rows.length >= minRows) {
            clearInterval(timer);
            resolve(w);
            return;
          }
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error("update dialog never rendered rows"));
        }
      }, 100);
    });
  }

  // Build a row that is awaiting confirmation of a fuzzy candidate, seeding
  // the manager's reviews with the candidate and a small paused iterator
  // (resumed only on skip, like a real finder's post-pause stages).
  function candidate(
    manager: UpdateManager,
    id: number,
    title: string,
    source: "DBLP" | "PubMed" = "DBLP",
    candidateTitle?: string,
    url?: string | null, // `null` explicitly means "no review link"
    fallback?: PaperIdentifier, // returned if the user skips the candidate
  ): UpdateTableData {
    const paper: TentativePaperIdentifier = {
      doi: `10.5555/example-doi-${id}`,
      title: "Published PDF",
      tentative: true,
      candidate: {
        source,
        candidateTitle: candidateTitle ?? `${title} (Published Version)`,
        publication: source === "DBLP" ? "ICLR" : "Some Journal",
        year: "2024",
        score: 0.9,
        url:
          url === null
            ? undefined
            : (url ??
              (source === "DBLP"
                ? `https://dblp.org/rec/conf/iclr/example-${id}.html`
                : `https://pubmed.ncbi.nlm.nih.gov/30000000${id}/`)),
      },
    };
    // This fake pipeline is already paused at the confirmation point. A
    // confirmation never resumes it (the approved candidate is imported
    // directly), so the next call — from skip — supplies the fallback.
    let resumed = false;
    const iterator = {
      async next(): Promise<
        IteratorResult<never, PaperIdentifier | undefined>
      > {
        if (resumed) return { done: true, value: undefined };
        resumed = true;
        return { done: true, value: fallback };
      },
      async return(): Promise<
        IteratorResult<never, PaperIdentifier | undefined>
      > {
        return { done: true, value: undefined };
      },
      async throw(
        err?: unknown,
      ): Promise<IteratorResult<never, PaperIdentifier | undefined>> {
        throw err;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    } as FinderIterator;
    manager.reviews.set(id, {
      item: Zotero.Items.get(id)!,
      paper,
      iterator,
    });
    return {
      id,
      title,
      status: "needs-confirmation",
    };
  }

  // Find open candidate-confirm windows. With `requireFilled`, only windows
  // whose title line has been rendered count.
  function findCandidateDialogs(requireFilled = false): WindowProxy[] {
    const wm = Services.wm;
    const enumerator = wm.getEnumerator("");
    const dialogs: WindowProxy[] = [];
    while (enumerator.hasMoreElements()) {
      const w = enumerator.getNext() as unknown as WindowProxy;
      if (w.closed) continue;
      const title = w.document?.getElementById(
        `${config.addonRef}-preprint-title`,
      );
      if (title && (!requireFilled || title.hasChildNodes())) {
        dialogs.push(w);
      }
    }
    return dialogs;
  }

  // Wait for the candidate-confirm dialog to be open and filled with content.
  async function waitForCandidateDialog(): Promise<WindowProxy> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const timer = setInterval(() => {
        const dialogs = findCandidateDialogs(true);
        if (dialogs.length > 0) {
          clearInterval(timer);
          resolve(dialogs[0]!);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error("candidate dialog never rendered"));
        }
      }, 100);
    });
  }

  async function waitForCondition(
    description: string,
    condition: () => boolean,
    timeout = 10000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      const timer = setInterval(() => {
        if (condition()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`timeout waiting for ${description}`));
        }
      }, 50);
    });
  }

  function dialogButton(
    dialog: WindowProxy,
    type: "accept" | "extra1",
  ): { label: string; click(): void } {
    return (
      dialog.document.documentElement as unknown as {
        getButton(type: string): { label: string; click(): void };
      }
    ).getButton(type);
  }

  async function clickLinkAndWait(
    win: WindowProxy,
    rowIndex = 0,
  ): Promise<WindowProxy> {
    const link = win.document.querySelectorAll<HTMLElement>(
      `#${config.addonRef}-status-table .row .cell.clickable .candidate-link`,
    )[rowIndex]!;
    link.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    return waitForCandidateDialog();
  }

  describe("isUpdateMenuVisible", function () {
    it("shows when any item qualifies if alwaysShowButton is on", function () {
      assert.isTrue(isUpdateMenuVisible([true, false], true));
    });

    it("hides when no item qualifies even with alwaysShowButton", function () {
      assert.isFalse(isUpdateMenuVisible([false], true));
    });

    it("requires every item to qualify otherwise", function () {
      assert.isFalse(isUpdateMenuVisible([true, false], false));
      assert.isTrue(isUpdateMenuVisible([true, true], false));
    });
  });

  describe("UpdateManager.createUpdateTasks", function () {
    it("adds a pending row per new item and dedupes", async function () {
      const { manager, tasks } = testManager();
      const item = await createPreprintItem();
      manager.createUpdateTasks([item, item]);
      assert.lengthOf(manager.getRows(), 1);
      assert.deepEqual(manager.getRows()[0], {
        id: item.id,
        title: "Test paper",
        status: "pending",
        message: undefined,
      });
      assert.lengthOf(tasks, 1);
    });

    it("keeps rows sorted by status priority after updates", async function () {
      const { manager } = testManager();
      const [a, b] = [await createPreprintItem(), await createPreprintItem()];
      manager.createUpdateTasks([a, b]);
      manager.updateRow(b.id, { status: "updated" });
      assert.deepEqual(
        manager.getRows().map((r) => r.status),
        ["pending", "updated"],
      );
      manager.updateRow(a.id, { status: "download-error" });
      assert.deepEqual(
        manager.getRows().map((r) => r.status),
        ["download-error", "updated"],
      );
    });

    it("drops finished rows when filtered", async function () {
      const { manager } = testManager();
      const [a, b] = [await createPreprintItem(), await createPreprintItem()];
      manager.createUpdateTasks([a, b]);
      manager.updateRow(a.id, { status: "updated" });
      manager.filterInactive();
      assert.deepEqual(
        manager.getRows().map((r) => r.id),
        [b.id],
      );
    });

    it("notifies onChange after mutations", async function () {
      const { manager } = testManager();
      const item = await createPreprintItem();
      let notified = 0;
      manager.onChange = () => notified++;
      manager.createUpdateTasks([item]);
      manager.updateRow(item.id, { status: "updated" });
      assert.equal(notified, 2);
    });
  });

  describe("UpdateDialog.getRowData", function () {
    it("composes an emoji status with the message", async function () {
      const { manager } = testManager();
      useManager(manager);
      const item = await createPreprintItem();
      manager.createUpdateTasks([item]);
      manager.updateRow(item.id, {
        status: "updated",
        message: "some message",
      });

      const data = UpdateDialog.getRowData(0);
      assert.equal(data.title, "Test paper");
      assert.match(data.status, /^🟢 /);
      assert.include(data.status, "some message");
    });
  });

  describe("UpdateDialog.renderStatusCell", function () {
    it("returns undefined when no dialog document exists", async function () {
      const { manager } = testManager();
      useManager(manager);
      const item = await createPreprintItem();
      manager.createUpdateTasks([item]);
      UpdateDialog.window = undefined;
      assert.isUndefined(
        UpdateDialog.renderStatusCell(0, "⚪ Pending", {
          className: "status",
        } as StatusColumn),
      );
    });

    it("renders a colored swatch and the message without the emoji", async function () {
      const { manager } = testManager();
      useManager(manager);
      const item = await createPreprintItem();
      manager.createUpdateTasks([item]);
      manager.updateRow(item.id, { status: "updated", message: "done" });
      UpdateDialog.window = {
        document: Zotero.getMainWindow().document,
      } as unknown as WindowProxy;

      const cell = UpdateDialog.renderStatusCell(0, "🟢 Updated: done", {
        className: "status",
      } as StatusColumn);
      assert.equal(cell?.className, "cell status");
      const swatch = cell?.querySelector(".tag-swatch") as HTMLElement | null;
      // Gecko serializes the assigned hex color back as rgb().
      assert.equal(swatch?.style.color, "rgb(95, 178, 54)");
      const text = cell?.querySelector(".status-message") as HTMLElement | null;
      // The emoji circle is stripped but the following space is kept.
      assert.equal(text?.innerText, " Updated: done");
    });

    it("opens the dialog for the row it was rendered from, even after a re-sort", async function () {
      const { manager } = testManager();
      useManager(manager);
      const first = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "First Paper",
        },
      );
      const second = await createPreprintItem(
        "https://arxiv.org/abs/2409.11322",
        { title: "Second Paper" },
      );
      manager
        .getRows()
        .push(
          candidate(manager, first.id, first.getDisplayTitle()),
          candidate(manager, second.id, second.getDisplayTitle()),
        );
      UpdateDialog.window = {
        document: Zotero.getMainWindow().document,
      } as unknown as WindowProxy;

      // Render the cell for index 1 ("Second Paper"). Then a row that errored
      // sorts itself to the front, so index 1 now names a different row: the
      // click must still resolve the row the cell was rendered from.
      const cell = UpdateDialog.renderStatusCell(1, "", {
        className: "status",
      } as StatusColumn) as HTMLElement;
      assert.equal(manager.getRows()[1]?.id, second.id);
      manager.getRows().push({
        id: second.id + 100000,
        title: "Errored Paper",
        status: "general-error",
      });
      manager.updateRow(first.id, { status: "needs-confirmation" });
      assert.equal(
        manager.getRows()[1]?.id,
        first.id,
        "the re-sort should have moved the rendered row off index 1",
      );

      const opened: number[] = [];
      const confirmCandidate = UpdateDialog.confirmCandidateWithDialog;
      UpdateDialog.confirmCandidateWithDialog = async (id: number) => {
        opened.push(id);
      };
      try {
        const link = cell.querySelector<HTMLElement>(".candidate-link")!;
        link.dispatchEvent(
          new (Zotero.getMainWindow() as unknown as Window).MouseEvent(
            "click",
            { bubbles: true, cancelable: true },
          ),
        );
      } finally {
        UpdateDialog.confirmCandidateWithDialog = confirmCandidate;
      }
      assert.deepEqual(
        opened,
        [second.id],
        "the click must open the dialog of the row it was rendered for",
      );
    });
  });

  describe("UpdateDialog.refreshOrOpen", function () {
    it("invalidates the open table without reopening", async function () {
      const { manager } = testManager();
      useManager(manager);
      const item = await createPreprintItem();
      manager.createUpdateTasks([item]);
      let invalidated = 0;
      UpdateDialog.window = {
        closed: false,
        sizeToContentConstrained: () => {},
      } as unknown as WindowProxy;
      UpdateDialog.tableHelper = {
        treeInstance: { invalidate: () => invalidated++ },
      } as unknown as VirtualizedTableHelper;
      UpdateDialog.refreshOrOpen({ openWindow: false });
      assert.equal(invalidated, 1);
    });

    it("filters stale rows and opens when the window is closed", async function () {
      const { manager } = testManager();
      useManager(manager);
      const [a, b] = [await createPreprintItem(), await createPreprintItem()];
      manager.createUpdateTasks([a, b]);
      manager.updateRow(a.id, { status: "updated" });
      UpdateDialog.window = { closed: true } as unknown as WindowProxy;
      UpdateDialog.tableHelper = undefined;

      const originalOpen = UpdateDialog.open;
      let opened = 0;
      UpdateDialog.open = async () => {
        opened++;
      };
      try {
        UpdateDialog.refreshOrOpen();
        assert.equal(opened, 1);
        assert.deepEqual(
          manager.getRows().map((r) => r.id),
          [b.id],
        );
      } finally {
        UpdateDialog.open = originalOpen;
      }
    });

    it("does not open when openWindow is false", async function () {
      const { manager } = testManager();
      useManager(manager);
      UpdateDialog.window = { closed: true } as unknown as WindowProxy;
      UpdateDialog.tableHelper = undefined;

      const originalOpen = UpdateDialog.open;
      let opened = 0;
      UpdateDialog.open = async () => {
        opened++;
      };
      try {
        UpdateDialog.refreshOrOpen({ openWindow: false });
        assert.equal(opened, 0);
      } finally {
        UpdateDialog.open = originalOpen;
      }
    });
  });

  describe("update dialog end-to-end", function () {
    it("opens the real dialog with a pending row, offline", async function () {
      const { manager, tasks } = testManager();
      useManager(manager);
      const item = await createPreprintItem();
      arXivUpdate.update([item]);
      const win = await waitForDialogRows(1);
      assert.isDefined(win);
      const rows = win.document.querySelectorAll(
        `#${config.addonRef}-status-table .row`,
      );
      assert.isAtLeast(rows.length, 1);
      // The task was enqueued but never executed (capturing queue), so the
      // dialog rendered without any network activity.
      assert.lengthOf(tasks, 1);
      win.close();
    });

    it("runs the real update task behind the dialog and renders the final status", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem();
      const { fetcher, calls } = createFetcher({
        fetchText: async () => '<html data-doi="10.1000/published"></html>',
      });
      const { manager } = createUpdateManager({ fetcher });
      useManager(manager);

      arXivUpdate.update([item]);
      const win = await waitForStatusMessage(
        getString("update-status", "updated"),
      );

      assert.lengthOf(calls, 1, "only the arXiv abstract page is fetched");
      assert.equal(manager.getRows()[0].status, "updated");
      const merged = await getItem(item.id);
      assert.equal(merged.itemType, "journalArticle");
      assert.equal(merged.getField("DOI"), "10.1000/published");
      win.close();
    });

    it("shows the no-update status in the dialog when no source matches", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem();
      const { fetcher } = createFetcher(); // every source misses
      const { manager } = createUpdateManager({ fetcher });
      useManager(manager);

      arXivUpdate.update([item]);
      const win = await waitForStatusMessage(
        getString("update-status", "up-to-date"),
      );

      assert.equal(manager.getRows()[0].status, "up-to-date");
      const after = await getItem(item.id);
      assert.equal(after.itemType, "preprint", "item should be left untouched");
      win.close();
    });
  });

  describe("candidate confirmation dialog", function () {
    // A manager whose confirm/skip really executes (imports + merges) but
    // whose finder is never consulted: the rows below are pushed directly.
    function reviewManager(
      overrides: {
        fetcher?: Parameters<typeof createUpdateManager>[0]["fetcher"];
        createItem?: Parameters<typeof createUpdateManager>[0]["createItem"];
      } = {},
    ) {
      const { manager } = createUpdateManager({
        fetcher: overrides.fetcher ?? createFetcher().fetcher,
        ...(overrides.createItem ? { createItem: overrides.createItem } : {}),
      });
      useManager(manager);
      return manager;
    }

    it("click-to-check opens the dialog and confirm triggers the merge", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "The Quick Brown Fox",
        },
      );
      const candidateURL = "https://openreview.net/forum?id=example123";
      const manager = reviewManager();
      manager
        .getRows()
        .push(
          candidate(
            manager,
            item.id,
            item.getDisplayTitle(),
            "DBLP",
            "The Lazy Brown Dog",
            candidateURL,
          ),
        );

      await UpdateDialog.open();
      const win = await waitForDialogRows(1);
      const statusCell = win.document.querySelector(
        `#${config.addonRef}-status-table .row .cell.clickable`,
      )!;
      assert.ok(
        statusCell.classList.contains("status-cell"),
        "status cell should use the regular status layout",
      );
      assert.ok(
        statusCell.textContent?.includes(getString("review-prompt")),
        "status cell should show the fuzzy-match prompt",
      );
      const link = statusCell.querySelector<HTMLElement>(".candidate-link")!;
      assert.equal(
        link.textContent,
        getString("review-action", "click-to-check"),
      );

      link.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      const dialog = await waitForCandidateDialog();

      // The dialog shows the word-level diff between the two titles.
      const preprintTitle = dialog.document.getElementById(
        `${config.addonRef}-preprint-title`,
      )!;
      const removed = preprintTitle.querySelectorAll("b");
      assert.ok(
        removed.length > 0,
        "preprint line should highlight preprint-only words",
      );
      for (const b of removed) {
        assert.equal((b as HTMLElement).style.color, "var(--accent-red)");
      }
      const candidateTitle = dialog.document.getElementById(
        `${config.addonRef}-candidate-title`,
      )!;
      const added = candidateTitle.querySelectorAll("b");
      assert.ok(
        added.length > 0,
        "candidate line should highlight candidate-only words",
      );
      for (const b of added) {
        assert.equal((b as HTMLElement).style.color, "var(--accent-green)");
      }
      const meta = dialog.document.getElementById(
        `${config.addonRef}-candidate-meta`,
      )!;
      assert.ok(
        meta.textContent?.includes("DBLP"),
        "meta should show the source",
      );
      assert.ok(
        meta.textContent?.includes("ICLR"),
        "meta should show the publication title",
      );

      const linkContainer = dialog.document.getElementById(
        `${config.addonRef}-candidate-link`,
      )!;
      const viewLink =
        linkContainer.querySelector<HTMLAnchorElement>("a.candidate-link")!;
      assert.ok(viewLink, "dialog should render the candidate review link");
      assert.equal(
        viewLink.textContent,
        getString("review-action", "view-candidate"),
      );
      assert.equal(viewLink.getAttribute("href"), candidateURL);

      const openedURLs: string[] = [];
      const originalLaunchURL = Zotero.launchURL;
      Zotero.launchURL = (url: string) => void openedURLs.push(url);
      try {
        viewLink.dispatchEvent(
          new dialog.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      } finally {
        Zotero.launchURL = originalLaunchURL;
      }
      assert.deepEqual(openedURLs, [candidateURL]);

      assert.equal(
        dialogButton(dialog, "accept").label,
        getString("review-action", "confirm"),
      );
      assert.equal(
        dialogButton(dialog, "extra1").label,
        getString("review-action", "skip"),
      );

      dialogButton(dialog, "accept").click();
      await waitForCondition(
        "row to reach updated status",
        () => manager.getRow(item.id)?.status === "updated",
      );

      assert.equal(manager.getRow(item.id)?.status, "updated");
      assert.isUndefined(manager.getPendingPaper(item.id));
      const merged = await getItem(item.id);
      assert.equal(merged.itemType, "journalArticle");
      assert.equal(merged.getField("DOI"), `10.5555/example-doi-${item.id}`);
    });

    it("dialog without a candidate URL hides the review link", async function () {
      setPluginPref("downloadJournalPDF", false);
      setPluginPref("updateSource.arXiv", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "Paper Number Six",
        },
      );
      const manager = reviewManager();
      manager
        .getRows()
        .push(
          candidate(
            manager,
            item.id,
            item.getDisplayTitle(),
            "PubMed",
            "Some Title",
            null,
          ),
        );

      await UpdateDialog.open();
      const win = await waitForDialogRows(1);
      const dialog = await clickLinkAndWait(win);

      const linkContainer = dialog.document.getElementById(
        `${config.addonRef}-candidate-link`,
      )!;
      assert.equal(
        linkContainer.style.display,
        "none",
        "link line should be hidden without a candidate URL",
      );
      assert.equal(
        linkContainer.querySelector("a.candidate-link"),
        null,
        "no link should be rendered without a candidate URL",
      );

      dialogButton(dialog, "extra1").click();
      await waitForCondition(
        "row to become up-to-date",
        () => manager.getRow(item.id)?.status === "up-to-date",
      );
    });

    it("skip button in the dialog marks the row up-to-date", async function () {
      setPluginPref("downloadJournalPDF", false);
      setPluginPref("updateSource.arXiv", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "Paper Number Two",
        },
      );
      const manager = reviewManager();
      manager
        .getRows()
        .push(candidate(manager, item.id, item.getDisplayTitle()));

      await UpdateDialog.open();
      const win = await waitForDialogRows(1);
      const dialog = await clickLinkAndWait(win);

      dialogButton(dialog, "extra1").click();
      await waitForCondition(
        "row to become up-to-date",
        () => manager.getRow(item.id)?.status === "up-to-date",
      );
      assert.isUndefined(manager.getPendingPaper(item.id));
    });

    it("skipping runs the arXiv self-update fallback when enabled", async function () {
      setPluginPref("downloadJournalPDF", false);
      setPluginPref("updateSource.arXiv", true);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "Paper Number Seven",
        },
      );
      let located: PaperIdentifier | undefined;
      const manager = reviewManager({
        fetcher: createFetcher({
          fetchText: async () => "<html><strong>[v2]</strong></html>",
        }).fetcher,
        createItem: async (paper) => {
          located = paper;
          return createJournalItem(paper);
        },
      });
      manager.getRows().push(
        candidate(
          manager,
          item.id,
          item.getDisplayTitle(),
          "DBLP",
          undefined,
          undefined,
          {
            url: "https://arxiv.org/abs/2409.11321",
            title: "v2 PDF",
          },
        ),
      );

      await UpdateDialog.open();
      const win = await waitForDialogRows(1);
      const dialog = await clickLinkAndWait(win);
      dialogButton(dialog, "extra1").click();

      await waitForCondition(
        "row to reach updated status via arXiv self-update",
        () => manager.getRow(item.id)?.status === "updated",
      );
      assert.deepEqual(located, {
        url: "https://arxiv.org/abs/2409.11321",
        title: "v2 PDF",
      });
    });

    it("closing the confirmation dialog leaves the row pending", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "Paper Number Three",
        },
      );
      const manager = reviewManager();
      manager
        .getRows()
        .push(candidate(manager, item.id, item.getDisplayTitle()));

      await UpdateDialog.open();
      const win = await waitForDialogRows(1);
      const dialog = await clickLinkAndWait(win);

      dialog.close();
      await Zotero.Promise.delay(300);

      const data = manager.getRow(item.id);
      assert.equal(
        data?.status,
        "needs-confirmation",
        "closing the dialog should keep the row pending",
      );
      assert.ok(
        manager.getPendingPaper(item.id),
        "pending paper should be retained",
      );
    });

    it("double-clicking the link opens only one dialog", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "Paper Number Four",
        },
      );
      const manager = reviewManager();
      manager
        .getRows()
        .push(candidate(manager, item.id, item.getDisplayTitle()));

      await UpdateDialog.open();
      const win = await waitForDialogRows(1);
      const link = win.document.querySelector<HTMLElement>(
        `#${config.addonRef}-status-table .row .cell.clickable .candidate-link`,
      )!;
      // Click again once the first dialog has loaded, so a stale unload during
      // the initial document load would have already cleared the guard.
      link.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      const firstDialog = await waitForCandidateDialog();
      link.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Zotero.Promise.delay(300);

      assert.equal(
        findCandidateDialogs().length,
        1,
        "double-click should open only one dialog",
      );
      assert.ok(!firstDialog.closed, "the dialog should still be open");
    });

    it("a dialog that already closed does not block the next confirmation", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "Paper Number Six",
        },
      );
      const manager = reviewManager();
      manager
        .getRows()
        .push(candidate(manager, item.id, item.getDisplayTitle()));

      await UpdateDialog.open();
      const win = await waitForDialogRows(1);
      // The static keeps pointing at the previous dialog after it closes; only
      // its `closed` flag says it is gone. A click must still work.
      UpdateDialog.openCandidateDialog = {
        closed: true,
      } as unknown as WindowProxy;

      const dialog = await clickLinkAndWait(win);
      assert.ok(
        !dialog.closed,
        "a stale reference must not lock the confirmation feature",
      );
      dialog.close();
    });

    it("window close keeps pending candidates", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "Paper Number Five",
        },
      );
      const manager = reviewManager();
      manager
        .getRows()
        .push(candidate(manager, item.id, item.getDisplayTitle()));

      await UpdateDialog.open();
      const win = await waitForDialogRows(1);
      win.close();
      await Zotero.Promise.delay(300);

      const data = manager.getRow(item.id);
      assert.equal(
        data?.status,
        "needs-confirmation",
        "closing the window should keep the pending candidate",
      );
      assert.ok(
        manager.getPendingPaper(item.id),
        "pending paper should be retained",
      );
    });
  });
});
