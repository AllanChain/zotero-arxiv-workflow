import { assert } from "chai";
import { config } from "../package.json";
import type Addon from "../src/addon";
import { getPlugin, getAllItems } from "./helpers";

describe("merge", function () {
  let plugin: Addon;
  let preprintItem: Zotero.Item;
  let publishedItem: Zotero.Item;
  this.timeout(30000);

  before(async function () {
    plugin = getPlugin();
    assert.isDefined(plugin, "Plugin should be initialized");

    preprintItem = new Zotero.Item("preprint");
    preprintItem.setCreators([
      {
        firstName: "Ruichen",
        lastName: "Li",
        creatorType: "author",
      },
    ]);
    preprintItem.setField(
      "title",
      "Forward Laplacian: A New Computational Framework for Neural Network-based Variational Monte Carlo",
    );
    preprintItem.setField("date", "2023-07-16");
    preprintItem.setField("shortTitle", "Forward Laplacian");
    preprintItem.setField("libraryCatalog", "arXiv.org");
    preprintItem.setField("url", "http://arxiv.org/abs/2307.08214");
    preprintItem.setField("DOI", "10.48550/arXiv.2307.08214");
    preprintItem.setField("repository", "arXiv");
    preprintItem.setField("citationKey", "li_lapnet_2023");
    preprintItem.setField("archiveID", "arXiv:2307.08214");
    await preprintItem.saveTx();

    publishedItem = new Zotero.Item("journalArticle");
    publishedItem.setCreators([
      {
        firstName: "Ruichen",
        lastName: "Li",
        creatorType: "author",
      },
    ]);
    publishedItem.setField(
      "title",
      "A computational framework for neural network-based variational Monte Carlo with Forward Laplacian",
    );
    publishedItem.setField("date", "2024-02");
    publishedItem.setField("language", "en");
    publishedItem.setField("libraryCatalog", "www.nature.com");
    publishedItem.setField(
      "url",
      "https://www.nature.com/articles/s42256-024-00794-x",
    );
    publishedItem.setField(
      "rights",
      "2024 The Author(s), under exclusive licence to Springer Nature Limited",
    );
    publishedItem.setField("extra", "Publisher: Nature Publishing Group");
    publishedItem.setField("volume", "6");
    publishedItem.setField("pages", "209-219");
    publishedItem.setField("publicationTitle", "Nature Machine Intelligence");
    publishedItem.setField("DOI", "10.1038/s42256-024-00794-x");
    publishedItem.setField("issue", "2");
    publishedItem.setField("journalAbbreviation", "Nat Mach Intell");
    publishedItem.setField("ISSN", "2522-5839");
    await publishedItem.saveTx();
  });

  after(async function () {
    await Promise.all((await getAllItems()).map((item) => item.eraseTx()));
    await Zotero.Items.emptyTrash(Zotero.Libraries.userLibraryID);
  });

  it("should be able to merge items", async function () {
    await plugin.api.merge(preprintItem, publishedItem, true);
    const items = await getAllItems();
    assert.lengthOf(items, 1);
    const mergedItem = items[0];
    assert.equal(
      preprintItem.id,
      mergedItem.id,
      "Merged item should reused ID of the preprint",
    );
    assert.notEqual(
      publishedItem.id,
      mergedItem.id,
      "Published item should be removed",
    );
    assert.equal(
      mergedItem.getDisplayTitle(),
      publishedItem.getDisplayTitle(),
      "Merged item should have the same title as the published one",
    );
    assert.isEmpty(mergedItem.getField("shortTitle"));
    assert.notInclude(mergedItem.getField("DOI").toLowerCase(), "arxiv");
  });
});
