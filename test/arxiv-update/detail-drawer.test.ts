import { assert } from "chai";
import { config } from "@pkg";
import { drawerView } from "@/modules/arxiv-update/detail-drawer";
import {
  SOURCE_KEYS,
  SOURCE_OUTCOMES,
  type TentativePaperIdentifier,
  type UpdateTableData,
} from "@/types";
import { getString } from "@/utils/locale";
import { getPlugin } from "@test/helpers";

function row(overrides: Partial<UpdateTableData> = {}): UpdateTableData {
  return {
    id: 1,
    title: "Test paper",
    status: "pending",
    ...overrides,
  };
}

function candidate(
  overrides: Partial<TentativePaperIdentifier["candidate"]> = {},
): TentativePaperIdentifier {
  return {
    doi: "10.5555/example",
    title: "Published PDF",
    tentative: true,
    candidate: {
      source: "DBLP",
      candidateTitle: "Test paper (Published Version)",
      publication: "ICLR",
      year: "2024",
      score: 0.9,
      ...overrides,
    },
  };
}

describe("detail-drawer", function () {
  before(function () {
    const plugin = getPlugin();
    assert.isDefined(plugin, "Plugin should be initialized");
  });

  describe("drawerView", function () {
    it("carries the display status and its localized text", function () {
      // `simplifyUpdateStatus` mapping is covered exhaustively in
      // status.test.ts; here we only check drawerView surfaces it.
      const view = drawerView(row({ status: "needs-confirmation" }));
      assert.equal(view.status, "needs-confirmation");
      assert.equal(
        view.statusText,
        getString("update-status", "needs-confirmation"),
      );
    });

    it("passes the row title and source checks through", function () {
      const sources = {
        dblp: { outcome: "found" as const },
        arXivPDF: { outcome: "empty" as const },
      };
      const view = drawerView(row({ title: "A Preprint", sources }));
      assert.equal(view.title, "A Preprint");
      assert.deepEqual(view.sources, sources);
      assert.deepEqual(drawerView(row()).sources, {});
    });

    it("does not invent a message for failed sources", function () {
      // The manager owns the failure message (see manager.test.ts); the drawer
      // must only render what the row carries.
      const view = drawerView(
        row({
          status: "up-to-date",
          sources: { crossref: { outcome: "failed", detail: "network down" } },
        }),
      );
      assert.isUndefined(view.message);
    });

    it("leaves a clean up-to-date row without a message", function () {
      const view = drawerView(
        row({
          status: "up-to-date",
          sources: { dblp: { outcome: "empty" } },
        }),
      );
      assert.isUndefined(view.message);
    });

    it("passes an explicit row message through", function () {
      const view = drawerView(
        row({ status: "up-to-date", message: "explicit" }),
      );
      assert.equal(view.message, "explicit");
    });

    it("shows the candidate and actions only for a pending fuzzy match", function () {
      const view = drawerView(
        row({ status: "needs-confirmation" }),
        candidate(),
      );
      assert.isDefined(view.candidate);
      assert.equal(
        view.candidate?.candidateTitle,
        "Test paper (Published Version)",
      );
      assert.include(view.candidate?.meta ?? "", "DBLP");
      assert.include(view.candidate?.meta ?? "", "ICLR");
      assert.include(view.candidate?.meta ?? "", "2024");
    });

    it("has a locale string for every source and outcome", function () {
      // `getString` falls back to the prefixed key on a miss, so a typo or a
      // missing attribute silently ships the raw id. Iterate the shared key
      // tuples so a newly added source/outcome is covered automatically.
      const missing = (id: string) => `${config.addonRef}-${id}`;
      for (const key of SOURCE_KEYS) {
        assert.notEqual(
          getString("source-name", key),
          missing("source-name"),
          key,
        );
      }
      for (const outcome of SOURCE_OUTCOMES) {
        assert.notEqual(
          getString("source-outcome", outcome),
          missing("source-outcome"),
          outcome,
        );
      }
    });

    it("has no candidate or actions without a pending paper", function () {
      const view = drawerView(row({ status: "needs-confirmation" }));
      assert.isUndefined(view.candidate);
    });

    it("has no candidate or actions for non-confirmation statuses", function () {
      for (const status of ["pending", "updated", "up-to-date"] as const) {
        const view = drawerView(row({ status }), candidate());
        assert.isUndefined(view.candidate);
      }
    });
  });
});
