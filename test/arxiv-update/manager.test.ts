import { assert } from "chai";
import type Addon from "@/addon";
import type { UpdateManager } from "@/modules/arxiv-update/manager";
import { UpdateDialog } from "@/modules/arxiv-update/update-dialog";
import type { PaperIdentifier } from "@/types";
import { getString } from "@/utils/locale";
import { clearLibrary, getPlugin, setPluginPref } from "@test/helpers";
import {
  createDBLPFuzzyHit,
  createFetcher,
  createJournalItem,
  createPreprintItem,
  createSOAPPreprint,
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

  describe("review flow", function () {
    // A fetcher whose only result is the SOAP DBLP fuzzy candidate, so every
    // update task ends in `needs-confirmation`.
    function fuzzyFetcher() {
      return createFetcher({
        fetchText: async () => "<html></html>",
        fetchJSON: async (url) => {
          if (url.includes("semanticscholar")) return {};
          if (url.includes("dblp")) {
            return { result: { hits: { hit: [createDBLPFuzzyHit()] } } };
          }
          return {};
        },
      });
    }

    it("holds a fuzzy match for confirmation without importing it", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createSOAPPreprint(undefined, { date: "2024-09-17" });
      let importCalls = 0;
      const { queue, manager } = createUpdateManager({
        fetcher: fuzzyFetcher().fetcher,
        createItem: async (paper) => {
          importCalls++;
          return createJournalItem(paper);
        },
      });

      manager.createUpdateTasks([item]);
      await queue.onIdle();

      const row = manager.getRow(item.id);
      assert.equal(row?.status, "needs-confirmation");
      assert.ok(
        manager.getPendingPaper(item.id),
        "the candidate should be held for review",
      );
      assert.equal(importCalls, 0, "tentative matches must not be imported");
      const after = await getItem(item.id);
      assert.equal(after.itemType, "preprint", "item should be left untouched");
    });

    it("confirm imports and merges the confirmed candidate", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createSOAPPreprint(undefined, { date: "2024-09-17" });
      const { fetcher } = fuzzyFetcher();
      const { queue, manager } = createUpdateManager({ fetcher });

      manager.createUpdateTasks([item]);
      await queue.onIdle();
      assert.equal(manager.getRow(item.id)?.status, "needs-confirmation");

      await manager.confirm(item.id);
      await queue.onIdle();

      const row = manager.getRow(item.id);
      assert.equal(row?.status, "updated");
      assert.isUndefined(
        manager.getPendingPaper(item.id),
        "pending paper should be cleared",
      );
      const merged = await getItem(item.id);
      assert.equal(merged.itemType, "journalArticle");
      assert.equal(merged.getField("DOI"), "10.5555/soap-example");
    });

    it("skip marks the row up-to-date when the arXiv source is disabled", async function () {
      setPluginPref("downloadJournalPDF", false);
      setPluginPref("updateSource.arXiv", false);
      const item = await createSOAPPreprint(undefined, { date: "2024-09-17" });
      const { fetcher } = fuzzyFetcher();
      const { queue, manager } = createUpdateManager({ fetcher });

      manager.createUpdateTasks([item]);
      await queue.onIdle();
      assert.equal(manager.getRow(item.id)?.status, "needs-confirmation");

      await manager.skip(item.id);
      await queue.onIdle();

      const row = manager.getRow(item.id);
      assert.equal(row?.status, "up-to-date");
      assert.equal(row?.message, getString("review-message", "skipped"));
    });

    it("skip falls back to the arXiv self-update when enabled", async function () {
      setPluginPref("downloadJournalPDF", false);
      setPluginPref("updateSource.arXiv", true);
      const item = await createSOAPPreprint(undefined, { date: "2024-09-17" });
      const { fetcher } = createFetcher({
        fetchText: async () => "<html><strong>[v2]</strong></html>",
        fetchJSON: async (url) => {
          if (url.includes("semanticscholar")) return {};
          if (url.includes("dblp")) {
            return { result: { hits: { hit: [createDBLPFuzzyHit()] } } };
          }
          return {};
        },
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
      assert.equal(manager.getRow(item.id)?.status, "needs-confirmation");

      await manager.skip(item.id);
      await queue.onIdle();

      const row = manager.getRow(item.id);
      assert.equal(row?.status, "updated");
      assert.deepEqual(located, {
        url: "https://arxiv.org/abs/2409.11321",
        title: "v2 PDF",
      });
    });

    it("a waiting confirmation does not block other items", async function () {
      setPluginPref("downloadJournalPDF", false);
      const a = await createSOAPPreprint("https://arxiv.org/abs/1111.1111", {
        date: "2024-09-17",
      });
      const b = await createPreprintItem("https://arxiv.org/abs/2222.2222", {
        title: "Paper B",
      });
      const c = await createPreprintItem("https://arxiv.org/abs/3333.3333", {
        title: "Paper C",
      });
      const { fetcher } = createFetcher({
        fetchText: async (url) => {
          if (url.includes("2222")) return '<html data-doi="10.5555/b"></html>';
          if (url.includes("3333")) return '<html data-doi="10.5555/c"></html>';
          return "<html></html>"; // item A: no related DOI
        },
        fetchJSON: async (url) => {
          if (url.includes("semanticscholar")) return {};
          if (url.includes("dblp")) {
            return { result: { hits: { hit: [createDBLPFuzzyHit()] } } };
          }
          return {};
        },
      });
      const { queue, manager } = createUpdateManager({ fetcher });

      manager.createUpdateTasks([a, b, c]);
      await queue.onIdle();

      assert.equal(
        manager.getRow(a.id)?.status,
        "needs-confirmation",
        "item A should be waiting on the user",
      );
      assert.equal(
        manager.getRow(b.id)?.status,
        "updated",
        "waiting item A must not block item B",
      );
      assert.equal(
        manager.getRow(c.id)?.status,
        "updated",
        "waiting item A must not block item C",
      );
      assert.ok(manager.getPendingPaper(a.id));
    });

    it("confirmations are throttled through the queue, not run inline", async function () {
      setPluginPref("downloadJournalPDF", false);
      const a = await createSOAPPreprint("https://arxiv.org/abs/1111.1111", {
        date: "2024-09-17",
      });
      const b = await createSOAPPreprint("https://arxiv.org/abs/2222.2222", {
        date: "2024-09-17",
      });
      const { fetcher } = createFetcher({
        fetchText: async () => "<html></html>",
        fetchJSON: async (url) => {
          if (url.includes("semanticscholar")) return {};
          if (url.includes("dblp")) {
            return { result: { hits: { hit: [createDBLPFuzzyHit()] } } };
          }
          return {};
        },
      });
      let concurrent = 0;
      let maxConcurrent = 0;
      const { queue, manager } = createUpdateManager({
        fetcher,
        createItem: async (paper) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await Zotero.Promise.delay(30);
          concurrent--;
          return createJournalItem(paper);
        },
      });

      manager.createUpdateTasks([a, b]);
      await queue.onIdle();
      assert.equal(manager.getRow(a.id)?.status, "needs-confirmation");
      assert.equal(manager.getRow(b.id)?.status, "needs-confirmation");

      await manager.confirm(a.id);
      await manager.confirm(b.id);
      await queue.onIdle();

      assert.equal(manager.getRow(a.id)?.status, "updated");
      assert.equal(manager.getRow(b.id)?.status, "updated");
      assert.equal(maxConcurrent, 1, "imports must run one at a time");
    });

    it("re-running update while a row awaits confirmation does not re-find", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createSOAPPreprint(undefined, { date: "2024-09-17" });
      const { fetcher, calls } = fuzzyFetcher();
      const { queue, manager } = createUpdateManager({ fetcher });

      manager.createUpdateTasks([item]);
      await queue.onIdle();
      const pending = manager.getPendingPaper(item.id);
      const callCount = calls.length;

      manager.createUpdateTasks([item]);
      await queue.onIdle();

      assert.lengthOf(manager.getRows(), 1);
      assert.equal(calls.length, callCount, "no new finder requests");
      assert.equal(manager.getRow(item.id)?.status, "needs-confirmation");
      assert.equal(manager.getPendingPaper(item.id), pending);
    });

    it("confirm or skip without a paused review is a no-op", async function () {
      setPluginPref("downloadJournalPDF", false);
      const item = await createSOAPPreprint(undefined, { date: "2024-09-17" });
      const { fetcher } = fuzzyFetcher();
      const { queue, manager } = createUpdateManager({ fetcher });

      manager.createUpdateTasks([item]);
      await queue.onIdle();
      assert.equal(manager.getRow(item.id)?.status, "needs-confirmation");

      // The review is already consumed (e.g. a duplicate click): confirm and
      // skip must no-op rather than re-run the task.
      manager.reviews.delete(item.id);
      const before = manager.getRow(item.id)?.status;
      await manager.confirm(item.id);
      await manager.skip(item.id);
      await queue.onIdle();

      assert.equal(manager.getRow(item.id)?.status, before);
    });
  });
});
