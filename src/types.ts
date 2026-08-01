import type { VirtualizedTableHelper } from "zotero-plugin-toolkit";
import type PQueue from "p-queue";

export type CandidateSource = "DBLP" | "PubMed";

export type PaperIdentifier = {
  doi?: string;
  url?: string;
  title: string;
  /** True when this is a fuzzy match awaiting user confirmation. */
  tentative?: boolean;
  /** Present when `tentative`; describes the candidate for the review UI. */
  candidate?: {
    source: CandidateSource;
    candidateTitle: string;
    publication?: string;
    year?: string;
    score: number;
    /** Human-review link to the candidate page; may differ from the import URL. */
    url?: string;
  };
};

export type UpdateStatus =
  | "pending"
  | "finding-update"
  | "downloading-metadata"
  | "downloading-pdf"
  | "needs-confirmation"
  | "up-to-date"
  | "updated"
  | "download-error"
  | "general-error";

export type UpdateTableData = {
  id: number;
  title: string;
  status: UpdateStatus;
  message?: string;
  pendingPaper?: PaperIdentifier;
};
export type UpdateWindowData = {
  tableData: UpdateTableData[];
  tableHelper?: VirtualizedTableHelper;
  window?: WindowProxy;
  unregisterObserver?: () => void;
  queue: PQueue;
};
