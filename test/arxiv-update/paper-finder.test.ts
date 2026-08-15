import { assert } from "chai";
import {
  PaperFinder,
  extractOnlineVersion,
  extractPDFVersion,
  isKnownPreprintURL,
  localarXivVersion,
} from "@/modules/arxiv-update/paper-finder";
import {
  PaperIdentifier,
  isTentativePaperIdentifier,
  TentativePaperIdentifier,
} from "@/types";
import { FUZZY_TITLE_THRESHOLD } from "@/utils/title-match";
import { clearLibrary, getPlugin, setPluginPref } from "@test/helpers";
import {
  createDBLPFuzzyHit,
  createFetcher,
  createPreprintItem,
  createSOAPPreprint,
  resetUpdateSourcePrefs,
} from "./helpers";

// Run a finder pipeline to its first outcome: the final paper, the tentative
// candidate awaiting confirmation, or undefined. Tests that need to inspect
// the pause itself can drive `finder.find()` directly instead of using this
// helper.
async function runFinder(
  finder: PaperFinder,
): Promise<PaperIdentifier | undefined> {
  const step = await finder.find().next();
  return step.value;
}

describe("paper-finder", function () {
  this.timeout(30000);

  before(function () {
    const plugin = getPlugin();
    assert.isDefined(plugin, "Plugin should be initialized");
  });

  afterEach(async function () {
    resetUpdateSourcePrefs();
    await clearLibrary();
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
      const papers = await new PaperFinder(item, fetcher).relatedDOI();
      assert.deepEqual(papers, [
        { doi: "10.1000/published", title: "Published PDF" },
      ]);
      assert.deepEqual(calls, [
        { type: "text", url: "https://arxiv.org/abs/1234.5678" },
      ]);
    });

    it("returns an empty list when the arXiv page has no DOI", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher } = createFetcher({
        fetchText: async () => "<html></html>",
      });
      assert.deepEqual(await new PaperFinder(item, fetcher).relatedDOI(), []);
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
      const papers = await new PaperFinder(item, fetcher).relatedDOI();
      assert.deepEqual(papers, [
        { doi: "10.1101/2020.01.01.123456", title: "Published PDF" },
      ]);
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
      const papers = await new PaperFinder(item, fetcher).relatedDOI();
      assert.deepEqual(papers, [
        { doi: "10.1101/2020.01.02.123456", title: "Published PDF" },
      ]);
      assert.deepEqual(calls, [
        {
          type: "json",
          url: "https://api.medrxiv.org/details/medrxiv/10.1101/2020.01.02.123456",
        },
      ]);
    });

    it("returns an empty list for a biorxiv URL without a version suffix", async function () {
      const item = await createPreprintItem(
        "https://www.biorxiv.org/content/10.1101/2020.01.01.123456",
      );
      const { fetcher, calls } = createFetcher();
      assert.deepEqual(await new PaperFinder(item, fetcher).relatedDOI(), []);
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
      const papers = await new PaperFinder(item, fetcher).relatedDOI();
      assert.deepEqual(papers, [
        { doi: "10.26434/chemrxiv-2023-abcd", title: "Published PDF" },
      ]);
      assert.deepEqual(calls, [
        {
          type: "json",
          url: "https://chemrxiv.org/engage/chemrxiv/public-api/v1/items/9f8e7d6c5b4a3",
        },
      ]);
    });

    it("returns an empty list for other preprint hosts (e.g. psyarxiv)", async function () {
      const item = await createPreprintItem(
        "https://osf.io/preprints/psyarxiv/abc",
      );
      const { fetcher, calls } = createFetcher();
      assert.deepEqual(await new PaperFinder(item, fetcher).relatedDOI(), []);
      assert.lengthOf(calls, 0);
    });
  });

  describe("semanticScholar", function () {
    it("resolves the DOI from Semantic Scholar externalIds", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({ externalIds: { DOI: "10.1000/published" } }),
      });
      const papers = await new PaperFinder(item, fetcher).semanticScholar();
      assert.deepEqual(papers, [
        { doi: "10.1000/published", title: "Published PDF" },
      ]);
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
      assert.deepEqual(
        await new PaperFinder(item, fetcher).semanticScholar(),
        [],
      );
    });

    it("returns an empty list when there are no externalIds", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher } = createFetcher({ fetchJSON: async () => ({}) });
      assert.deepEqual(
        await new PaperFinder(item, fetcher).semanticScholar(),
        [],
      );
    });

    it("returns an empty list for non-arXiv hosts", async function () {
      const item = await createPreprintItem(
        "https://www.biorxiv.org/content/10.1101/2020.01.01.123456v1",
      );
      const { fetcher, calls } = createFetcher();
      assert.deepEqual(
        await new PaperFinder(item, fetcher).semanticScholar(),
        [],
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
      const papers = await new PaperFinder(item, fetcher).dblp();
      assert.deepEqual(papers, [
        { doi: "10.5555/3295222.3295349", title: "Published PDF" },
      ]);
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
      const papers = await new PaperFinder(item, fetcher).dblp();
      assert.deepEqual(papers, [
        { doi: "10.5555/3295222.3295349", title: "Published PDF" },
      ]);
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
      const papers = await new PaperFinder(item, fetcher).dblp();
      assert.deepEqual(papers, [
        { url: "https://papers.nips.cc/paper/7181", title: "Published PDF" },
      ]);
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
      const papers = await new PaperFinder(item, fetcher).dblp();
      assert.deepEqual(papers, [
        {
          url: "https://dblp.org/rec/conf/iclr/Example19.html?view=bibtex",
          title: "Published PDF",
        },
      ]);
    });

    it("returns an empty list when no hit matches the title", async function () {
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
      assert.deepEqual(await new PaperFinder(item, fetcher).dblp(), []);
    });

    it("returns an empty list when there are no hits", async function () {
      const item = await arxivItem();
      const { fetcher } = createFetcher({
        fetchJSON: async () => ({ result: { hits: { hit: [] } } }),
      });
      assert.deepEqual(await new PaperFinder(item, fetcher).dblp(), []);
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
      const papers = await new PaperFinder(await item(), fetcher).pubMed();
      assert.deepEqual(papers, [
        { doi: "10.1000/published", title: "Published PDF" },
      ]);
      assert.lengthOf(calls, 2);
      assert.match(calls[0].url, /esearch\.fcgi/);
      assert.match(calls[1].url, /esummary\.fcgi\?db=pubmed&id=12345/);
    });

    it("returns an empty list when the summary title does not match", async function () {
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
      assert.deepEqual(
        await new PaperFinder(await item(), fetcher).pubMed(),
        [],
      );
    });

    it("returns an empty list when the search has no results", async function () {
      const { fetcher, calls } = createFetcher({
        fetchJSON: async () => ({ esearchresult: { idlist: [] } }),
      });
      assert.deepEqual(
        await new PaperFinder(await item(), fetcher).pubMed(),
        [],
      );
      assert.lengthOf(calls, 1);
    });

    it("returns an empty list when no DOI article id is present", async function () {
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
      assert.deepEqual(
        await new PaperFinder(await item(), fetcher).pubMed(),
        [],
      );
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
      const paper = await runFinder(new PaperFinder(item, fetcher));
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
      const paper = await runFinder(new PaperFinder(item, fetcher));
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
      const paper = await runFinder(new PaperFinder(item, fetcher));
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
      const paper = await runFinder(new PaperFinder(item, fetcher));
      assert.deepEqual(paper, {
        doi: "10.1000/published",
        title: "Published PDF",
      });
    });

    it("returns undefined when no finder succeeds", async function () {
      const item = await createPreprintItem("https://arxiv.org/abs/1234.5678");
      const { fetcher, calls } = createFetcher();
      assert.isUndefined(await runFinder(new PaperFinder(item, fetcher)));
      assert.deepEqual(
        calls.map((c) => c.type),
        ["text", "json", "json", "json", "text"],
      );
    });
  });

  describe("fuzzy matching", function () {
    const SOAP_TITLE = "SOAP: Improving and Stabilizing Shampoo using Adam";
    const SOAP_HIT_TITLE =
      "SOAP: Improving and Stabilizing Shampoo using Adam for Language Modeling";

    describe("dblp fuzzy", function () {
      it("surfaces a passing fuzzy hit as a tentative candidate", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const { fetcher } = createFetcher({
          fetchJSON: async () => ({
            result: { hits: { hit: [createDBLPFuzzyHit()] } },
          }),
        });
        const [paper] = await new PaperFinder(item, fetcher).dblp();
        assert.ok(
          isTentativePaperIdentifier(paper),
          "fuzzy match should be tentative",
        );
        const t = paper as TentativePaperIdentifier;
        assert.equal(t.doi, "10.5555/soap-example");
        assert.equal(t.title, "Published PDF");
        assert.equal(t.candidate.source, "DBLP");
        assert.equal(t.candidate.publication, "ICLR");
        assert.equal(t.candidate.year, "2024");
        assert.isAtLeast(t.candidate.score, FUZZY_TITLE_THRESHOLD);
        assert.equal(t.candidate.candidateTitle, SOAP_HIT_TITLE);
        // No importable page on the record: the review link falls back to
        // the DOI resolver.
        assert.equal(t.candidate.url, "https://doi.org/10.5555/soap-example");
      });

      it("rejects a fuzzy hit whose first author does not match", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const { fetcher } = createFetcher({
          fetchJSON: async () => ({
            result: {
              hits: {
                hit: [
                  createDBLPFuzzyHit({
                    authors: { author: { text: "Andrew Ng" } },
                  }),
                ],
              },
            },
          }),
        });
        assert.deepEqual(await new PaperFinder(item, fetcher).dblp(), []);
      });

      it("rejects a fuzzy hit published before the preprint", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const { fetcher } = createFetcher({
          fetchJSON: async () => ({
            result: { hits: { hit: [createDBLPFuzzyHit({ year: "2023" })] } },
          }),
        });
        assert.deepEqual(await new PaperFinder(item, fetcher).dblp(), []);
      });

      it("passes a fuzzy hit for a preprint without a date", async function () {
        const item = await createSOAPPreprint();
        const { fetcher } = createFetcher({
          fetchJSON: async () => ({
            result: { hits: { hit: [createDBLPFuzzyHit()] } },
          }),
        });
        const [paper] = await new PaperFinder(item, fetcher).dblp();
        assert.ok(
          isTentativePaperIdentifier(paper),
          "dateless preprints should still surface candidates",
        );
      });

      it("returns every passing fuzzy hit in hit order", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const farther = createDBLPFuzzyHit({
          key: "conf/iclr/Vyas24b",
          doi: "10.5555/farther",
        });
        const closer = createDBLPFuzzyHit({
          key: "conf/iclr/Vyas24a",
          title: `${SOAP_TITLE} 2`,
          doi: "10.5555/closer",
        });
        const { fetcher } = createFetcher({
          fetchJSON: async () => ({
            result: { hits: { hit: [farther, closer] } },
          }),
        });
        const papers = await new PaperFinder(item, fetcher).dblp();
        assert.deepEqual(
          papers.map((p) => (p as TentativePaperIdentifier).doi),
          ["10.5555/farther", "10.5555/closer"],
        );
      });
    });

    describe("pubMed fuzzy", function () {
      it("surfaces a passing fuzzy hit among several candidates", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const { fetcher, calls } = createFetcher({
          fetchJSON: async (url) =>
            url.includes("esearch")
              ? { esearchresult: { idlist: ["1", "2"] } }
              : {
                  result: {
                    "1": {
                      title: "Something completely different",
                      articleids: [{ idtype: "doi", value: "10.5555/no" }],
                    },
                    "2": {
                      title: SOAP_HIT_TITLE,
                      pubdate: "2024 Feb 18",
                      fulljournalname: "JMLR",
                      authors: [{ name: "Nikhil Vyas 0001" }],
                      articleids: [{ idtype: "doi", value: "10.5555/pubmed" }],
                    },
                  },
                },
        });
        const [paper] = await new PaperFinder(item, fetcher).pubMed();
        assert.ok(
          isTentativePaperIdentifier(paper),
          "fuzzy match should be tentative",
        );
        const t = paper as TentativePaperIdentifier;
        assert.equal(t.doi, "10.5555/pubmed");
        assert.equal(t.candidate.source, "PubMed");
        assert.equal(t.candidate.publication, "JMLR");
        assert.equal(t.candidate.year, "2024 Feb 18");
        assert.equal(t.candidate.url, "https://pubmed.ncbi.nlm.nih.gov/2/");
        assert.match(calls[1].url, /id=1,2/);
      });

      it("rejects a fuzzy hit whose first author does not match", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const { fetcher } = createFetcher({
          fetchJSON: async (url) =>
            url.includes("esearch")
              ? { esearchresult: { idlist: ["2"] } }
              : {
                  result: {
                    "2": {
                      title: SOAP_HIT_TITLE,
                      pubdate: "2024 Feb 18",
                      authors: [{ name: "Andrew Ng" }],
                      articleids: [{ idtype: "doi", value: "10.5555/pubmed" }],
                    },
                  },
                },
        });
        assert.deepEqual(await new PaperFinder(item, fetcher).pubMed(), []);
      });

      it("skips an exact match without a DOI in favor of a fuzzy match with one", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const { fetcher } = createFetcher({
          fetchJSON: async (url) =>
            url.includes("esearch")
              ? { esearchresult: { idlist: ["1", "2"] } }
              : {
                  result: {
                    "1": {
                      title: SOAP_TITLE,
                      articleids: [{ idtype: "pmid", value: "1" }],
                    },
                    "2": {
                      title: SOAP_HIT_TITLE,
                      pubdate: "2024 Feb 18",
                      authors: [{ name: "Nikhil Vyas 0001" }],
                      articleids: [{ idtype: "doi", value: "10.5555/pubmed" }],
                    },
                  },
                },
        });
        const [paper] = await new PaperFinder(item, fetcher).pubMed();
        assert.ok(isTentativePaperIdentifier(paper));
        assert.equal((paper as TentativePaperIdentifier).doi, "10.5555/pubmed");
      });
    });

    describe("find with fuzzy candidates", function () {
      it("lets a definitive result from a later source beat an earlier fuzzy one", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const { fetcher, calls } = createFetcher({
          fetchText: async () => "<html></html>", // relatedDOI misses
          fetchJSON: async (url) => {
            if (url.includes("semanticscholar")) return {};
            if (url.includes("dblp")) {
              return { result: { hits: { hit: [createDBLPFuzzyHit()] } } };
            }
            if (url.includes("esearch")) {
              return { esearchresult: { idlist: ["2"] } };
            }
            return {
              result: {
                "2": {
                  title: SOAP_TITLE,
                  articleids: [{ idtype: "doi", value: "10.5555/definitive" }],
                },
              },
            };
          },
        });
        const paper = await runFinder(new PaperFinder(item, fetcher));
        assert.deepEqual(paper, {
          doi: "10.5555/definitive",
          title: "Published PDF",
        });
        assert.isFalse(
          isTentativePaperIdentifier(paper),
          "a definitive result should win over a fuzzy one",
        );
        // Tentative results do not short-circuit: later finders still run.
        assert.ok(calls.some((c) => c.url.includes("dblp")));
        assert.ok(calls.some((c) => c.url.includes("esearch")));
      });

      it("picks the strongest fuzzy candidate across sources", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const { fetcher } = createFetcher({
          fetchText: async () => "<html></html>",
          fetchJSON: async (url) => {
            if (url.includes("semanticscholar")) return {};
            if (url.includes("dblp")) {
              return { result: { hits: { hit: [createDBLPFuzzyHit()] } } };
            }
            if (url.includes("esearch")) {
              return { esearchresult: { idlist: ["2"] } };
            }
            return {
              result: {
                "2": {
                  title: `${SOAP_TITLE} 2`,
                  pubdate: "2024 Feb 18",
                  authors: [{ name: "Nikhil Vyas 0001" }],
                  articleids: [{ idtype: "doi", value: "10.5555/pubmed" }],
                },
              },
            };
          },
        });
        const paper = await runFinder(new PaperFinder(item, fetcher));
        assert.ok(isTentativePaperIdentifier(paper));
        assert.equal((paper as TentativePaperIdentifier).doi, "10.5555/pubmed");
        assert.equal(
          (paper as TentativePaperIdentifier).candidate.source,
          "PubMed",
        );
      });

      it("runs the arXiv self-update last when no candidate exists", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const { fetcher, calls } = createFetcher({
          fetchText: async () => "<html><strong>[v2]</strong></html>",
          fetchJSON: async () => ({}),
        });
        const paper = await runFinder(new PaperFinder(item, fetcher));
        assert.deepEqual(paper, {
          url: "https://arxiv.org/abs/2409.11321",
          title: "v2 PDF",
        });
        assert.deepEqual(
          calls.map((c) => c.type),
          ["text", "json", "json", "json", "text"],
        );
      });

      it("continues to the arXiv self-update after the tentative candidate is skipped", async function () {
        const item = await createSOAPPreprint(undefined, {
          date: "2024-09-17",
        });
        const { fetcher, calls } = createFetcher({
          fetchText: async () => "<html><strong>[v2]</strong></html>",
          fetchJSON: async (url) => {
            if (url.includes("semanticscholar")) return {};
            if (url.includes("dblp")) {
              return { result: { hits: { hit: [createDBLPFuzzyHit()] } } };
            }
            return {};
          },
        });
        const iterator = new PaperFinder(item, fetcher).find();
        const first = await iterator.next();
        assert.isFalse(
          first.done,
          "tentative candidate should pause the pipeline",
        );
        const paper = first.value;
        assert.ok(isTentativePaperIdentifier(paper));
        // Resuming the pipeline means the candidate was rejected.
        const second = await iterator.next();
        assert.deepEqual(second.value, {
          url: "https://arxiv.org/abs/2409.11321",
          title: "v2 PDF",
        });
        // relatedDOI's text call, the three JSON sources, and arXivPDF's
        // abstract-page fetch all run as part of one resumable pipeline.
        assert.deepEqual(
          calls.map((c) => c.type),
          ["text", "json", "json", "json", "text"],
        );
      });
    });
  });
});
