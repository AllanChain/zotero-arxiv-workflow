import { assert } from "chai";
import {
  simplifyUpdateStatus,
  sortByStatusPriority,
} from "@/modules/arxiv-update/status";
import type { UpdateStatus } from "@/types";

describe("status", function () {
  describe("simplifyUpdateStatus", function () {
    const cases: Array<[UpdateStatus, string]> = [
      ["pending", "pending"],
      ["finding-update", "processing"],
      ["downloading-metadata", "processing"],
      ["downloading-pdf", "processing"],
      ["needs-confirmation", "needs-confirmation"],
      ["up-to-date", "up-to-date"],
      ["updated", "updated"],
      ["download-error", "error"],
      ["general-error", "error"],
    ];
    for (const [status, expected] of cases) {
      it(`maps ${status} to ${expected}`, function () {
        assert.equal(simplifyUpdateStatus(status), expected);
      });
    }
  });

  describe("sortByStatusPriority", function () {
    function data(status: UpdateStatus, title: string) {
      return { id: 0, title, status };
    }

    it("orders error, needs-confirmation, processing, pending, updated, up-to-date", function () {
      const sorted = sortByStatusPriority([
        data("pending", "a"),
        data("updated", "b"),
        data("download-error", "c"),
        data("needs-confirmation", "c2"),
        data("finding-update", "d"),
        data("up-to-date", "e"),
      ]);
      assert.deepEqual(
        sorted.map((d) => d.title),
        ["c", "c2", "d", "a", "b", "e"],
      );
    });

    it("preserves input order within the same status group", function () {
      const sorted = sortByStatusPriority([
        data("pending", "first"),
        data("pending", "second"),
        data("general-error", "err1"),
        data("pending", "third"),
      ]);
      assert.deepEqual(
        sorted.map((d) => d.title),
        ["err1", "first", "second", "third"],
      );
    });

    it("returns an empty array for empty input", function () {
      assert.deepEqual(sortByStatusPriority([]), []);
    });

    it("does not mutate the input array", function () {
      const input = [data("updated", "b"), data("general-error", "c")];
      sortByStatusPriority(input);
      assert.deepEqual(
        input.map((d) => d.title),
        ["b", "c"],
      );
    });
  });
});
