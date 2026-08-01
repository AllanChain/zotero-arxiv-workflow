import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { requestBounded } from "../../utils/http";
import { arXivMerge } from "../arxiv-merge";
import { catchError } from "../error";
import { PaperIdentifier, UpdateStatus, UpdateTableData } from "../../types";
import { KNOWN_PREPRINT_SERVERS, PaperFinder } from "./paper-finder";
import { UpdateDialog } from "./update-dialog";

type ReportProgress = (
  status: UpdateStatus,
  msg?: string,
  paper?: PaperIdentifier,
) => void;

async function createItemByZotero(
  paper: PaperIdentifier,
  collections: number[],
): Promise<Zotero.Item | false> {
  let translate;
  if (paper.doi) {
    translate = new Zotero.Translate.Search();
    translate.setIdentifier({ DOI: paper.doi });
    const translators = await translate.getTranslators();
    translate.setTranslator(translators);
  } else if (paper.url) {
    translate = new Zotero.Translate.Web();
    // Imports can re-hit a host (e.g. the DBLP BibTeX view used
    // for OpenReview records), so they share the per-host queue.
    const xhr = await requestBounded(paper.url, {
      timeout: 30000,
      responseType: "document",
    });
    const doc = Zotero.HTTP.wrapDocument(
      xhr.response as Document,
      xhr.responseURL || paper.url,
    );
    translate.setDocument(doc);
    const translators = await translate.getTranslators();
    translate.setTranslator(translators);
  }
  const libraryID = Zotero.getActiveZoteroPane()!.getSelectedLibraryID();
  const items = await translate.translate({
    libraryID,
    collections,
    saveAttachments: false, // we will do it later
  });
  if (items.length === 0) return false;
  return items[0];
}

export class arXivUpdate {
  static menuIcon = `chrome://${config.addonRef}/content/icons/favicon.svg`;

  @catchError
  static registerRightClickMenuItem() {
    Zotero.MenuManager.registerMenu({
      menuID: `${config.addonRef}-update`,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          l10nID: `${config.addonRef}-menuitem-update`,
          icon: arXivUpdate.menuIcon,
          onCommand: async () => {
            const preprintItems =
              Zotero.getActiveZoteroPane()?.getSelectedItems();
            if (!preprintItems) return;
            ztoolkit.log(
              `Update command: ${preprintItems.length} items selected`,
            );
            arXivUpdate.update(preprintItems);
          },
          onShowing: (ev, { setVisible }) => {
            const isKnownPreprintItem = (
              Zotero.getActiveZoteroPane()?.getSelectedItems() ?? []
            ).map((item) => {
              if (item.itemType !== "preprint") return false;
              const arXivURL = item.getField("url");
              const urlHost = new URL(arXivURL).hostname;
              return Object.values(KNOWN_PREPRINT_SERVERS).includes(urlHost);
            });
            if (getPref("update.alwaysShowButton"))
              setVisible(isKnownPreprintItem.some(Boolean));
            else setVisible(isKnownPreprintItem.every(Boolean));
          },
        },
      ],
    });
  }

  static async update(
    preprintItem: Zotero.Item | Zotero.Item[],
    options: { openWindow?: boolean } = {},
  ) {
    arXivUpdate.createUpdateTasks(
      Array.isArray(preprintItem) ? preprintItem : [preprintItem],
    );
    UpdateDialog.refreshOrOpen(options);
  }

  static async updateItemWithProgress(
    preprintItem: Zotero.Item,
    reportProgress: ReportProgress,
  ) {
    ztoolkit.log(`Update task started for "${preprintItem.getDisplayTitle()}"`);
    reportProgress("finding-update");
    try {
      const paper = await new PaperFinder(preprintItem).find();
      if (paper === undefined) return reportProgress("up-to-date");
      if (paper.tentative) {
        // Fuzzy matches are not imported automatically; the user confirms
        // them in the batch review window after the queue drains.
        ztoolkit.log(
          `Tentative match for "${preprintItem.getDisplayTitle()}": awaiting confirmation`,
        );
        return reportProgress("needs-confirmation", undefined, paper);
      }
      await arXivUpdate.importAndMerge(preprintItem, paper, reportProgress);
    } catch (err) {
      ztoolkit.log(err);
      reportProgress(
        "general-error",
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unknown error",
      );
    }
  }

  static async importAndMerge(
    preprintItem: Zotero.Item,
    paper: PaperIdentifier,
    reportProgress: ReportProgress,
  ) {
    // Download published version
    reportProgress("downloading-metadata");
    const collection = Zotero.getActiveZoteroPane()?.getSelectedCollection();
    let collections: number[] = [];
    if (collection) {
      collections = [collection.id];
    }
    const journalItem = await createItemByZotero(paper, collections);
    if (!journalItem) return reportProgress("download-error");
    journalItem.saveTx();

    let hasErrorDownloadingPDF = false;
    if (
      getPref("downloadJournalPDF") &&
      Zotero.Attachments.canFindPDFForItem(journalItem)
    ) {
      reportProgress("downloading-pdf");
      const attachment = await Zotero.Attachments.addAvailableFile(
        journalItem,
        // Only download from publisher
        { methods: ["doi"] },
      );
      if (attachment) {
        attachment.setField("title", paper.title);
        attachment.saveTx();
      } else {
        hasErrorDownloadingPDF = true;
      }
    }
    await arXivMerge.merge(preprintItem, journalItem, true);

    if (hasErrorDownloadingPDF) {
      reportProgress(
        "updated",
        getString("update-message", "download-pdf-error"),
      );
    } else {
      reportProgress("updated");
    }
  }

  static createUpdateTasks(preprintItems: Zotero.Item[]) {
    for (const preprintItem of preprintItems) {
      if (
        addon.data.arXivUpdate.tableData.findIndex(
          (data) => data.id === preprintItem.id,
        ) == -1
      ) {
        addon.data.arXivUpdate.tableData.push({
          id: preprintItem.id,
          title: preprintItem.getDisplayTitle(),
          status: "pending",
          message: undefined,
        });
        ztoolkit.log(
          `Enqueueing update task for "${preprintItem.getDisplayTitle()}" (queue size=${addon.data.arXivUpdate.queue.size}, pending=${addon.data.arXivUpdate.queue.pending})`,
        );
        addon.data.arXivUpdate.queue.add(() =>
          arXivUpdate.updateItemWithProgress(
            preprintItem,
            (status, msg, paper) => {
              const data = addon.data.arXivUpdate.tableData.find(
                (item) => item.id === preprintItem.id,
              )!;
              data.status = status;
              data.message = msg;
              if (paper) {
                data.pendingPaper = paper;
              }
              UpdateDialog.sortTableData();
            },
          ),
        );
      } else {
        ztoolkit.log(
          `Item "${preprintItem.getDisplayTitle()}" already in update table`,
        );
      }
    }
  }
}
