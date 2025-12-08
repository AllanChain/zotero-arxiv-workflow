import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("should expose public API", function () {
    const plugin = Zotero[config.addonInstance];
    assert.isDefined(plugin.api.arXivUpdate);
    assert.isDefined(plugin.api.merge);
    assert.isDefined(plugin.api.preferPDF);
    assert.isDefined(plugin.api.updatePDF);
  });
});
