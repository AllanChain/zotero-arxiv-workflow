import { assert } from "chai";
import type Addon from "../src/addon";
import {
  clearLibrary,
  clearPluginPref,
  createLinkAttachment,
  createPDFAttachment,
  getPlugin,
  setPluginPref,
} from "./helpers";

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
    setPluginPref("merge.trashUnannotatedPDF", false);
    setPluginPref("mergePreferJournalPDF", true);
    clearPluginPref("merge.reservedKeys");
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

  it("should not duplicate extra notes when extra is reserved", async function () {
    setPluginPref(
      "merge.reservedKeys",
      "collections,dateAdded,dateModified,key,tags,relations,extra",
    );
    const { preprintItem, publishedItem } = await createMergeItems({
      preprintExtra: "Citations: 53",
      publishedExtra: "Published note",
    });

    await plugin.api.merge(preprintItem, publishedItem, true);

    const mergedItem = await Zotero.Items.getAsync(preprintItem.id);
    const extra = mergedItem.getField("extra");
    assert.equal(extra, "Citations: 53");
  });

  it("should merge items without extra when extra is reserved", async function () {
    setPluginPref(
      "merge.reservedKeys",
      "collections,dateAdded,dateModified,key,tags,relations,extra",
    );
    const { preprintItem, publishedItem } = await createMergeItems();

    await plugin.api.merge(preprintItem, publishedItem, true);

    const mergedItem = await Zotero.Items.getAsync(preprintItem.id);
    assert.equal(mergedItem.getField("extra"), "");
  });

  it("should trash unannotated PDFs and keep annotated ones when merge.trashUnannotatedPDF is enabled", async function () {
    setPluginPref("merge.trashUnannotatedPDF", true);
    const { preprintItem, publishedItem } = await createMergeItems();

    await createPDFAttachment(preprintItem, {
      path: "/tmp/unannotated.pdf",
      title: "Unannotated PDF",
      url: "https://example.com/unannotated.pdf",
    });

    const annotatedPDF = await createPDFAttachment(preprintItem, {
      path: "/tmp/annotated.pdf",
      title: "Annotated PDF",
      url: "https://example.com/annotated.pdf",
    });

    const annotation = new Zotero.Item("annotation");
    annotation.libraryID = annotatedPDF.libraryID;
    annotation.key = Zotero.DataObjectUtilities.generateKey();
    await annotation.loadPrimaryData();
    annotation.parentID = annotatedPDF.id;
    annotation.annotationType = "note";
    annotation.annotationComment = "Test annotation";
    annotation.annotationColor = "#ffd400";
    annotation.annotationSortIndex = "00000|000000|00000";
    annotation.annotationPosition = JSON.stringify({
      pageIndex: 0,
      rects: [[0, 0, 100, 10]],
    });
    await annotation.saveTx();

    await plugin.api.merge(preprintItem, publishedItem, true);

    const mergedItem = await Zotero.Items.getAsync(preprintItem.id);
    const pdfIDs = mergedItem.getAttachments().filter((id: number) => {
      const att = Zotero.Items.get(id);
      return att && att.isPDFAttachment();
    });
    assert.lengthOf(
      pdfIDs,
      1,
      "Only the annotated PDF should survive the merge",
    );
    const survivingPDF = Zotero.Items.get(pdfIDs[0]);
    assert.equal(survivingPDF.getField("title"), "Annotated PDF");
  });

  it("should not create a link attachment when preprint already has a snapshot", async function () {
    const { preprintItem, publishedItem } = await createMergeItems();

    await createLinkAttachment(preprintItem, {
      url: "https://arxiv.org/abs/1234.5678",
      title: "arXiv:1234.5678",
      contentType: "text/html",
      snapshot: true,
    });

    await plugin.api.merge(preprintItem, publishedItem, true);

    const mergedItem = await Zotero.Items.getAsync(preprintItem.id);
    const linkAttachmentCount = mergedItem
      .getAttachments()
      .filter((id: number) => {
        const att = Zotero.Items.get(id);
        return att && !att.isPDFAttachment() && att.isSnapshotAttachment();
      }).length;
    assert.isAtMost(
      linkAttachmentCount,
      1,
      "Should not create a duplicate link when a snapshot exists",
    );
  });

  it("should merge a preprint with a conferencePaper", async function () {
    const preprintItem = new Zotero.Item("preprint");
    preprintItem.setField("title", "Preprint title");
    preprintItem.setField("url", "https://arxiv.org/abs/1234.5678");
    preprintItem.setField("DOI", "10.48550/arXiv.1234.5678");
    preprintItem.setField("archiveID", "arXiv:1234.5678");
    preprintItem.addTag("preprint-tag");
    await preprintItem.saveTx();

    const publishedItem = new Zotero.Item("conferencePaper");
    publishedItem.setField("title", "Published title");
    publishedItem.setField(
      "conferenceName",
      "International Conference on Testing",
    );
    publishedItem.setField("proceedingsTitle", "Proceedings of ICT");
    publishedItem.setField("DOI", "10.1000/published");
    await publishedItem.saveTx();

    await plugin.api.merge(preprintItem, publishedItem, true);

    const mergedItem = await Zotero.Items.getAsync(preprintItem.id);
    assert.equal(mergedItem.getDisplayTitle(), "Published title");
    assert.equal(mergedItem.itemType, "conferencePaper");
    assert.equal(
      mergedItem.getField("conferenceName"),
      "International Conference on Testing",
    );
    assert.equal(mergedItem.getField("proceedingsTitle"), "Proceedings of ICT");

    const tags = mergedItem.getTags().map((t: { tag: string }) => t.tag);
    assert.include(tags, "preprint-tag");
  });

  it("should prefer journal PDF when mergePreferJournalPDF is enabled", async function () {
    setPluginPref("mergePreferJournalPDF", true);
    const { preprintItem, publishedItem } = await createMergeItems();

    const baseTime = new Date("2024-06-01T00:00:00.000Z").getTime();

    const preprintPDF = await createPDFAttachment(preprintItem, {
      path: "/tmp/preprint.pdf",
      title: "Preprint PDF",
      url: "https://arxiv.org/pdf/1234.5678",
    });
    preprintPDF.dateAdded = new Date(baseTime + 1000).toISOString();
    await preprintPDF.saveTx();

    const journalPDF = await createPDFAttachment(publishedItem, {
      path: "/tmp/journal.pdf",
      title: "Journal PDF",
      url: "https://example.com/journal.pdf",
    });
    journalPDF.dateAdded = new Date(baseTime + 2000).toISOString();
    await journalPDF.saveTx();

    await plugin.api.merge(preprintItem, publishedItem, true);

    const mergedItem = await Zotero.Items.getAsync(preprintItem.id);
    const pdfIDs = mergedItem.getAttachments().filter((id: number) => {
      const att = Zotero.Items.get(id);
      return att && att.isPDFAttachment();
    });
    assert.isAtLeast(pdfIDs.length, 2, "Both PDFs should be present");

    const dates: Record<string, number> = {};
    for (const id of pdfIDs) {
      const att = Zotero.Items.get(id);
      dates[att.getField("title")] = new Date(att.dateAdded).getTime();
    }
    assert.isBelow(
      dates["Journal PDF"],
      dates["Preprint PDF"],
      "Journal PDF should have an earlier dateAdded than Preprint PDF",
    );
  });
});
