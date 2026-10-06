# Repository Guidelines

**arXiv Workflow for Zotero** — a Zotero 8/9/10 plugin
that updates preprint entries (arXiv, bio/med/chem/psy-arXiv) with their
published versions: find the DOI/URL, import the journal item, merge it with
the preprint. When in doubt about `Zotero.*` behavior, read Zotero's own
source (https://github.com/zotero/zotero, `chrome/content/zotero/xpcom/`).

## Layout & testing

- Features in `src/modules/<name>/`, cross-cutting helpers in `src/utils/`.
- `arxiv-update/` pipeline: `fetcher.ts` (all network I/O), `paper-finder.ts`
  (per-source finders + the `find()` generator), `manager.ts` (queue, rows,
  parked reviews, per-source progress), `update-dialog.ts` (window + table),
  `detail-drawer.ts` (selection-driven side panel), `status.ts`. Pure title
  matching in `src/utils/title-match.ts`; types in `src/types.ts`.
- `test/` mirrors `src/`; `test/arxiv-update/helpers.ts` holds update
  fixtures. Dev and tests need `.env` (copy `.env.example`).
- `npm test` is watch mode and never exits: use `npm test -- --exit-on-finish`
  for a clean exit code. Mocha flags (`--grep`, `--debug`) are unsupported.
  ~15–30 s per run.
- The suite is stateful (shared `.scaffold/test/` profile): unexplained
  failures are usually stale state — rerun once before debugging. Reset prefs
  via `resetUpdateSourcePrefs()`, not per-pref one-offs.
- Keep tests offline: inject the `UpdateManager` seams and set
  `downloadJournalPDF` to `false`, or the task reaches the network.
