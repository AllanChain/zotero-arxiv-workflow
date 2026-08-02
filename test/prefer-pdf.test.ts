import { assert } from "chai";
import type Addon from "../src/addon";
import { clearLibrary, createPDFAttachment, getPlugin } from "./helpers";

describe("prefer PDF", function () {
  let plugin: Addon;

  this.timeout(30000);

  before(function () {
    plugin = getPlugin();
    assert.isDefined(plugin, "Plugin should be initialized");
  });

  afterEach(async function () {
    await clearLibrary();
  });

  it("should make the selected PDF the preferred attachment", async function () {
    const parentItem = new Zotero.Item("journalArticle");
    parentItem.setField("title", "Preferred PDF test");
    parentItem.setField("url", "https://example.com/article");
    await parentItem.saveTx();

    const olderPDF = await createPDFAttachment(parentItem, {
      path: "/tmp/older.pdf",
      title: "Older PDF",
      url: "https://example.com/older.pdf",
    });
    const selectedPDF = await createPDFAttachment(parentItem, {
      path: "/tmp/newer.pdf",
      title: "Newer PDF",
      url: "https://example.com/newer.pdf",
    });

    assert.isTrue(olderPDF.isPDFAttachment());
    assert.isTrue(selectedPDF.isPDFAttachment());

    olderPDF.dateAdded = new Date("2024-01-01T00:00:00.000Z").toISOString();
    await olderPDF.saveTx();
    selectedPDF.dateAdded = new Date("2024-01-02T00:00:00.000Z").toISOString();
    await selectedPDF.saveTx();

    await plugin.api.preferPDF(selectedPDF);

    const updatedSelectedPDF = await Zotero.Items.getAsync(selectedPDF.id);
    assert.equal(
      updatedSelectedPDF.getField("url"),
      parentItem.getField("url"),
      "Selected PDF should reuse the parent URL",
    );
    assert.isBelow(
      new Date(updatedSelectedPDF.dateAdded).getTime(),
      new Date(olderPDF.dateAdded).getTime(),
      "Selected PDF should become older than the previous preferred PDF",
    );
  });

  it("should ignore non-PDF attachments when finding the oldest", async function () {
    const parentItem = new Zotero.Item("journalArticle");
    parentItem.setField("title", "Mixed attachments test");
    parentItem.setField("url", "https://example.com/article");
    await parentItem.saveTx();

    // Create a non-PDF attachment with a very old date
    const link = new Zotero.Item("attachment");
    link.libraryID = parentItem.libraryID;
    link.parentItemID = parentItem.id;
    link.attachmentLinkMode = Zotero.Attachments.LINK_MODE_LINKED_URL;
    link.attachmentContentType = "text/html";
    link.setField("title", "Webpage");
    link.setField("url", "https://example.com/page");
    await link.saveTx();
    link.dateAdded = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await link.saveTx();

    const pdf = await createPDFAttachment(parentItem, {
      path: "/tmp/test.pdf",
      title: "Test PDF",
      url: "https://example.com/test.pdf",
    });

    await plugin.api.preferPDF(pdf);

    const updatedPDF = await Zotero.Items.getAsync(pdf.id);
    assert.equal(
      updatedPDF.getField("url"),
      parentItem.getField("url"),
      "PDF should inherit parent URL even with older non-PDF sibling",
    );
    assert.isAbove(
      new Date(updatedPDF.dateAdded).getTime(),
      new Date(link.dateAdded).getTime(),
      "Non-PDF attachments should be ignored when computing oldest date",
    );
  });
});
