import { config } from "../../../package.json";
import { diffWords } from "diff";
import { getString } from "../../utils/locale";
import {
  CandidateSource,
  SOURCE_KEYS,
  SourceProgress,
  SourceKey,
  TentativePaperIdentifier,
  UpdateTableData,
} from "../../types";
import {
  STATUS_COLOR,
  simplifyUpdateStatus,
  type SimpleUpdateStatus,
} from "./status";
import type { UpdateManager } from "./manager";

const htmlNS = "http://www.w3.org/1999/xhtml";

/**
 * Everything the drawer renders, derived from a row so the state→view mapping
 * is unit-testable without a DOM.
 */
export type DrawerView = {
  /** Preprint title (shown in the header). */
  title: string;
  /** Display status category; renderers pick the swatch color from it. */
  status: SimpleUpdateStatus;
  /** Localized status text. */
  statusText: string;
  message?: string;
  candidate?: { candidateTitle: string; meta: string; url?: string };
  sources: SourceProgress;
};

/** Pure state→view mapping. */
export function drawerView(
  row: UpdateTableData,
  candidate?: TentativePaperIdentifier,
): DrawerView {
  const status = simplifyUpdateStatus(row.status);
  const sources = row.sources ?? {};
  return {
    title: row.title,
    status,
    statusText: getString("update-status", row.status),
    message: row.message,
    candidate:
      row.status === "needs-confirmation" && candidate
        ? {
            candidateTitle: candidate.candidate.candidateTitle,
            meta: candidateMeta(candidate),
            url: candidate.candidate.url,
          }
        : undefined,
    sources,
  };
}

/** Map a candidate's source to the shared `source-name` locale key. */
const CANDIDATE_SOURCE_KEY: Record<CandidateSource, SourceKey> = {
  DBLP: "dblp",
  PubMed: "pubMed",
  Crossref: "crossref",
};

function candidateMeta(candidate: TentativePaperIdentifier): string {
  const info = candidate.candidate;
  return [
    getString("source-name", CANDIDATE_SOURCE_KEY[info.source]),
    info.publication,
    info.year,
  ]
    .filter(Boolean)
    .join(" · ");
}

function elId(suffix: string): string {
  return `${config.addonRef}-${suffix}`;
}

function getEl(document: Document, suffix: string): HTMLElement | null {
  return document.getElementById(elId(suffix)) as HTMLElement | null;
}

function setText(document: Document, suffix: string, text: string) {
  const el = document.getElementById(elId(suffix));
  if (el) el.textContent = text;
}

// Append the word-level diff, highlighting only words the candidate adds.
// Preprint-only words are skipped (the header already shows the preprint).
function fillAddedDiff(
  document: Document,
  container: Element,
  diff: ReturnType<typeof diffWords>,
) {
  for (const part of diff) {
    if (part.removed) continue;
    if (part.added) {
      const b = document.createElementNS(htmlNS, "b") as HTMLElement;
      b.textContent = part.value;
      b.style.color = "var(--accent-green)";
      container.appendChild(b);
    } else {
      container.appendChild(document.createTextNode(part.value));
    }
  }
}

/** Render a view into the drawer DOM (no row/status access). */
export function renderDrawer(document: Document, view: DrawerView) {
  setText(document, "drawer-title", view.title);
  renderStatusLine(document, view.status, view.statusText);

  const message = getEl(document, "drawer-message");
  if (message) {
    message.textContent = view.message ?? "";
    message.style.display = view.message ? "" : "none";
  }

  const candidate = getEl(document, "drawer-candidate");
  if (candidate) candidate.style.display = view.candidate ? "" : "none";
  if (view.candidate) {
    const title = document.getElementById(elId("drawer-candidate-title"));
    if (title) {
      title.textContent = "";
      fillAddedDiff(
        document,
        title,
        diffWords(view.title, view.candidate.candidateTitle, {
          ignoreCase: true,
        }),
      );
    }
    setText(document, "drawer-candidate-meta", view.candidate.meta);
    renderCandidateLink(document, view.candidate.url);
  }

  for (const suffix of ["drawer-actions", "drawer-divider"]) {
    const el = getEl(document, suffix);
    if (el) el.style.display = view.candidate ? "" : "none";
  }

  renderSources(document, view.sources);
}

// Status line: a colored swatch followed by the localized status text.
// `.tag-swatch` draws Zotero's tag-circle SVG, tinted from `color`.
function renderStatusLine(
  document: Document,
  status: SimpleUpdateStatus,
  text: string,
) {
  const container = getEl(document, "drawer-status");
  if (!container) return;
  container.textContent = "";
  const swatch = document.createElementNS(htmlNS, "span") as HTMLElement;
  swatch.className = "tag-swatch";
  swatch.style.color = STATUS_COLOR[status];
  container.append(swatch, document.createTextNode(" " + text));
}

