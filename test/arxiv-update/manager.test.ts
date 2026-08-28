import { assert } from "chai";
import type Addon from "@/addon";
import type { PaperIdentifier } from "@/modules/arxiv-update/paper-finder";
import type { UpdateManager } from "@/modules/arxiv-update/manager";
import { UpdateDialog } from "@/modules/arxiv-update/update-dialog";
import { clearLibrary, getPlugin, setPluginPref } from "@test/helpers";
import {
  createFetcher,
  createJournalItem,
  createPreprintItem,
  createUpdateManager,
  getItem,
  resetUpdateSourcePrefs,
} from "./helpers";

/**
 * Pipeline coverage of UpdateManager's task execution: a real PQueue runs
 * PaperFinder (with an injected Fetcher), imports the journal item (with an
 * injected createItem stub), and merges it into the preprint. Only the two
 * network seams are faked. Dialog-level end-to-end coverage (real dialog +
 * real task) lives in update-dialog.test.ts. The production fetcher's own
 * behavior (per-host auth headers) lives in fetcher.test.ts.
 */
describe("update-manager", function () {
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
    // Never leave a dialog window/table pointing at our swapped manager.
    UpdateDialog.window = undefined;
    UpdateDialog.tableHelper = undefined;
    addon.data.arXivUpdate.manager = originalManager;
    await clearLibrary();
  });

  // Track the statuses the manager reports. A task starts synchronously
  // inside PQueue.add(), before createUpdateTasks fires its own onChange, so
  // collapse consecutive duplicates rather than asserting an exact sequence.
  function trackStatuses(manager: UpdateManager): string[] {
    const seen: string[] = [];
    manager.onChange = () => {
      const status = manager.getRows()[0]?.status;
      if (status && seen[seen.length - 1] !== status) seen.push(status);
    };
    return seen;
  }

  function assertInOrder(haystack: string[], ...needles: string[]) {
    let idx = -1;
    for (const needle of needles) {
      const i = haystack.indexOf(needle, idx + 1);
      assert.isAbove(
        i,
        idx,
        `"${needle}" not found in order in ${JSON.stringify(haystack)}`,
      );
      idx = i;
    }
  }

  it("finds a DOI, imports the journal item, and merges it into the preprint", async function () {
    setPluginPref("downloadJournalPDF", false);
    const item = await createPreprintItem();
    const { fetcher, calls } = createFetcher({
      fetchText: async () => '<html data-doi="10.1000/published"></html>',
    });
    const { queue, manager } = createUpdateManager({ fetcher });
    const statuses = trackStatuses(manager);

    manager.createUpdateTasks([item]);
    await queue.onIdle();

    assert.lengthOf(calls, 1, "only the arXiv abstract page should be fetched");
    assert.equal(calls[0].url, "https://arxiv.org/abs/1234.5678");
    assertInOrder(
      statuses,
      "finding-update",
      "downloading-metadata",
      "updated",
    );
    assert.equal(manager.getRows()[0].status, "updated");

    const merged = await getItem(item.id);
    assert.equal(merged.itemType, "journalArticle");
    assert.equal(merged.getField("DOI"), "10.1000/published");
    assert.equal(merged.getDisplayTitle(), "Published title");
  });

  it("reports up-to-date when no source locates a published version", async function () {
    setPluginPref("downloadJournalPDF", false);
    const item = await createPreprintItem();
    const { fetcher } = createFetcher(); // every source misses
    const { queue, manager } = createUpdateManager({ fetcher });

    manager.createUpdateTasks([item]);
    await queue.onIdle();

    assert.equal(manager.getRows()[0].status, "up-to-date");
    const after = await getItem(item.id);
    assert.equal(after.itemType, "preprint", "item should be left untouched");
  });

  it("reports download-error when the journal item cannot be created", async function () {
    setPluginPref("downloadJournalPDF", false);
    const item = await createPreprintItem();
    const { fetcher } = createFetcher({
      fetchText: async () => '<html data-doi="10.1000/published"></html>',
    });
    const { queue, manager } = createUpdateManager({
      fetcher,
      createItem: async () => false,
    });

    manager.createUpdateTasks([item]);
    await queue.onIdle();

    assert.equal(manager.getRows()[0].status, "download-error");
    const after = await getItem(item.id);
    assert.equal(after.itemType, "preprint", "item should be left untouched");
  });

  it("imports the newer arXiv PDF when no DOI-based source matches", async function () {
    setPluginPref("downloadJournalPDF", false);
    const item = await createPreprintItem();
    const { fetcher } = createFetcher({
      fetchText: async () => "<html><strong>[v2]</strong></html>",
      fetchJSON: async () => ({}),
    });
    let located: PaperIdentifier | undefined;
    const { queue, manager } = createUpdateManager({
      fetcher,
      createItem: async (paper) => {
        located = paper;
        return createJournalItem(paper);
      },
    });

    manager.createUpdateTasks([item]);
    await queue.onIdle();

    assert.equal(manager.getRows()[0].status, "updated");
    assert.deepEqual(located, {
      url: "https://arxiv.org/abs/1234.5678",
      title: "v2 PDF",
    });
    const merged = await getItem(item.id);
    assert.equal(merged.itemType, "journalArticle");
    assert.equal(merged.getField("url"), "https://arxiv.org/abs/1234.5678");
  });

  it("runs the whole update through the public arXivUpdate API", async function () {
    setPluginPref("downloadJournalPDF", false);
    const item = await createPreprintItem();
    const { fetcher } = createFetcher({
      fetchText: async () => '<html data-doi="10.1000/published"></html>',
    });
    const { queue, manager } = createUpdateManager({ fetcher });
    addon.data.arXivUpdate.manager = manager;

    plugin.api.arXivUpdate([item], { openWindow: false });
    await queue.onIdle();

    assert.equal(manager.getRows()[0].status, "updated");
    const merged = await getItem(item.id);
    assert.equal(merged.itemType, "journalArticle");
  });
});
