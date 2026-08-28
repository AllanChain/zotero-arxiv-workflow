import PQueue from "p-queue";
import type { Fetcher } from "../../src/modules/arxiv-update/fetcher";
import type { PaperIdentifier } from "../../src/modules/arxiv-update/paper-finder";
import {
  UpdateManager,
  type UpdateManagerOptions,
} from "../../src/modules/arxiv-update/manager";
import { setPluginPref } from "../helpers";

/** Update sources toggleable via the `updateSource.*` prefs. */
export const UPDATE_SOURCES = [
  "doi",
  "semanticScholar",
  "dblp",
  "pubmed",
  "arXiv",
] as const;

/** Re-enable every update source and clear per-source credentials. */
export function resetUpdateSourcePrefs() {
  for (const source of UPDATE_SOURCES) {
    setPluginPref(`updateSource.${source}`, true);
  }
  // `updateSource.*` also holds credentials, not just toggles; reset them all
  // so no suite has to remember the individual keys (the profile is shared).
  setPluginPref("updateSource.semanticScholar.apiKey", "");
}

/** A preprint item whose URL points at a known preprint server. */
export async function createPreprintItem(
  url = "https://arxiv.org/abs/1234.5678",
  options: { title?: string; authorLastName?: string } = {},
) {
  const item = new Zotero.Item("preprint");
  item.setField("title", options.title ?? "Test paper");
  item.setField("url", url);
  await item.saveTx();
  if (options.authorLastName) {
    item.setCreator(0, {
      firstName: "Jane",
      lastName: options.authorLastName,
      creatorType: "author",
    });
    await item.saveTx();
  }
  return item;
}

// Records every request so tests can assert on which finders ran and in
// what order, while stubbing the response bodies.
export function createFetcher(
  handlers: {
    fetchText?: (url: string) => string | Promise<string>;
    fetchJSON?: (url: string) => unknown | Promise<unknown>;
  } = {},
) {
  const calls: Array<{ type: "text" | "json"; url: string }> = [];
  const fetcher: Fetcher = {
    fetchText: async (url) => {
      calls.push({ type: "text", url });
      return handlers.fetchText ? handlers.fetchText(url) : "";
    },
    fetchJSON: async <T = any>(url: string) => {
      calls.push({ type: "json", url });
      return (handlers.fetchJSON ? handlers.fetchJSON(url) : {}) as T;
    },
  };
  return { fetcher, calls };
}

// Offline stand-in for the translator-based import: builds a real journal
// item in the library from the identifier the finder located.
export async function createJournalItem(
  paper: PaperIdentifier,
): Promise<Zotero.Item | false> {
  const item = new Zotero.Item("journalArticle");
  item.setField("title", "Published title");
  if (paper.doi) item.setField("DOI", paper.doi);
  if (paper.url) item.setField("url", paper.url);
  await item.saveTx();
  return item;
}

// Narrow Zotero.Items.getAsync (Promise<Item | false>) so merged items can be
// inspected without casts; fails loudly if the item vanished.
export async function getItem(id: number): Promise<Zotero.Item> {
  const item = await Zotero.Items.getAsync(id);
  if (!item) throw new Error(`item ${id} not found`);
  return item;
}

// An UpdateManager whose queue really executes tasks, with the network seams
// injected so the whole update pipeline runs without real requests.
export function createUpdateManager(overrides: {
  fetcher: Fetcher;
  createItem?: UpdateManagerOptions["createItem"];
}) {
  const queue = new PQueue({ concurrency: 1 });
  const manager = new UpdateManager(queue, {
    fetcher: overrides.fetcher,
    createItem: overrides.createItem ?? createJournalItem,
  });
  return { queue, manager };
}
