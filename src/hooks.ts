import { arXivMerge } from "./modules/arxiv-merge";
import { arXivUpdate } from "./modules/arxiv-update";
import { PreferPDF } from "./modules/prefer-pdf";
import { Preferences } from "./modules/preferences";
import { config } from "../package.json";
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
}

async function onMainWindowLoad(win: Window): Promise<void> {
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
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-ignore - Plugin instance is not typed
  delete Zotero[config.addonInstance];
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
