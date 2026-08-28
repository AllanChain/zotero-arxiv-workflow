import type Addon from "@/addon";
import { config } from "@pkg";

export function getPlugin(): Addon {
  // @ts-expect-error string access not typed
  const plugin = Zotero[config.addonInstance];
  registerPluginGlobals(plugin);
  return plugin;
}

// Production registers `ztoolkit`/`addon` only on the plugin sandbox's
// global (`defineGlobal` in src/index.ts). Test bundles run as scripts in
// the Zotero window, where those identifiers are otherwise undefined, so
// mirror the registration on the window global. This lets tests import src
// modules directly and have them resolve the same globals as in production.
function registerPluginGlobals(plugin: Addon) {
  Object.defineProperty(globalThis, "ztoolkit", {
    get: () => plugin.data.ztoolkit,
    configurable: true,
  });
  (globalThis as any).addon = plugin;
}

export async function getAllItems() {
  return await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false);
}

export async function clearLibrary() {
  await Promise.all((await getAllItems()).map((item) => item.eraseTx()));
  await Zotero.Items.emptyTrash(Zotero.Libraries.userLibraryID);
}

export async function createLinkAttachment(
  parentItem: Zotero.Item,
  options: {
    url: string;
    title: string;
    contentType?: string;
    snapshot?: boolean;
  },
) {
  return await Zotero.Attachments.linkFromURL({
    parentItemID: parentItem.id,
    url: options.url,
    title: options.title,
    contentType: options.contentType,
    snapshot: options.snapshot,
  });
}

export async function createPDFAttachment(
  parentItem: Zotero.Item,
  options: {
    path: string;
    title: string;
    url: string;
  },
) {
  const attachment = new Zotero.Item("attachment");
  attachment.libraryID = parentItem.libraryID;
  attachment.parentItemID = parentItem.id;
  attachment.attachmentLinkMode = Zotero.Attachments.LINK_MODE_LINKED_FILE;
  attachment.attachmentContentType = "application/pdf";
  attachment.attachmentPath = options.path;
  attachment.setField("title", options.title);
  attachment.setField("url", options.url);
  await attachment.saveTx();
  return attachment;
}

export function setPluginPref(key: string, value: boolean | number | string) {
  return Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, value, true);
}

export function clearPluginPref(key: string) {
  return Zotero.Prefs.clear(`${config.prefsPrefix}.${key}`, true);
}

export async function createItemByDOI(
  doi: string,
): Promise<Zotero.Item | false> {
  const translate = new Zotero.Translate.Search();
  translate.setIdentifier({ DOI: doi });
  const translators = await translate.getTranslators();
  translate.setTranslator(translators);
  const pane = Zotero.getActiveZoteroPane()!;
  const libraryID = pane.getSelectedLibraryIDs
    ? pane.getSelectedLibraryIDs()[0]
    : pane.getSelectedLibraryID();
  const items = await translate.translate({
    libraryID,
    saveAttachments: false,
  });
  if (items.length === 0) return false;
  return items[0];
}