function renderCandidateLink(document: Document, url?: string) {
  const container = getEl(document, "drawer-candidate-link");
  if (!container) return;
  container.textContent = "";
  if (!url) {
    container.style.display = "none";
    return;
  }
  container.style.display = "";
  const link = document.createElementNS(htmlNS, "a") as HTMLAnchorElement;
  link.className = "candidate-link";
  link.setAttribute("href", url);
  link.textContent = getString("review-action", "view-candidate");
  link.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    Zotero.launchURL(url);
  });
  container.appendChild(link);
}

function renderSources(document: Document, sources: SourceProgress) {
  const container = document.getElementById(elId("drawer-sources"));
  if (!container) return;
  container.textContent = "";
  // Iterate the canonical source order, not the order entries arrived in, so
  // the checklist is stable across runs and never-run sources are simply absent.
  for (const key of SOURCE_KEYS) {
    const source = sources[key];
    if (!source) continue;
    const item = document.createElementNS(htmlNS, "li");
    item.className = "drawer-source";

    const icon = document.createElementNS(htmlNS, "span") as HTMLElement;
    icon.className = `source-icon source-icon-${source.outcome}`;
    // The outcome text next to the icon already names the state.
    icon.setAttribute("aria-hidden", "true");

    const name = document.createElementNS(htmlNS, "span");
    name.className = "source-name";
    name.textContent = getString("source-name", key);

    const outcome = document.createElementNS(htmlNS, "span");
    outcome.className = "source-outcome";
    outcome.textContent = getString("source-outcome", source.outcome);

    item.append(icon, name, outcome);
    if (source.outcome === "failed" && source.detail) {
      const detail = document.createElementNS(htmlNS, "span");
      detail.className = "source-detail";
      detail.textContent = source.detail;
      item.appendChild(detail);
    }
    container.appendChild(item);
  }
}

/**
 * Owns the drawer's live state. Binds to the row **id**, not the selection
 * index: rows re-sort on every status change while the selection stays an
 * index (and `onSelectionChange` does not fire on re-sort), so the index could
 * silently swap the drawer — and its Confirm target — mid-review.
 */
export class DetailDrawer {
  private currentId?: number;

  constructor(
    private readonly document: Document,
    private readonly manager: UpdateManager,
  ) {
    this.wire();
  }

  isOpen(): boolean {
    return this.currentId !== undefined;
  }

  /** Open for a row id, captured for later re-renders. */
  open(id: number) {
    this.currentId = id;
    this.setVisible(true);
    this.render();
  }

  /** Re-resolve the captured id and repaint. A vanished row closes the drawer. */
  render() {
    const id = this.currentId;
    if (id === undefined) return;
    const row = this.manager.getRow(id);
    if (!row) {
      this.close();
      return;
    }
    renderDrawer(
      this.document,
      drawerView(row, this.manager.getPendingPaper(id)),
    );
  }

  close() {
    this.currentId = undefined;
    this.setVisible(false);
  }

  private setVisible(visible: boolean) {
    const drawer = getEl(this.document, "drawer");
    if (drawer) drawer.style.display = visible ? "flex" : "none";
    const scrim = getEl(this.document, "drawer-scrim");
    if (scrim) scrim.style.display = visible ? "block" : "none";
  }

  // Attach the drawer's handlers once, when the dialog is constructed.
  private wire() {
    const document = this.document;
    const closeButton = getEl(document, "drawer-close");
    if (closeButton) {
      const label = getString("drawer-close");
      closeButton.setAttribute("aria-label", label);
      closeButton.setAttribute("title", label);
      closeButton.addEventListener("click", () => this.close());
    }
    getEl(document, "drawer-scrim")?.addEventListener("click", () =>
      this.close(),
    );
    const confirm = getEl(document, "drawer-confirm");
    if (confirm) {
      confirm.textContent = getString("review-action", "confirm");
      confirm.addEventListener("click", () => {
        if (this.currentId !== undefined) {
          void this.manager.confirm(this.currentId);
        }
      });
    }
    const skip = getEl(document, "drawer-skip");
    if (skip) {
      skip.textContent = getString("review-action", "skip");
      skip.addEventListener("click", () => {
        if (this.currentId !== undefined) {
          void this.manager.skip(this.currentId);
        }
      });
    }
  }
}
