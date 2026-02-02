import type Addon from "../src/addon";
import { config } from "../package.json";

export function getPlugin(): Addon {
  // @ts-expect-error string access not typed
  return Zotero[config.addonInstance];
}

export async function getAllItems() {
  return await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false);
}

export async function createItemByDOI(
  doi: string,
): Promise<Zotero.Item | false> {
  const translate = new Zotero.Translate.Search();
  translate.setIdentifier({ DOI: doi });
  const translators = await translate.getTranslators();
  translate.setTranslator(translators);
  const libraryID = Zotero.getActiveZoteroPane().getSelectedLibraryID();
  const items = await translate.translate({
    libraryID,
    saveAttachments: false,
  });
  if (items.length === 0) return false;
  return items[0];
}
