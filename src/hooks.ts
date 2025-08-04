import { arXivMerge } from "./modules/arxiv-merge";
import { arXivUpdate } from "./modules/arxiv-update";
import { PreferPDF } from "./modules/prefer-pdf";
import { Preferences } from "./modules/preferences";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { UpdatePDF } from "./modules/update-pdf";
import { getPref } from "./utils/prefs";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  Preferences.registerPreferences();
  if (getPref("features.arXivMerge")) arXivMerge.registerRightClickMenuItem();
  if (getPref("features.arXivUpdate")) arXivUpdate.registerRightClickMenuItem();
  if (getPref("features.preferPDF")) PreferPDF.registerRightClickMenuItem();
  if (getPref("features.updatePDF")) UpdatePDF.registerRightClickMenuItem();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
