import { assert } from "chai";
import PQueue from "p-queue";
import type { VirtualizedTableHelper } from "zotero-plugin-toolkit";
import type Addon from "../../src/addon";
import { config } from "../../package.json";
import {
  arXivUpdate,
  isUpdateMenuVisible,
} from "../../src/modules/arxiv-update";
import { UpdateManager } from "../../src/modules/arxiv-update/manager";
import { UpdateDialog } from "../../src/modules/arxiv-update/update-dialog";
import { getString } from "../../src/utils/locale";
import { clearLibrary, getPlugin, setPluginPref } from "../helpers";
import {
  createFetcher,
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
});
