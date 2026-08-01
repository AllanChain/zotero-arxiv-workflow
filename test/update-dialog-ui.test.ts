import { assert } from "chai";
import type Addon from "../src/addon";
import { getPlugin } from "./helpers";
import { arXivUpdate } from "../src/modules/arxiv-update";
import { UpdateDialog } from "../src/modules/arxiv-update/update-dialog";
import type { PaperIdentifier } from "../src/types";
import { config } from "../package.json";

describe("update-dialog-ui", function () {
  let plugin: Addon;
  // `importAndMerge` performs a real network import in `confirmCandidate`.
  // Stub it so the confirm flow is deterministic and offline, and capture the
  // arguments to verify the pending candidate is actually passed through.
  let originalImportAndMerge: typeof arXivUpdate.importAndMerge;
  let importCalls: { preprint: Zotero.Item; paper: PaperIdentifier }[] = [];
  this.timeout(60000);

  function candidate(
    id: number,
    title: string,
    source: "DBLP" | "PubMed" = "DBLP",
    candidateTitle?: string,
    url?: string | null, // `null` explicitly means "no review link"
  ) {
    return {
      id,
      title,
      status: "needs-confirmation" as const,
      pendingPaper: {
        doi: `10.5555/example-doi-${id}`,
        title: "Published PDF",
        tentative: true,
        candidate: {
          source,
          candidateTitle: candidateTitle ?? `${title} (Published Version)`,
          publication: source === "DBLP" ? "ICLR" : "Some Journal",
          year: "2024",
          score: 0.9,
          url:
            url === null
              ? undefined
              : (url ??
                (source === "DBLP"
                  ? `https://dblp.org/rec/conf/iclr/example-${id}.html`
                  : `https://pubmed.ncbi.nlm.nih.gov/30000000${id}/`)),
        },
      },
    };
  }

  async function makeItem(title: string, arxivID: string) {
    const item = new Zotero.Item("preprint");
    item.setField("title", title);
    item.setField("url", `https://arxiv.org/abs/${arxivID}`);
    item.setField("date", "2024-09-17");
    item.setCreators([
      {
        firstName: "Dávid",
        lastName: "Négyesi",
        creatorType: "author",
      },
    ]);
    await item.saveTx();
    return item;
  }

  async function waitForWindow(minRows: number): Promise<WindowProxy> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const timer = setInterval(() => {
        const w = plugin.data.arXivUpdate.window;
        if (w && !w.closed) {
          const rows = w.document.querySelectorAll(
            `#${config.addonRef}-status-table .row`,
          );
          if (rows.length >= minRows) {
            clearInterval(timer);
            resolve(w);
          }
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`update dialog never rendered ${minRows} rows`));
        }
      }, 100);
    });
  }

  // Find open candidate-confirm windows. With `requireFilled`, only windows
  // whose title line has been rendered count.
  function findCandidateDialogs(requireFilled = false): WindowProxy[] {
    const wm = Services.wm;
    const enumerator = wm.getEnumerator("");
    const dialogs: WindowProxy[] = [];
    while (enumerator.hasMoreElements()) {
      const w = enumerator.getNext() as unknown as WindowProxy;
      if (w.closed) continue;
      const title = w.document?.getElementById(
        `${config.addonRef}-preprint-title`,
      );
      if (title && (!requireFilled || title.hasChildNodes())) {
        dialogs.push(w);
      }
    }
    return dialogs;
  }

  // Wait for the candidate-confirm dialog to be open and filled with content.
  async function waitForCandidateDialog(): Promise<WindowProxy> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const timer = setInterval(() => {
        const dialogs = findCandidateDialogs(true);
        if (dialogs.length > 0) {
          clearInterval(timer);
          resolve(dialogs[0]!);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error("candidate dialog never rendered"));
        }
      }, 100);
    });
  }

  async function waitForCondition(
    description: string,
    condition: () => boolean,
    timeout = 10000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      const timer = setInterval(() => {
        if (condition()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`timeout waiting for ${description}`));
        }
      }, 50);
    });
  }

  function dialogButton(
    dialog: WindowProxy,
    type: "accept" | "extra1",
  ): { label: string; click(): void } {
    return (
      dialog.document.documentElement as unknown as {
        getButton(type: string): { label: string; click(): void };
      }
    ).getButton(type);
  }

  async function clickLinkAndWait(
    win: WindowProxy,
    rowIndex = 0,
  ): Promise<WindowProxy> {
    const link = win.document.querySelectorAll<HTMLElement>(
      `#${config.addonRef}-status-table .row .cell.clickable .candidate-link`,
    )[rowIndex]!;
    link.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    return waitForCandidateDialog();
  }

  function closeCandidateDialogs() {
    for (const dialog of findCandidateDialogs()) {
      dialog.close();
    }
  }

  async function resetState() {
    closeCandidateDialogs();
    UpdateDialog.openCandidateDialogId = undefined;
    const win = plugin.data.arXivUpdate.window;
    if (win && !win.closed) {
      win.close();
    }
    plugin.data.arXivUpdate.window = undefined;
    plugin.data.arXivUpdate.tableHelper = undefined;
    plugin.data.arXivUpdate.tableData = [];
  }

  beforeEach(async function () {
    plugin = getPlugin();
    // The test bundle is a separate module graph from the plugin's bundled
    // code, so make the bare `addon` global resolve to the live plugin.
    (globalThis as any).addon = plugin;
    // `UpdateDialog.open()` builds the virtualized table through the toolkit
    // helper, which is only defined in the plugin sandbox by default.
    (globalThis as any).ztoolkit = plugin.data.ztoolkit;
    importCalls = [];
    originalImportAndMerge = arXivUpdate.importAndMerge;
    arXivUpdate.importAndMerge = async (
      preprintItem,
      paper,
      reportProgress,
    ) => {
      importCalls.push({ preprint: preprintItem, paper });
      reportProgress("updated");
    };
    await resetState();
  });

  afterEach(async function () {
    arXivUpdate.importAndMerge = originalImportAndMerge;
    await resetState();
  });

  it("click-to-check opens the dialog and confirm triggers the merge", async function () {
    const item = await makeItem("The Quick Brown Fox", "2409.11321");
    const candidateURL = "https://openreview.net/forum?id=example123";
    plugin.data.arXivUpdate.tableData.push(
      candidate(
        item.id,
        item.getDisplayTitle(),
        "DBLP",
        "The Lazy Brown Dog",
        candidateURL,
      ),
    );

    await UpdateDialog.open();
    const win = await waitForWindow(1);
    const statusCell = win.document.querySelector(
      `#${config.addonRef}-status-table .row .cell.clickable`,
    )!;
    assert.ok(
      statusCell.classList.contains("status-cell"),
      "status cell should use the regular status layout",
    );
    assert.ok(
      statusCell.textContent?.includes("Fuzzy match found."),
      "status cell should show the fuzzy-match prompt",
    );
    const link = statusCell.querySelector<HTMLElement>(".candidate-link")!;
    assert.equal(link.textContent, "Click to check");

    link.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    const dialog = await waitForCandidateDialog();

    // The dialog shows the word-level diff between the two titles.
    const preprintTitle = dialog.document.getElementById(
      `${config.addonRef}-preprint-title`,
    )!;
    const removed = preprintTitle.querySelectorAll("b");
    assert.ok(
      removed.length > 0,
      "preprint line should highlight preprint-only words",
    );
    for (const b of removed) {
      assert.equal((b as HTMLElement).style.color, "var(--accent-red)");
    }
    const candidateTitle = dialog.document.getElementById(
      `${config.addonRef}-candidate-title`,
    )!;
    const added = candidateTitle.querySelectorAll("b");
    assert.ok(
      added.length > 0,
      "candidate line should highlight candidate-only words",
    );
    for (const b of added) {
      assert.equal((b as HTMLElement).style.color, "var(--accent-green)");
    }
    const meta = dialog.document.getElementById(
      `${config.addonRef}-candidate-meta`,
    )!;
    assert.ok(
      meta.textContent?.includes("DBLP"),
      "meta should show the source",
    );
    assert.ok(
      meta.textContent?.includes("ICLR"),
      "meta should show the publication title",
    );

    const linkContainer = dialog.document.getElementById(
      `${config.addonRef}-candidate-link`,
    )!;
    const viewLink =
      linkContainer.querySelector<HTMLAnchorElement>("a.candidate-link")!;
    assert.ok(viewLink, "dialog should render the candidate review link");
    assert.equal(viewLink.textContent, "View candidate page");
    assert.equal(viewLink.getAttribute("href"), candidateURL);

    const openedURLs: string[] = [];
    const originalLaunchURL = Zotero.launchURL;
    Zotero.launchURL = (url: string) => void openedURLs.push(url);
    try {
      viewLink.dispatchEvent(
        new dialog.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    } finally {
      Zotero.launchURL = originalLaunchURL;
    }
    assert.deepEqual(openedURLs, [candidateURL]);

    assert.equal(dialogButton(dialog, "accept").label, "Confirm");
    assert.equal(dialogButton(dialog, "extra1").label, "Skip");

    dialogButton(dialog, "accept").click();
    await waitForCondition(
      "row to reach updated status",
      () => plugin.data.arXivUpdate.tableData[0]?.status === "updated",
    );

    assert.equal(importCalls.length, 1, "confirm should import and merge once");
    assert.equal(importCalls[0]!.preprint.id, item.id);
    const mergedDOI = importCalls[0]!.paper.doi;
    assert.equal(mergedDOI, `10.5555/example-doi-${item.id}`);
    assert.equal(importCalls[0]!.paper.title, "Published PDF");
    assert.equal(importCalls[0]!.paper.tentative, true);
    assert.equal(
      importCalls[0]!.paper.candidate?.candidateTitle,
      "The Lazy Brown Dog",
      "the confirmed candidate should be passed to the merge",
    );

    const data = plugin.data.arXivUpdate.tableData[0];
    assert.equal(data.status, "updated");
    assert.equal(data.pendingPaper, undefined);
    await item.eraseTx();
  });

  it("dialog without a candidate URL hides the review link", async function () {
    const item = await makeItem("Paper Number Six", "2409.00006");
    plugin.data.arXivUpdate.tableData.push(
      candidate(item.id, item.getDisplayTitle(), "PubMed", "Some Title", null),
    );

    await UpdateDialog.open();
    const win = await waitForWindow(1);
    const dialog = await clickLinkAndWait(win);

    const linkContainer = dialog.document.getElementById(
      `${config.addonRef}-candidate-link`,
    )!;
    assert.equal(
      linkContainer.style.display,
      "none",
      "link line should be hidden without a candidate URL",
    );
    assert.equal(
      linkContainer.querySelector("a.candidate-link"),
      null,
      "no link should be rendered without a candidate URL",
    );

    dialogButton(dialog, "extra1").click();
    await waitForCondition(
      "row to become up-to-date",
      () => plugin.data.arXivUpdate.tableData[0]?.status === "up-to-date",
    );
    await item.eraseTx();
  });

  it("skip button in the dialog marks the row up-to-date", async function () {
    const item = await makeItem("Paper Number Two", "2409.00002");
    plugin.data.arXivUpdate.tableData.push(
      candidate(item.id, item.getDisplayTitle()),
    );

    await UpdateDialog.open();
    const win = await waitForWindow(1);
    const dialog = await clickLinkAndWait(win);

    dialogButton(dialog, "extra1").click();
    await waitForCondition(
      "row to become up-to-date",
      () => plugin.data.arXivUpdate.tableData[0]?.status === "up-to-date",
    );

    const data = plugin.data.arXivUpdate.tableData[0];
    assert.equal(data.status, "up-to-date");
    assert.equal(data.pendingPaper, undefined);
    await item.eraseTx();
  });

  it("closing the confirmation dialog leaves the row pending", async function () {
    const item = await makeItem("Paper Number Three", "2409.00003");
    plugin.data.arXivUpdate.tableData.push(
      candidate(item.id, item.getDisplayTitle()),
    );

    await UpdateDialog.open();
    const win = await waitForWindow(1);
    const dialog = await clickLinkAndWait(win);

    dialog.close();
    await Zotero.Promise.delay(300);

    const data = plugin.data.arXivUpdate.tableData[0];
    assert.equal(
      data.status,
      "needs-confirmation",
      "closing the dialog should keep the row pending",
    );
    assert.ok(data.pendingPaper, "pending paper should be retained");
    await item.eraseTx();
  });

  it("window close keeps pending candidates", async function () {
    const item = await makeItem("Paper Number Five", "2409.00005");
    plugin.data.arXivUpdate.tableData.push(
      candidate(item.id, item.getDisplayTitle()),
    );

    await UpdateDialog.open();
    const win = await waitForWindow(1);
    win.close();
    await Zotero.Promise.delay(300);

    const data = plugin.data.arXivUpdate.tableData[0];
    assert.equal(
      data.status,
      "needs-confirmation",
      "closing the window should keep the pending candidate",
    );
    assert.ok(data.pendingPaper, "pending paper should be retained");
    await item.eraseTx();
  });
});
