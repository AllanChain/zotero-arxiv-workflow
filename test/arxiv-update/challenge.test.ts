import { assert } from "chai";
import {
  type ClearChallenge,
  isAnubisChallenge,
  makeChallengeFetcher,
} from "@/modules/arxiv-update/fetcher/challenge";
import type { Fetcher } from "@/modules/arxiv-update/fetcher/base";
import { getPlugin } from "@test/helpers";

const DBLP_URL = "https://dblp.org/search/publ/api?q=attention&format=json";
const JSON_BODY = '{"result":{"hits":[]}}';

/** An Anubis challenge page, with the two markers the detector keys on. */
const CHALLENGE_HTML =
  "<!doctype html><html><head><title>Making sure you're not a bot!</title>" +
  '<link rel="stylesheet" href="/.within.website/x/xess/xess.min.css">' +
  '<script id="anubis_challenge" type="application/json">{"rules":{}}</script>' +
  "</head><body>challenge</body></html>";

function responseXHR(
  body: string,
  contentType: string | null,
  status = 200,
): XMLHttpRequest {
  return {
    status,
    getResponseHeader: (name: string) =>
      name.toLowerCase() === "content-type" ? contentType : null,
    responseText: body,
  } as unknown as XMLHttpRequest;
}

const challengeXHR = () =>
  responseXHR(CHALLENGE_HTML, "text/html; charset=utf-8");
const jsonXHR = () => responseXHR(JSON_BODY, "application/json");

/** A raw request whose single response is decided per call. */
function fakeRequest(
  respond: (call: number) => XMLHttpRequest | Promise<XMLHttpRequest>,
): Fetcher["request"] {
  let call = 0;
  return async () => respond(call++);
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the promise to reject");
}

describe("challenge", function () {
  before(function () {
    assert.isDefined(getPlugin(), "Plugin should be initialized");
  });

  describe("isAnubisChallenge", function () {
    it("accepts an HTML page carrying the Anubis markup", function () {
      assert.isTrue(
        isAnubisChallenge("text/html; charset=utf-8", CHALLENGE_HTML),
      );
      assert.isTrue(
        isAnubisChallenge(
          null,
          "<!doctype html><html>/.within.website/</html>",
        ),
      );
    });

    it("rejects ordinary HTML, JSON, and markup without an HTML type", function () {
      assert.isFalse(
        isAnubisChallenge("text/html", "<html><body>404</body></html>"),
      );
      assert.isFalse(isAnubisChallenge("application/json", JSON_BODY));
      // The marker alone, on a non-HTML response, is not a challenge page.
      assert.isFalse(
        isAnubisChallenge("application/json", '{"x":"/.within.website/"}'),
      );
    });
  });

  describe("makeChallengeFetcher", function () {
    it("clears a challenge, retries, and returns the JSON", async function () {
      let cleared = false;
      const clearCalls: string[] = [];
      const request = fakeRequest(() => (cleared ? jsonXHR() : challengeXHR()));
      const wrapped = makeChallengeFetcher(request, {
        clearChallenge: async (url) => {
          clearCalls.push(url);
          cleared = true;
        },
      });

      assert.deepEqual(await wrapped.fetchJSON(DBLP_URL), {
        result: { hits: [] },
      });
      assert.deepEqual(clearCalls, [DBLP_URL]);
    });

    it("passes a non-challenge response through without clearing", async function () {
      const clearCalls: string[] = [];
      const wrapped = makeChallengeFetcher(fakeRequest(jsonXHR), {
        clearChallenge: async (url) => {
          clearCalls.push(url);
        },
      });

      assert.deepEqual(await wrapped.fetchJSON(DBLP_URL), {
        result: { hits: [] },
      });
      assert.deepEqual(clearCalls, []);
    });

    it("clears a 4xx challenge returned as a rejection", async function () {
      let cleared = false;
      const clearCalls: string[] = [];
      const request = fakeRequest((call) => {
        if (!cleared) {
          const xmlhttp = challengeXHR();
          xmlhttp.status = 403;
          throw Object.assign(new Error("HTTP 403"), { xmlhttp });
        }
        assert.equal(call, 1);
        return jsonXHR();
      });
      const wrapped = makeChallengeFetcher(request, {
        clearChallenge: async () => {
          clearCalls.push("cleared");
          cleared = true;
        },
      });

      assert.deepEqual(await wrapped.fetchJSON(DBLP_URL), {
        result: { hits: [] },
      });
      assert.deepEqual(clearCalls, ["cleared"]);
    });

    it("rethrows a 4xx rejection that is not a challenge, untouched", async function () {
      const notFound = responseXHR("<html>Not found</html>", "text/html", 404);
      const error = Object.assign(new Error("HTTP 404"), { xmlhttp: notFound });
      let clearCalls = 0;
      const wrapped = makeChallengeFetcher(
        fakeRequest(() => {
          throw error;
        }),
        {
          clearChallenge: async () => {
            clearCalls++;
          },
        },
      );

      assert.strictEqual(
        await captureError(wrapped.fetchJSON(DBLP_URL)),
        error,
      );
      assert.equal(clearCalls, 0);
    });

    it("clears a challenge once for concurrent same-host requests", async function () {
      let clearCalls = 0;
      let cleared = false;
      const clearChallenge: ClearChallenge = async () => {
        clearCalls++;
        await Zotero.Promise.delay(10);
        cleared = true;
      };
      const request = fakeRequest(() => (cleared ? jsonXHR() : challengeXHR()));
      const wrapped = makeChallengeFetcher(request, { clearChallenge });

      await Promise.all([
        wrapped.fetchJSON(`${DBLP_URL}&a`),
        wrapped.fetchJSON(`${DBLP_URL}&b`),
      ]);
      assert.equal(clearCalls, 1);
    });

    it("keeps retrying when clearing throws", async function () {
      let requests = 0;
      const wrapped = makeChallengeFetcher(
        fakeRequest(() => (requests++ === 0 ? challengeXHR() : jsonXHR())),
        {
          clearChallenge: async () => {
            throw new Error("hidden browser failed");
          },
        },
      );

      assert.deepEqual(await wrapped.fetchJSON(DBLP_URL), {
        result: { hits: [] },
      });
    });

    it("falls through to the parse error after all attempts", async function () {
      let clearCalls = 0;
      const wrapped = makeChallengeFetcher(fakeRequest(challengeXHR), {
        clearChallenge: async () => {
          clearCalls++;
        },
      });

      const error = await captureError(wrapped.fetchJSON(DBLP_URL));
      assert.match(
        error.message,
        /dblp\.org returned an HTML page instead of JSON \(HTTP 200\)/,
      );
      assert.equal(clearCalls, 3, "one clear per bounded attempt");
    });

    it("detects a challenge in a responseType: document reply", async function () {
      // The translator import path requests a Document, where responseText
      // throws; detection must read the parsed markup instead.
      const document = new DOMParser().parseFromString(
        CHALLENGE_HTML,
        "text/html",
      );
      let cleared = false;
      const request: Fetcher["request"] = async () => {
        if (cleared) return jsonXHR();
        return {
          status: 200,
          responseType: "document",
          getResponseHeader: () => "text/html; charset=utf-8",
          get responseText(): string {
            throw new Error("responseText unavailable for documents");
          },
          response: document,
        } as unknown as XMLHttpRequest;
      };
      const wrapped = makeChallengeFetcher(request, {
        clearChallenge: async () => {
          cleared = true;
        },
      });

      const xhr = await wrapped.request(DBLP_URL, { responseType: "document" });
      assert.equal(xhr.responseText, JSON_BODY);
    });
  });
});
