import { assert } from "chai";
import type { Fetcher } from "../src/modules/arxiv-update/paper-finder";
import {
  PaperFinder,
  extractOnlineVersion,
  extractPDFVersion,
  isKnownPreprintURL,
  localarXivVersion,
  matchTitle,
} from "../src/modules/arxiv-update/paper-finder";
import { clearLibrary, getPlugin, setPluginPref } from "./helpers";

const UPDATE_SOURCES = ["doi", "semanticScholar", "dblp", "pubmed", "arXiv"];

describe("paper-finder", function () {
  this.timeout(30000);

  before(function () {
    const plugin = getPlugin();
    assert.isDefined(plugin, "Plugin should be initialized");
  });

  afterEach(async function () {
    for (const source of UPDATE_SOURCES) {
      setPluginPref(`updateSource.${source}`, true);
    }
    await clearLibrary();
  });

  async function createPreprintItem(
    url: string,
    options: { title?: string; authorLastName?: string } = {},
  ) {
    const item = new Zotero.Item("preprint");
    item.setField("title", options.title ?? "Test paper title");
    item.setField("url", url);
    await item.saveTx();
    if (options.authorLastName) {
      item.setCreator(0, {
        firstName: "Jane",
        lastName: options.authorLastName,
        creatorType: "author",
      });
      await item.saveTx();
    }
    return item;
  }

  // Records every request so tests can assert on which finders ran and in
  // what order, while stubbing the response bodies.
  function createFetcher(
    handlers: {
      fetchText?: (url: string) => string | Promise<string>;
      fetchJSON?: (url: string) => unknown | Promise<unknown>;
    } = {},
  ) {
    const calls: Array<{ type: "text" | "json"; url: string }> = [];
    const fetcher: Fetcher = {
      fetchText: async (url) => {
        calls.push({ type: "text", url });
        return handlers.fetchText ? handlers.fetchText(url) : "";
      },
      fetchJSON: async <T = any>(url: string) => {
        calls.push({ type: "json", url });
        return (handlers.fetchJSON ? handlers.fetchJSON(url) : {}) as T;
      },
    };
    return { fetcher, calls };
  }

  describe("matchTitle", function () {
    it("matches case- and whitespace-insensitively", function () {
      assert.isTrue(matchTitle("Some Paper", "  some paper  "));
      assert.isTrue(matchTitle("Some Paper", "SOME PAPER"));
    });

    it("rejects non-string targets", function () {
      assert.isFalse(matchTitle("Some Paper", undefined));
      assert.isFalse(matchTitle("Some Paper", 42));
    });
  });

  describe("isKnownPreprintURL", function () {
    it("accepts all known preprint servers", function () {
      assert.isTrue(isKnownPreprintURL("https://arxiv.org/abs/1234.5678"));
      assert.isTrue(
        isKnownPreprintURL(
          "https://www.biorxiv.org/content/10.1101/2020.01.01.1v1",
        ),
      );
      assert.isTrue(
        isKnownPreprintURL(
          "https://www.medrxiv.org/content/10.1101/2020.01.01.1v1",
        ),
      );
      assert.isTrue(
        isKnownPreprintURL(
          "https://chemrxiv.org/engage/chemrxiv/article-details/9f8e7d6c5b4a3",
        ),
      );
      assert.isTrue(
        isKnownPreprintURL("https://osf.io/preprints/psyarxiv/abc"),
      );
    });

    it("rejects unknown hosts", function () {
      assert.isFalse(isKnownPreprintURL("https://example.com/paper"));
    });
  });

  describe("extractPDFVersion", function () {
    it("extracts the version from arXiv identifiers in full text", function () {
      assert.equal(extractPDFVersion("see arXiv:1234.5678v3 for details"), 3);
    });

    it("returns undefined when no version marker exists", function () {
      assert.isUndefined(extractPDFVersion("no version here"));
      assert.isUndefined(extractPDFVersion("arXiv:1234.5678"));
    });
  });

  describe("localarXivVersion", function () {
    it("tracks the maximum version across PDFs", function () {
      assert.deepEqual(
        localarXivVersion(["arXiv:1234.5678v2", "arXiv:1234.5678v5"]),
        {
          hasPDF: true,
          version: 5,
        },
      );
    });

    it("reports no PDF when the list is empty", function () {
      assert.deepEqual(localarXivVersion([]), { hasPDF: false, version: 0 });
    });

    it("keeps version 0 when no PDF text matches", function () {
      assert.deepEqual(localarXivVersion(["unrelated text"]), {
        hasPDF: true,
        version: 0,
      });
    });
  });

  describe("extractOnlineVersion", function () {
    it("extracts the version from an arXiv abstract page", function () {
      assert.equal(extractOnlineVersion("<strong>[v4]</strong>"), 4);
    });

    it("returns undefined when the page has no version", function () {
      assert.isUndefined(extractOnlineVersion("<html>not found</html>"));
    });
  });

  describe("PaperFinder constructor", function () {
    it("throws for URLs outside known preprint servers", async function () {
      const item = await createPreprintItem("https://example.com/paper");
      assert.throws(
        () => new PaperFinder(item, createFetcher().fetcher),
        /not a valid preprint server URL/,
      );
    });
  });

  describe("relatedDOI", function () {
    it("extracts the DOI from an arXiv abstract page", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher, calls } = createFetcher({
        fetchText: async () => '<html data-doi="10.1000/published"></html>',
      });
      const paper = await new PaperFinder(item, fetcher).relatedDOI();
      assert.deepEqual(paper, {
        doi: "10.1000/published",
        title: "Published PDF",
      });
      assert.deepEqual(calls, [
        { type: "text", url: "https://arxiv.org/abs/1234.5678" },
      ]);
    });

    it("returns undefined when the arXiv page has no DOI", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher } = createFetcher({
        fetchText: async () => "<html></html>",
      });
      assert.isUndefined(await new PaperFinder(item, fetcher).relatedDOI());
    });

    it("queries the biorxiv API for biorxiv preprints", async function () {
      const item = await createPreprintItem(
        "https://www.biorxiv.org/content/10.1101/2020.01.01.123456v1",
      );
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({
          collection: [{ published: "10.1101/2020.01.01.123456" }],
        }),
      });
      const paper = await new PaperFinder(item, fetcher).relatedDOI();
      assert.deepEqual(paper, {
        doi: "10.1101/2020.01.01.123456",
        title: "Published PDF",
      });
      assert.deepEqual(calls, [
        {
          type: "json",
          url: "https://api.biorxiv.org/details/biorxiv/10.1101/2020.01.01.123456",
        },
      ]);
    });

    it("queries the medrxiv API for medrxiv preprints", async function () {
      const item = await createPreprintItem(
        "https://www.medrxiv.org/content/10.1101/2020.01.02.123456v1",
      );
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({
          collection: [{ published: "10.1101/2020.01.02.123456" }],
        }),
      });
      const paper = await new PaperFinder(item, fetcher).relatedDOI();
      assert.deepEqual(paper, {
        doi: "10.1101/2020.01.02.123456",
        title: "Published PDF",
      });
      assert.deepEqual(calls, [
        {
          type: "json",
          url: "https://api.medrxiv.org/details/medrxiv/10.1101/2020.01.02.123456",
        },
      ]);
    });

    it("returns undefined for a biorxiv URL without a version suffix", async function () {
      const item = await createPreprintItem(
        "https://www.biorxiv.org/content/10.1101/2020.01.01.123456",
      );
      const { fetcher, calls } = createFetcher();
      assert.isUndefined(await new PaperFinder(item, fetcher).relatedDOI());
      assert.lengthOf(calls, 0);
    });

    it("uses the chemrxiv public API for chemrxiv preprints", async function () {
      const item = await createPreprintItem(
        "https://chemrxiv.org/engage/chemrxiv/article-details/9f8e7d6c5b4a3",
      );
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({
          vor: { vorDoi: "10.26434/chemrxiv-2023-abcd" },
        }),
      });
      const paper = await new PaperFinder(item, fetcher).relatedDOI();
      assert.deepEqual(paper, {
        doi: "10.26434/chemrxiv-2023-abcd",
        title: "Published PDF",
      });
      assert.deepEqual(calls, [
        {
          type: "json",
          url: "https://chemrxiv.org/engage/chemrxiv/public-api/v1/items/9f8e7d6c5b4a3",
        },
      ]);
    });

    it("returns undefined for other preprint hosts (e.g. psyarxiv)", async function () {
      const item = await createPreprintItem(
        "https://osf.io/preprints/psyarxiv/abc",
      );
      const { fetcher, calls } = createFetcher();
      assert.isUndefined(await new PaperFinder(item, fetcher).relatedDOI());
      assert.lengthOf(calls, 0);
    });
  });

  describe("semanticScholar", function () {
    it("resolves the DOI from Semantic Scholar externalIds", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({ externalIds: { DOI: "10.1000/published" } }),
      });
      const paper = await new PaperFinder(item, fetcher).semanticScholar();
      assert.deepEqual(paper, {
        doi: "10.1000/published",
        title: "Published PDF",
      });
      assert.deepEqual(calls, [
        {
          type: "json",
          url: "https://api.semanticscholar.org/graph/v1/paper/ARXIV:1234.5678?fields=externalIds",
        },
      ]);
    });

    it("ignores arXiv DOIs returned by Semantic Scholar", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher } = createFetcher({
        fetchJSON: async () => ({
          externalIds: { DOI: "10.48550/arXiv.1234.5678" },
        }),
      });
      assert.isUndefined(
        await new PaperFinder(item, fetcher).semanticScholar(),
      );
    });

    it("returns undefined when there are no externalIds", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher } = createFetcher({ fetchJSON: async () => ({}) });
      assert.isUndefined(
        await new PaperFinder(item, fetcher).semanticScholar(),
      );
    });

    it("does nothing for non-arXiv hosts", async function () {
      const item = await createPreprintItem(
        "https://www.biorxiv.org/content/10.1101/2020.01.01.123456v1",
      );
      const { fetcher, calls } = createFetcher();
      assert.isUndefined(
        await new PaperFinder(item, fetcher).semanticScholar(),
      );
      assert.lengthOf(calls, 0);
    });
  });

  describe("dblp", function () {
    const arxivItem = () =>
      createPreprintItem("https://arxiv.org/abs/1234.5678", {
        title: "Attention Is All You Need",
      });

    it("returns the DOI when a hit matches with a non-arXiv DOI", async function () {
      const item = await arxivItem();
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    key: "conf/nips/Vaswani17",
                    title: "Attention is all you need.",
                    venue: "NeurIPS",
                    year: 2017,
                    doi: "10.5555/3295222.3295349",
                    ee: "https://papers.nips.cc/paper/7181.pdf",
                  },
                },
              ],
            },
          },
        }),
      });
      const paper = await new PaperFinder(item, fetcher).dblp();
      assert.deepEqual(paper, {
        doi: "10.5555/3295222.3295349",
        title: "Published PDF",
      });
      assert.match(calls[0].url, /^https:\/\/dblp\.org\/search\/publ\/api\?q=/);
    });

    it("skips CoRR records and uses the next hit", async function () {
      const item = await arxivItem();
      const { fetcher } = createFetcher({
        fetchJSON: async () => ({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    key: "journals/corr/Vaswani17",
                    title: "Attention is all you need.",
                    venue: "CoRR",
                    year: 2017,
                    url: "https://arxiv.org/abs/1706.03762",
                  },
                },
                {
                  info: {
                    key: "conf/nips/Vaswani17",
                    title: "Attention is all you need.",
                    venue: "NeurIPS",
                    year: 2017,
                    doi: "10.5555/3295222.3295349",
                  },
                },
              ],
            },
          },
        }),
      });
      const paper = await new PaperFinder(item, fetcher).dblp();
      assert.deepEqual(paper, {
        doi: "10.5555/3295222.3295349",
        title: "Published PDF",
      });
    });

    it("skips records whose page points back to arXiv", async function () {
      const item = await arxivItem();
      const { fetcher } = createFetcher({
        fetchJSON: async () => ({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    key: "journals/corr/Vaswani17",
                    title: "Attention is all you need.",
                    venue: "arXiv",
                    year: 2017,
                    ee: "https://arxiv.org/abs/1706.03762",
                  },
                },
                {
                  info: {
                    key: "conf/nips/Vaswani17",
                    title: "Attention is all you need.",
                    venue: "NeurIPS",
                    year: 2017,
                    url: "https://papers.nips.cc/paper/7181",
                  },
                },
              ],
            },
          },
        }),
      });
      const paper = await new PaperFinder(item, fetcher).dblp();
      assert.deepEqual(paper, {
        url: "https://papers.nips.cc/paper/7181",
        title: "Published PDF",
      });
    });

    it("rewrites openreview links to the DBLP BibTeX view", async function () {
      const item = await arxivItem();
      const { fetcher } = createFetcher({
        fetchJSON: async () => ({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    key: "conf/iclr/Example19",
                    title: "Attention is all you need.",
                    venue: "ICLR",
                    year: 2019,
                    ee: "https://openreview.net/forum?id=abc",
                  },
                },
              ],
            },
          },
        }),
      });
      const paper = await new PaperFinder(item, fetcher).dblp();
      assert.deepEqual(paper, {
        url: "https://dblp.org/rec/conf/iclr/Example19.html?view=bibtex",
        title: "Published PDF",
      });
    });

    it("returns undefined when no hit matches the title", async function () {
      const item = await arxivItem();
      const { fetcher } = createFetcher({
        fetchJSON: async () => ({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    key: "x",
                    title: "A different paper",
                    venue: "NeurIPS",
                    year: 2017,
                  },
                },
              ],
            },
          },
        }),
      });
      assert.isUndefined(await new PaperFinder(item, fetcher).dblp());
    });

    it("returns undefined when there are no hits", async function () {
      const item = await arxivItem();
      const { fetcher } = createFetcher({
        fetchJSON: async () => ({ result: { hits: { hit: [] } } }),
      });
      assert.isUndefined(await new PaperFinder(item, fetcher).dblp());
    });

    it("narrows the query with the first author when present", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678", {
        title: "Attention Is All You Need",
        authorLastName: "Vaswani",
      });
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({ result: { hits: { hit: [] } } }),
      });
      await new PaperFinder(item, fetcher).dblp();
      assert.include(
        decodeURIComponent(calls[0].url),
        "Attention Is All You Need Vaswani",
      );
    });

    it("queries with the title only when the item has no authors", async function () {
      const item = await arxivItem();
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({ result: { hits: { hit: [] } } }),
      });
      await new PaperFinder(item, fetcher).dblp();
      assert.include(
        decodeURIComponent(calls[0].url),
        "Attention Is All You Need",
      );
      assert.notInclude(decodeURIComponent(calls[0].url), "Vaswani");
    });
  });

  describe("pubMed", function () {
    const item = () =>
      createPreprintItem("https://arxiv.org/abs/1234.5678", {
        title: "Attention Is All You Need",
      });

    it("resolves the DOI from esearch + esummary", async function () {
      const { fetcher, calls } = createFetcher({
        fetchJSON: async (url) =>
          url.includes("esearch")
            ? { esearchresult: { idlist: ["12345"] } }
            : {
                result: {
                  "12345": {
                    title: "Attention Is All You Need.",
                    articleids: [{ idtype: "doi", value: "10.1000/published" }],
                  },
                },
              },
      });
      const paper = await new PaperFinder(await item(), fetcher).pubMed();
      assert.deepEqual(paper, {
        doi: "10.1000/published",
        title: "Published PDF",
      });
      assert.lengthOf(calls, 2);
      assert.match(calls[0].url, /esearch\.fcgi/);
      assert.match(calls[1].url, /esummary\.fcgi\?db=pubmed&id=12345/);
    });

    it("returns undefined when the summary title does not match", async function () {
      const { fetcher } = createFetcher({
        fetchJSON: async (url) =>
          url.includes("esearch")
            ? { esearchresult: { idlist: ["12345"] } }
            : {
                result: {
                  "12345": {
                    title: "Something Else",
                    articleids: [{ idtype: "doi", value: "10.1000/published" }],
                  },
                },
              },
      });
      assert.isUndefined(await new PaperFinder(await item(), fetcher).pubMed());
    });

    it("returns undefined when the search has no results", async function () {
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({ esearchresult: { idlist: [] } }),
      });
      assert.isUndefined(await new PaperFinder(await item(), fetcher).pubMed());
      assert.lengthOf(calls, 1);
    });

    it("returns undefined when no DOI article id is present", async function () {
      const { fetcher } = createFetcher({
        fetchJSON: async (url) =>
          url.includes("esearch")
            ? { esearchresult: { idlist: ["12345"] } }
            : {
                result: {
                  "12345": {
                    title: "Attention Is All You Need.",
                    articleids: [{ idtype: "pmid", value: "12345" }],
                  },
                },
              },
      });
      assert.isUndefined(await new PaperFinder(await item(), fetcher).pubMed());
    });
  });

  describe("arXivPDF", function () {
    it("returns the download candidate when there is no local PDF", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher } = createFetcher({
        fetchText: async () => "<html><strong>[v2]</strong></html>",
      });
      const paper = await new PaperFinder(item, fetcher).arXivPDF();
      assert.deepEqual(paper, {
        url: "https://arxiv.org/abs/1234.5678",
        title: "v2 PDF",
      });
    });

    it("returns undefined when the abstract page has no version", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher } = createFetcher({
        fetchText: async () => "<html></html>",
      });
      assert.isUndefined(await new PaperFinder(item, fetcher).arXivPDF());
    });

    it("does nothing for non-arXiv hosts", async function () {
      const item = await createPreprintItem(
        "https://www.biorxiv.org/content/10.1101/2020.01.01.123456v1",
      );
      const { fetcher, calls } = createFetcher();
      assert.isUndefined(await new PaperFinder(item, fetcher).arXivPDF());
      assert.lengthOf(calls, 0);
    });
  });

  describe("find", function () {
    it("returns the first hit and short-circuits later finders", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher, calls } = createFetcher({
        fetchText: async () => '<html data-doi="10.1000/published"></html>',
      });
      const paper = await new PaperFinder(item, fetcher).find();
      assert.deepEqual(paper, {
        doi: "10.1000/published",
        title: "Published PDF",
      });
      assert.lengthOf(calls, 1);
      assert.equal(calls[0].type, "text");
    });

    it("consults finders in pref order when earlier ones miss", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678", {
        title: "Attention Is All You Need",
      });
      const { fetcher, calls } = createFetcher({
        fetchText: async () => "<html></html>",
        fetchJSON: async (url) =>
          url.includes("semanticscholar")
            ? { externalIds: { DOI: "10.1000/published" } }
            : {},
      });
      const paper = await new PaperFinder(item, fetcher).find();
      assert.deepEqual(paper, {
        doi: "10.1000/published",
        title: "Published PDF",
      });
      assert.lengthOf(calls, 2);
      assert.equal(calls[0].type, "text");
      assert.match(calls[1].url, /semanticscholar/);
    });

    it("respects disabled sources via prefs", async function () {
      setPluginPref("updateSource.doi", false);
      setPluginPref("updateSource.semanticScholar", false);
      setPluginPref("updateSource.dblp", true);
      setPluginPref("updateSource.pubmed", false);
      setPluginPref("updateSource.arXiv", false);
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678", {
        title: "Attention Is All You Need",
      });
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    key: "k",
                    title: "Attention Is All You Need",
                    venue: "NeurIPS",
                    year: 2017,
                    doi: "10.1000/published",
                  },
                },
              ],
            },
          },
        }),
      });
      const paper = await new PaperFinder(item, fetcher).find();
      assert.deepEqual(paper, {
        doi: "10.1000/published",
        title: "Published PDF",
      });
      assert.lengthOf(calls, 1);
      assert.match(calls[0].url, /dblp\.org/);
    });

    it("continues when a finder throws", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher } = createFetcher({
        fetchText: async () => {
          throw new Error("network down");
        },
        fetchJSON: async () => ({ externalIds: { DOI: "10.1000/published" } }),
      });
      const paper = await new PaperFinder(item, fetcher).find();
      assert.deepEqual(paper, {
        doi: "10.1000/published",
        title: "Published PDF",
      });
    });

    it("returns undefined when no finder succeeds", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher, calls } = createFetcher();
      assert.isUndefined(await new PaperFinder(item, fetcher).find());
      assert.deepEqual(
        calls.map((c) => c.type),
        ["text", "json", "json", "json", "text"],
      );
    });
  });
});
