import { assert } from "chai";
import { PaperFinder } from "@/modules/arxiv-update/paper-finder";
import { type SourceCheck, type SourceKey } from "@/types";
import { clearLibrary, getPlugin, setPluginPref } from "@test/helpers";
import {
  createFetcher,
  createPreprintItem,
  resetUpdateSourcePrefs,
} from "./helpers";

/** The states one key reported, in order. */
function checksFor(checks: SourceCheck[], key: SourceKey) {
  return checks
    .filter((check) => check.key === key)
    .map((check) => check.outcome);
}

describe("paper-finder progress", function () {
  this.timeout(30000);

  before(function () {
    const plugin = getPlugin();
    assert.isDefined(plugin, "Plugin should be initialized");
  });

  afterEach(async function () {
    resetUpdateSourcePrefs();
    await clearLibrary();
  });

  it("reports running then one terminal check for every enabled source", async function () {
    const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
    const { fetcher } = createFetcher(); // every source misses
    const checks: SourceCheck[] = [];

    await new PaperFinder(item, fetcher)
      .find((check) => checks.push(check))
      .next();

    // Order is not asserted: the run order lives in the finder. Each source
    // must report exactly once that it started and once that it ended.
    for (const key of [
      "relatedDOI",
      "semanticScholar",
      "dblp",
      "pubMed",
      "crossref",
      "arXivPDF",
    ] as const) {
      assert.deepEqual(checksFor(checks, key), ["running", "empty"], key);
    }
  });

  it("reports nothing for disabled sources", async function () {
    setPluginPref("updateSource.doi", false);
    setPluginPref("updateSource.semanticScholar", false);
    setPluginPref("updateSource.arXiv", false);
    const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
    const { fetcher } = createFetcher();
    const checks: SourceCheck[] = [];

    await new PaperFinder(item, fetcher)
      .find((check) => checks.push(check))
      .next();

    assert.deepEqual([...new Set(checks.map((check) => check.key))].sort(), [
      "crossref",
      "dblp",
      "pubMed",
    ]);
  });

  it("reports failed with the error detail when a source throws", async function () {
    const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
    const { fetcher } = createFetcher({
      fetchText: async () => {
        throw new Error("network down");
      },
      fetchJSON: async () => ({}),
    });
    const checks: SourceCheck[] = [];

    await new PaperFinder(item, fetcher)
      .find((check) => checks.push(check))
      .next();

    assert.deepEqual(
      checks.filter((check) => check.key === "relatedDOI"),
      [
        { key: "relatedDOI", outcome: "running" },
        {
          key: "relatedDOI",
          outcome: "failed",
          detail: "Error: network down",
        },
      ],
    );
  });

  it("stops reporting once a definitive match ends the run", async function () {
    const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
    const { fetcher } = createFetcher({
      fetchText: async () => '<html data-doi="10.1000/published"></html>',
    });
    const checks: SourceCheck[] = [];

    await new PaperFinder(item, fetcher)
      .find((check) => checks.push(check))
      .next();

    assert.deepEqual(
      checks.map((check) => check.key),
      ["relatedDOI", "relatedDOI"],
    );
    assert.deepEqual(
      checks.map((check) => check.outcome),
      ["running", "found"],
    );
  });
});
