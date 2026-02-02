import { assert } from "chai";
import { getPlugin } from "./helpers";

describe("startup", function () {
  it("should have plugin instance and prefs defined", function () {
    assert.isNotEmpty(getPlugin());
    assert.isDefined(
      Zotero.Prefs.get(
        "extensions.zotero.arxiv-workflow.merge.reservedKeys",
        true,
      ),
    );
  });

  it("should expose public API", function () {
    const plugin = getPlugin();
    assert.isDefined(plugin.api.arXivUpdate);
    assert.isDefined(plugin.api.merge);
    assert.isDefined(plugin.api.preferPDF);
    assert.isDefined(plugin.api.updatePDF);
  });
});
