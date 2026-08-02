import { assert } from "chai";
import {
  diceSimilarity,
  evaluateTitlePair,
  extractYear,
  firstAuthorSurnameMatches,
  FUZZY_TITLE_THRESHOLD,
  normalizeTitle,
  yearGatePasses,
} from "../src/utils/title-match";

const SOAP_ARXIV = "SOAP: Improving and Stabilizing Shampoo using Adam";
const SOAP_DBLP =
  "SOAP: Improving and Stabilizing Shampoo using Adam for Language Modeling";

describe("title-match", function () {
  describe("normalizeTitle", function () {
    it("lowercases and trims", function () {
      assert.equal(normalizeTitle("  SOAP: Improving  "), "soap improving");
    });

    it("removes a trailing period", function () {
      assert.equal(normalizeTitle("A Study of X."), "a study of x");
    });

    it("decodes common HTML entities", function () {
      assert.equal(
        normalizeTitle("Attention &amp; Transformers &quot;2&quot;"),
        "attention transformers 2",
      );
    });

    it("strips punctuation and collapses whitespace", function () {
      assert.equal(normalizeTitle("K-Means++:  A Method"), "k means a method");
    });
  });

  describe("diceSimilarity", function () {
    it("returns 1 for identical titles", function () {
      assert.equal(diceSimilarity("A B C", "A B C"), 1);
    });

    it("returns 0 for disjoint titles", function () {
      assert.equal(diceSimilarity("Alpha Beta", "Gamma Delta"), 0);
    });

    it("is order-insensitive (token sets)", function () {
      assert.equal(diceSimilarity("A B C", "C B A"), 1);
    });

    it("penalizes added words proportionally", function () {
      assert.equal(diceSimilarity("A B C", "A B C D E"), 0.75);
    });

    it("scores the SOAP pair above the fuzzy threshold", function () {
      const score = diceSimilarity(SOAP_ARXIV, SOAP_DBLP);
      assert.isAtLeast(score, FUZZY_TITLE_THRESHOLD);
    });
  });

  describe("firstAuthorSurnameMatches", function () {
    it("matches across author string formats", function () {
      assert.isTrue(firstAuthorSurnameMatches("Jordan", "Jordan MI"));
      assert.isTrue(firstAuthorSurnameMatches("Jordan", "Michael I. Jordan"));
      assert.isTrue(firstAuthorSurnameMatches("Jordan", "Jordan, Michael I."));
      assert.isTrue(firstAuthorSurnameMatches("Vyas", "Nikhil Vyas 0001"));
      assert.isTrue(firstAuthorSurnameMatches("van der Berg", "van der Berg"));
    });

    it("keeps short surnames without mis-dropping them", function () {
      assert.isTrue(firstAuthorSurnameMatches("Hu", "X Hu"));
      assert.isTrue(firstAuthorSurnameMatches("Hu", "Hu, X"));
      assert.isTrue(firstAuthorSurnameMatches("Xu", "Xu J"));
      assert.isFalse(firstAuthorSurnameMatches("Hu", "Michael I. Jordan"));
      assert.isFalse(firstAuthorSurnameMatches("Li", "Liang Z"));
    });

    it("uses only the words before the first comma (the first author)", function () {
      assert.isTrue(
        firstAuthorSurnameMatches(
          "Gu",
          "Shixiang Shane Gu, Machel Reid, Yutaka Matsuo",
        ),
      );
      assert.isTrue(
        firstAuthorSurnameMatches("Jia", "Jia Y, Yuan Z, Zhu L, Han B"),
      );
      assert.isFalse(
        firstAuthorSurnameMatches(
          "Reid",
          "Shixiang Shane Gu, Machel Reid, Yutaka Matsuo",
        ),
      );
      assert.isFalse(firstAuthorSurnameMatches("Zhu", "Jia Y, Yuan Z"));
    });

    it("rejects mismatched or missing authors", function () {
      assert.isFalse(firstAuthorSurnameMatches("Li", "Jordan"));
      assert.isFalse(firstAuthorSurnameMatches(undefined, "Jordan"));
      assert.isFalse(firstAuthorSurnameMatches("Jordan", undefined));
    });
  });

  describe("extractYear and yearGatePasses", function () {
    it("parses plain and date-format years", function () {
      assert.equal(extractYear("2025"), 2025);
      assert.equal(extractYear("2025 Feb 18"), 2025);
      assert.equal(extractYear("2024-09-18"), 2024);
    });

    it("returns undefined for missing or unparseable years", function () {
      assert.equal(extractYear(undefined), undefined);
      assert.equal(extractYear("unknown"), undefined);
    });

    it("requires the published version to be no earlier", function () {
      assert.isTrue(yearGatePasses("2024", "2025"));
      assert.isTrue(yearGatePasses("2024", "2024"));
      assert.isFalse(yearGatePasses("2025", "2024"));
      assert.isFalse(yearGatePasses(undefined, "2025"));
      assert.isFalse(yearGatePasses("2024", undefined));
    });
  });

  describe("evaluateTitlePair", function () {
    it("classifies case-insensitive equality as exact", function () {
      const result = evaluateTitlePair("Foo Bar", "foo bar");
      assert.equal(result.kind, "exact");
      assert.equal(result.score, 1);
    });

    it("classifies punctuation-only differences as exact", function () {
      assert.equal(evaluateTitlePair("Foo", "Foo.").kind, "exact");
    });

    it("classifies the SOAP pair as fuzzy", function () {
      const result = evaluateTitlePair(SOAP_ARXIV, SOAP_DBLP);
      assert.equal(result.kind, "fuzzy");
      assert.isAtLeast(result.score, FUZZY_TITLE_THRESHOLD);
    });

    it("classifies the threshold boundary as fuzzy", function () {
      const result = evaluateTitlePair("A B C D E", "A B C D F");
      assert.equal(result.score, FUZZY_TITLE_THRESHOLD);
      assert.equal(result.kind, "fuzzy");
    });

    it("rejects disjoint or empty titles", function () {
      assert.equal(
        evaluateTitlePair("Alpha Beta", "Gamma Delta").kind,
        "reject",
      );
      assert.equal(evaluateTitlePair("", "Foo").kind, "reject");
      assert.equal(evaluateTitlePair("Foo", "").kind, "reject");
    });
  });
});
