import { assert } from "chai";
import type Addon from "../src/addon";
import { clearLibrary, getPlugin, setPluginPref } from "./helpers";

describe("merge", function () {
  let plugin: Addon;

  this.timeout(30000);

  before(function () {
    plugin = getPlugin();
    assert.isDefined(plugin, "Plugin should be initialized");
  });

  afterEach(async function () {
    setPluginPref("merge.arXivURL", false);
    setPluginPref("merge.arXivExtra", false);
    await clearLibrary();
  });

  async function createMergeItems(
    options: {
      preprintExtra?: string;
      publishedExtra?: string;
    } = {},
  ) {
    const preprintItem = new Zotero.Item("preprint");
    preprintItem.setField("title", "Preprint title");
    preprintItem.setField("url", "https://arxiv.org/abs/1234.5678");
    preprintItem.setField("DOI", "10.48550/arXiv.1234.5678");
    preprintItem.setField("archiveID", "arXiv:1234.5678");
    if (options.preprintExtra !== undefined) {
      preprintItem.setField("extra", options.preprintExtra);
    }
    await preprintItem.saveTx();

    const publishedItem = new Zotero.Item("journalArticle");
    publishedItem.setField("title", "Published title");
    publishedItem.setField("url", "https://example.com/published");
    publishedItem.setField("DOI", "10.1000/published");
    if (options.publishedExtra !== undefined) {
      publishedItem.setField("extra", options.publishedExtra);
    }
    await publishedItem.saveTx();

    return { preprintItem, publishedItem };
  }

  it("should keep the arXiv URL when merge.arXivURL is enabled", async function () {
    setPluginPref("merge.arXivURL", true);
    const { preprintItem, publishedItem } = await createMergeItems();

    await plugin.api.merge(preprintItem, publishedItem, true);

    const mergedItem = await Zotero.Items.getAsync(preprintItem.id);
    assert.equal(
      mergedItem.getField("url"),
      "https://arxiv.org/abs/1234.5678",
      "Merged item should keep the preprint URL when configured",
    );
  });

  it("should remove arXiv lines from extra by default", async function () {
    const { preprintItem, publishedItem } = await createMergeItems({
      preprintExtra: "arXiv:1234.5678\nKept note",
      publishedExtra: "Published note",
    });

    await plugin.api.merge(preprintItem, publishedItem, true);

    const mergedItem = await Zotero.Items.getAsync(preprintItem.id);
    const extra = mergedItem.getField("extra");
    assert.include(extra, "Published note");
    assert.include(extra, "Kept note");
    assert.notInclude(extra, "arXiv:1234.5678");
  });

  it("should keep arXiv lines from extra when merge.arXivExtra is enabled", async function () {
    setPluginPref("merge.arXivExtra", true);
    const { preprintItem, publishedItem } = await createMergeItems({
      preprintExtra: "arXiv:1234.5678\nKept note",
    });

    await plugin.api.merge(preprintItem, publishedItem, true);

    const mergedItem = await Zotero.Items.getAsync(preprintItem.id);
    const extra = mergedItem.getField("extra");
    assert.include(extra, "arXiv:1234.5678");
    assert.include(extra, "Kept note");
  });
});
