export type CandidateSource = "DBLP" | "PubMed";

export type CandidateInfo = {
  source: CandidateSource;
  candidateTitle: string;
  publication?: string;
  year?: string;
  score: number;
  /** Human-review link to the candidate page; may differ from the import URL. */
  url?: string;
};

// A definitive match. No `candidate`: imported directly.
// A fuzzy match. `tentative: true` and `candidate` always together.
export type PaperIdentifier = {
  doi?: string;
  url?: string;
  title: string;
} & ({ tentative?: false } | { tentative: true; candidate: CandidateInfo });

/** A `PaperIdentifier` that is known to be a fuzzy (tentative) match. */
export type TentativePaperIdentifier = PaperIdentifier & {
  tentative: true;
  candidate: CandidateInfo;
};

/** Narrow a `PaperIdentifier` to its fuzzy form, if it is one. */
export function isTentativePaperIdentifier(
  paper: PaperIdentifier | undefined,
): paper is TentativePaperIdentifier {
  return paper?.tentative === true;
}

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
