import { assert } from "chai";
import {
  authHeaders,
  parseJSONResponse,
} from "@/modules/arxiv-update/fetcher/base";
import { getPlugin, setPluginPref } from "@test/helpers";

describe("fetcher", function () {
  before(function () {
    const plugin = getPlugin();
    assert.isDefined(plugin, "Plugin should be initialized");
  });

  describe("authHeaders", function () {
    afterEach(function () {
      setPluginPref("updateSource.semanticScholar.apiKey", "");
    });

    it("adds the Semantic Scholar API key when one is set", function () {
      setPluginPref("updateSource.semanticScholar.apiKey", "secret");
      assert.deepEqual(
        authHeaders("https://api.semanticscholar.org/graph/v1/paper/x"),
        { "x-api-key": "secret" },
      );
    });

    it("omits the header without a key or on other hosts", function () {
      assert.deepEqual(
        authHeaders("https://api.semanticscholar.org/graph/v1/paper/x"),
        {},
      );
      assert.deepEqual(authHeaders("https://dblp.org/search/publ/api"), {});
    });
  });

  describe("parseJSONResponse", function () {
    it("parses a valid JSON body", function () {
      assert.deepEqual(
        parseJSONResponse(
          "https://dblp.org/search/publ/api",
          200,
          "application/json",
          '{"result":{"hits":[]}}',
        ),
        { result: { hits: [] } },
      );
    });

    it("describes an HTML page and shows its title", function () {
      const html =
        "<!doctype html><html><head>" +
        "<title>Making sure you&#39;re not a bot!</title>" +
        "</head><body>challenge</body></html>";
      assert.throws(
        () =>
          parseJSONResponse(
            "https://dblp.org/search/publ/api?q=x",
            200,
            "text/html; charset=utf-8",
            html,
          ),
        /dblp\.org returned an HTML page instead of JSON \(HTTP 200\): Making sure you're not a bot!/,
      );
    });

    it("detects HTML from the body when the content type is missing", function () {
      assert.throws(
        () =>
          parseJSONResponse(
            "https://example.org/x",
            200,
            null,
            "<html><body>nope</body></html>",
          ),
        /example\.org returned an HTML page instead of JSON/,
      );
    });

    it("describes an empty body", function () {
      assert.throws(
        () =>
          parseJSONResponse(
            "https://example.org/x",
            200,
            "application/json",
            "",
          ),
        /example\.org returned an empty response instead of JSON \(HTTP 200\)/,
      );
    });

    it("shows the start of an unrecognized invalid body", function () {
      assert.throws(
        () =>
          parseJSONResponse(
            "https://example.org/x",
            503,
            "text/plain",
            "not json at all",
          ),
        /example\.org returned an invalid JSON response \(HTTP 503\), starting with: not json at all/,
      );
    });

    it("truncates a long invalid body", function () {
      let message = "";
      try {
        parseJSONResponse(
          "https://example.org/x",
          200,
          "text/plain",
          "x".repeat(500),
        );
      } catch (e) {
        message = (e as Error).message;
      }
      // The excerpt is bounded and marked as truncated, without pinning the
      // exact cutoff length.
      const snippet = message.split("starting with: ")[1] ?? "";
      assert.match(snippet, /^x+…$/);
      assert.isBelow(snippet.length, 200, "the excerpt is bounded");
    });
  });
});
