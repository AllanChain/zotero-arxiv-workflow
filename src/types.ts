export type CandidateSource = "DBLP" | "PubMed" | "Crossref";

export type CandidateInfo = {
  source: CandidateSource;
  candidateTitle: string;
  publication?: string;
  year?: string;
  score: number;
  /** Human-review link to the candidate page; may differ from the import URL. */
  url?: string;
};

// A definitive match: no `candidate`, imported directly.
// A fuzzy match: `tentative: true` and `candidate` always travel together.
// The discriminated `tentative` field lets consumers exhaustively handle
// both kinds (see `isTentativePaperIdentifier`).
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

/**
 * A resumable paper-finding pipeline. It yields each tentative candidate
 * that needs user confirmation and returns the final importable paper (or
 * undefined) when the pipeline is exhausted. Resuming the pipeline with
 * `next()` means the yielded candidate was rejected, so the remaining stages
 * run; a confirmed candidate is imported directly by the caller and never
 * resumes the pipeline.
 */
export type FinderIterator = AsyncGenerator<
  TentativePaperIdentifier,
  PaperIdentifier | undefined,
  void
>;

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

/** Every source the update pipeline can query. */
export const SOURCE_KEYS = [
  "relatedDOI",
  "semanticScholar",
  "dblp",
  "pubMed",
  "crossref",
  "arXivPDF",
] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

export const SOURCE_OUTCOMES = ["running", "empty", "found", "failed"] as const;
export type SourceOutcome = (typeof SOURCE_OUTCOMES)[number];

/**
 * One source's state. A failure always carries its reason; other outcomes
 * carry nothing more.
 */
export type SourceState =
  | { outcome: Exclude<SourceOutcome, "failed"> }
  | { outcome: "failed"; detail: string };

/** One reported state change: the source plus its new state. */
export type SourceCheck = SourceState & { key: SourceKey };

/** Per-source state within a row's update run, keyed by source. */
export type SourceProgress = Partial<Record<SourceKey, SourceState>>;

export type UpdateTableData = {
  id: number;
  title: string;
  status: UpdateStatus;
  message?: string;
  sources?: SourceProgress;
};
