import type Addon from "../src/addon";
import { config } from "../package.json";

export function getPlugin(): Addon {
  // @ts-expect-error string access not typed
  const plugin = Zotero[config.addonInstance] as Addon;
  // Source modules imported directly by tests (e.g. `arxiv-merge.ts`,
  // `manager.ts`) reference the ambient `addon` and `ztoolkit` globals at
  // runtime. Those globals are defined by `src/index.ts` in the plugin
  // sandbox realm, which is a *different* realm than the one the test
  // modules run in, so surface them here explicitly.
  (globalThis as unknown as { addon: Addon }).addon = plugin;
  (globalThis as unknown as { ztoolkit: ZToolkit }).ztoolkit =
    plugin.data.ztoolkit;
  return plugin;
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
  },
) {
  return await Zotero.Attachments.linkFromURL({
    parentItemID: parentItem.id,
    url: options.url,
    title: options.title,
    contentType: options.contentType,
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
  const libraryID = Zotero.getActiveZoteroPane().getSelectedLibraryIDs()[0];
  const items = await translate.translate({
    libraryID,
    saveAttachments: false,
  });
  if (items.length === 0) return false;
  return items[0];
}
