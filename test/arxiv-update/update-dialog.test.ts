import { assert } from "chai";
import PQueue from "p-queue";
import type { VirtualizedTableHelper } from "zotero-plugin-toolkit";
import type Addon from "@/addon";
import { config } from "@pkg";
import { arXivUpdate, isUpdateMenuVisible } from "@/modules/arxiv-update";
import { UpdateManager } from "@/modules/arxiv-update/manager";
import { UpdateDialog } from "@/modules/arxiv-update/update-dialog";
import { STATUS_COLOR } from "@/modules/arxiv-update/status";
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
  createPreprintItem,
  createUpdateManager,
  getItem,
  resetUpdateSourcePrefs,
} from "./helpers";

type StatusColumn = Parameters<typeof UpdateDialog.renderStatusCell>[2];

/** Gecko normalizes assigned hex colors to `rgb(...)`; compare in its terms. */
function toRgb(hex: string): string {
  const el = Zotero.getMainWindow().document.createElement("span");
  el.style.color = hex;
  return el.style.color;
}

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
    // Close any dialog opened during the test and reset its statics. Fake
    // windows used to stub rendering have no `close`; guard the call.
    if (UpdateDialog.window) {
      try {
        UpdateDialog.drawer?.close();
      } catch {
        // Detached fake document; nothing to clear.
      }
      if (!UpdateDialog.window.closed) UpdateDialog.window.close?.();
    }
    UpdateDialog.window = undefined;
    UpdateDialog.tableHelper = undefined;
    UpdateDialog.drawer = undefined;
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
    options: {
      source?: "DBLP" | "PubMed";
      candidateTitle?: string;
      /** Omit for the source's default review link; pass "" for none. */
      url?: string;
    } = {},
  ): UpdateTableData {
    const source = options.source ?? "DBLP";
    const paper: TentativePaperIdentifier = {
      doi: `10.5555/example-doi-${id}`,
      title: "Published PDF",
      tentative: true,
      candidate: {
        source,
        candidateTitle:
          options.candidateTitle ?? `${title} (Published Version)`,
        publication: source === "DBLP" ? "ICLR" : "Some Journal",
        year: "2024",
        score: 0.9,
        url:
          options.url ??
          (source === "DBLP"
            ? `https://dblp.org/rec/conf/iclr/example-${id}.html`
            : `https://pubmed.ncbi.nlm.nih.gov/30000000${id}/`),
      },
    };
    // This fake pipeline is already paused at the confirmation point; a
    // resumed run (skip) finds no further paper, matching the real finder
    // when the only candidate was the one just rejected.
    const iterator = {
      async next(): Promise<
        IteratorResult<never, PaperIdentifier | undefined>
      > {
        return { done: true, value: undefined };
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

  // The virtualized table's selection API is the seam the drawer reacts to.
  function tableSelection() {
    return (
      UpdateDialog.tableHelper as unknown as {
        treeInstance: {
          selection: {
            select(index: number): void;
            clearSelection(): void;
          };
        };
      }
    ).treeInstance.selection;
  }

  function drawerDocument(): Document {
    return UpdateDialog.window!.document;
  }

  function drawerWindow(): Window {
    return UpdateDialog.window as unknown as Window;
  }

  function drawerEl(suffix: string): HTMLElement | null {
    return drawerDocument().getElementById(
      `${config.addonRef}-${suffix}`,
    ) as HTMLElement | null;
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
      assert.equal(swatch?.style.color, toRgb(STATUS_COLOR.updated));
      const text = cell?.querySelector(".status-message") as HTMLElement | null;
      // The emoji circle is stripped but the following space is kept.
      assert.equal(text?.innerText, " Updated: done");
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
      // The window is sized declaratively (width/height on <window>); this
      // guards against reintroducing the JS sizeToContent workaround or a
      // content-shrinking dialog that would drag the drawer with it.
      await Zotero.Promise.delay(300);
      const sizeRoot = win.document.querySelector(
        ".update-root",
      ) as HTMLElement;
      assert.equal(win.innerHeight, 300, "dialog opens at the declared height");
      assert.equal(
        sizeRoot.clientHeight,
        win.innerHeight,
        "the content root fills the dialog",
      );
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

      // The pipeline's merge/DOI outcome is covered in manager.test.ts; here
      // the contract is that the dialog renders the final status.
      assert.lengthOf(calls, 1, "only the arXiv abstract page is fetched");
      assert.equal(manager.getRows()[0].status, "updated");
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
      win.close();
    });
  });

  describe("detail drawer", function () {
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

    function isDrawerOpen(): boolean {
      return drawerEl("drawer")?.style.display === "flex";
    }

    function pressKey(key: string) {
      const win = UpdateDialog.window as unknown as Window;
      win.dispatchEvent(
        new win.KeyboardEvent("keydown", { key, bubbles: true }),
      );
    }

    it("selection opens the drawer and confirm merges the candidate", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "The Quick Brown Fox",
        },
      );
      const candidateURL = "https://openreview.net/forum?id=example123";
      const manager = reviewManager();
      manager.getRows().push(
        candidate(manager, item.id, item.getDisplayTitle(), {
          source: "DBLP",
          candidateTitle: "The Lazy Brown Dog",
          url: candidateURL,
        }),
      );

      await UpdateDialog.open();
      await waitForDialogRows(1);
      tableSelection().select(0);

      assert.isTrue(isDrawerOpen(), "the drawer should open on selection");
      assert.equal(
        drawerEl("drawer-title")?.textContent,
        item.getDisplayTitle(),
      );
      assert.include(
        drawerEl("drawer-status")?.textContent ?? "",
        getString("update-status", "needs-confirmation"),
      );

      // The candidate title highlights only words the candidate adds.
      const candidateTitle = drawerEl("drawer-candidate-title")!;
      const added = candidateTitle.querySelectorAll("b");
      assert.ok(
        added.length > 0,
        "candidate line should highlight added words",
      );
      for (const b of added) {
        assert.equal((b as HTMLElement).style.color, "var(--accent-green)");
      }
      const meta = drawerEl("drawer-candidate-meta")!;
      assert.include(meta.textContent ?? "", "DBLP");
      assert.include(meta.textContent ?? "", "ICLR");

      const viewLink = drawerEl(
        "drawer-candidate-link",
      )!.querySelector<HTMLAnchorElement>("a.candidate-link")!;
      assert.ok(viewLink, "drawer should render the candidate review link");
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
          new (drawerWindow().MouseEvent)("click", {
            bubbles: true,
            cancelable: true,
          }),
        );
      } finally {
        Zotero.launchURL = originalLaunchURL;
      }
      assert.deepEqual(openedURLs, [candidateURL]);

      assert.equal(
        drawerEl("drawer-confirm")?.textContent,
        getString("review-action", "confirm"),
      );
      assert.equal(
        drawerEl("drawer-skip")?.textContent,
        getString("review-action", "skip"),
      );

      drawerEl("drawer-confirm")!.click();
      await waitForCondition(
        "row to reach updated status",
        () => manager.getRow(item.id)?.status === "updated",
      );

      assert.isUndefined(manager.getPendingPaper(item.id));
      const merged = await getItem(item.id);
      assert.equal(merged.itemType, "journalArticle");
      assert.equal(merged.getField("DOI"), `10.5555/example-doi-${item.id}`);
    });

    it("renders a status swatch and one labeled row per source outcome", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        { title: "Sourced Paper" },
      );
      const manager = reviewManager();
      const sources = {
        relatedDOI: { outcome: "empty" },
        dblp: { outcome: "found" },
        pubMed: { outcome: "running" },
        crossref: { outcome: "empty" },
        arXivPDF: { outcome: "failed", detail: "network down" },
      } as const;
      manager.getRows().push({
        id: item.id,
        title: item.getDisplayTitle(),
        status: "finding-update",
        sources: { ...sources },
      });

      await UpdateDialog.open();
      await waitForDialogRows(1);
      tableSelection().select(0);

      // The status line uses the table cell's swatch, not a font-dependent
      // emoji.
      const statusSwatch = drawerEl("drawer-status")?.querySelector(
        ".tag-swatch",
      ) as HTMLElement | null;
      assert.ok(statusSwatch, "status line should carry a swatch");
      assert.equal(statusSwatch!.style.color, toRgb(STATUS_COLOR.processing));

      // Each source row shows its localized name and outcome; the failed row
      // also shows why it failed. Class names are an implementation detail of
      // the icon and not asserted here.
      const orderedKeys = [
        "relatedDOI",
        "dblp",
        "pubMed",
        "crossref",
        "arXivPDF",
      ] as const;
      const items = Array.from(
        drawerEl("drawer-sources")!.querySelectorAll(".drawer-source"),
      );
      assert.lengthOf(items, orderedKeys.length);
      orderedKeys.forEach((key, index) => {
        const item = items[index]!;
        assert.equal(
          item.querySelector(".source-name")?.textContent,
          getString("source-name", key),
        );
        assert.equal(
          item.querySelector(".source-outcome")?.textContent,
          getString("source-outcome", sources[key].outcome),
        );
      });
      assert.equal(
        items[4]!.querySelector(".source-detail")?.textContent,
        "network down",
        "a failed source shows its failure detail",
      );
    });

    it("candidate without a URL hides the review link", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "Paper Number Six",
        },
      );
      const manager = reviewManager();
      manager.getRows().push(
        candidate(manager, item.id, item.getDisplayTitle(), {
          source: "PubMed",
          candidateTitle: "Some Title",
          url: "",
        }),
      );

      await UpdateDialog.open();
      await waitForDialogRows(1);
      tableSelection().select(0);

      assert.equal(
        drawerEl("drawer-candidate-link")?.style.display,
        "none",
        "link line should be hidden without a candidate URL",
      );
      assert.equal(
        drawerEl("drawer-candidate-link")?.querySelector("a.candidate-link"),
        null,
      );
    });

    it("skip marks the row up-to-date", async function () {
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
      await waitForDialogRows(1);
      tableSelection().select(0);
      drawerEl("drawer-skip")!.click();

      await waitForCondition(
        "row to become up-to-date",
        () => manager.getRow(item.id)?.status === "up-to-date",
      );
      assert.isUndefined(manager.getPendingPaper(item.id));
    });

    it("an empty selection closes the drawer", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "Paper Number Eight",
        },
      );
      const manager = reviewManager();
      manager
        .getRows()
        .push(candidate(manager, item.id, item.getDisplayTitle()));

      await UpdateDialog.open();
      await waitForDialogRows(1);
      tableSelection().select(0);
      assert.isTrue(isDrawerOpen());

      tableSelection().clearSelection();
      assert.isFalse(
        isDrawerOpen(),
        "clearing the selection closes the drawer",
      );
      assert.equal(
        manager.getRow(item.id)?.status,
        "needs-confirmation",
        "closing the drawer leaves the row pending",
      );
    });

    it("Escape closes the drawer and leaves the row pending", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        {
          title: "Paper Number Nine",
        },
      );
      const manager = reviewManager();
      manager
        .getRows()
        .push(candidate(manager, item.id, item.getDisplayTitle()));

      await UpdateDialog.open();
      await waitForDialogRows(1);
      tableSelection().select(0);
      assert.isTrue(isDrawerOpen());

      pressKey("Escape");
      assert.isFalse(isDrawerOpen());
      assert.equal(manager.getRow(item.id)?.status, "needs-confirmation");
    });

    it("a re-sort while the drawer is open keeps it on the same row", async function () {
      setPluginPref("downloadJournalPDF", false);
      const selected = await createPreprintItem(
        "https://arxiv.org/abs/2409.11321",
        { title: "Selected Paper" },
      );
      const other = await createPreprintItem(
        "https://arxiv.org/abs/2409.11322",
        { title: "Other Paper" },
      );
      const manager = reviewManager();
      manager
        .getRows()
        .push(
          candidate(manager, other.id, other.getDisplayTitle()),
          candidate(manager, selected.id, selected.getDisplayTitle()),
        );

      await UpdateDialog.open();
      await waitForDialogRows(2);
      tableSelection().select(1);
      assert.equal(
        drawerEl("drawer-title")?.textContent,
        selected.getDisplayTitle(),
      );
      assert.equal(manager.getRows()[1]?.id, selected.id);

      // An errored row sorts to the front, so index 1 now names another row;
      // the drawer must keep rendering (and confirming) the captured id.
      manager.getRows().push({
        id: selected.id + 100000,
        title: "Errored Paper",
        status: "general-error",
      });
      manager.updateRow(selected.id, { status: "needs-confirmation" });
      assert.equal(
        manager.getRows()[1]?.id,
        other.id,
        "the re-sort should have moved the selected row off index 1",
      );
      assert.equal(
        drawerEl("drawer-title")?.textContent,
        selected.getDisplayTitle(),
        "the drawer stays bound to its captured row id",
      );

      drawerEl("drawer-confirm")!.click();
      await waitForCondition(
        "the captured row to reach updated status",
        () => manager.getRow(selected.id)?.status === "updated",
      );
      assert.equal(
        manager.getRow(other.id)?.status,
        "needs-confirmation",
        "the other row must remain untouched",
      );
    });

    it("window close tears down the drawer and keeps pending candidates", async function () {
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
      await waitForDialogRows(1);
      tableSelection().select(0);
      assert.ok(UpdateDialog.drawer?.isOpen());

      UpdateDialog.window!.close();
      await Zotero.Promise.delay(300);

      assert.equal(
        manager.getRow(item.id)?.status,
        "needs-confirmation",
        "closing the window should keep the pending candidate",
      );
      assert.ok(manager.getPendingPaper(item.id));
      // The manager queue outlives the window: the drawer and the row-change
      // hook must be torn down so a late task cannot touch the dead window.
      assert.isUndefined(UpdateDialog.drawer, "the drawer must be torn down");
      assert.isUndefined(
        manager.onChange,
        "the row-change hook must be dropped",
      );
      // A mutation after close must be a no-op, not a repaint of a dead window.
      manager.updateRow(item.id, { status: "needs-confirmation" });
    });
  });
});
