# Repository Guidelines

Contributor guide for **arXiv Workflow for Zotero** — a Zotero 8/9/10 plugin
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

## Gotchas

- **Network only through `fetcher.ts`, and no retry layer** — Zotero already
  retries 429/5xx and honors `Retry-After`. Keep the `PaperFinder` seam
  URL-only: credentials flow through `authHeaders(url)` in `requestBounded`,
  so don't add pref/logging/request-option injection to `PaperFinder`.
- **`find()` is a resumable generator — the pause is the feature.** A
  definitive match returns immediately; the strongest fuzzy match across all
  enabled sources is yielded for confirmation and parked in
  `manager.reviews`. Resuming means the user rejected the candidate (which
  unlocks the arXiv self-update stage); confirming imports the candidate
  directly. `confirm()`/`skip()` re-enter through the queue — never inline.
  Don't simplify it to a promise.
- **The detail drawer binds to the row id, never the selection `index`** —
  rows re-sort on every `updateRow` while the selection stays an index, so
  resolving through `getRows()[index]` would silently swap the drawer and its
  Confirm target. Consequence: after a re-sort the table highlight and the
  drawer row can diverge (accepted). On `unload` the drawer and the manager's
  `onChange` hook are dropped (guarded by window identity), so a late task
  cannot repaint a dead document.
- **Per-source progress is a plain callback, not an event stream.**
  `find(report?)` reports each state change with a complete `SourceCheck`;
  `manager.recordSource()` places it on `row.sources` by key. Nothing is
  pre-seeded, so a source appears only once it starts and a run ending on a
  definitive match leaves no phantom pending rows. `updateRow` re-sorts on
  every patch, but the sort is stable and keyed on status, so sources-only
  updates never reorder rows.
- **`PQueue.add()` starts the task synchronously**, so the first status
  arrives before `createUpdateTasks` fires `onChange` — assert on deduped/
  ordered statuses (`trackStatuses`/`assertInOrder`), not the exact sequence.
- **Test path aliases (`@/*`, `@test/*`, `@pkg`) resolve only through the
  root `tsconfig.json`** — `zotero-plugin test` passes neither `alias` nor
  `tsconfig` to esbuild, and the map would resolve to `test/src` if moved
  into `test/tsconfig.json`. Keep it baseUrl-less (TS 6 rejects `baseUrl`).
  Breakage surfaces only as an esbuild error in `npm test`.
- **Test bundles run as scripts in the Zotero window, not the plugin
  sandbox** — call `getPlugin()` in a `before` hook of any spec importing
  `src/` modules. Dialog tests drive the real XHTML (select a row with
  `treeInstance.selection.select(index)`); `drawerView` is unit-tested
  without a DOM. Fake `window` as `{ document, closed }` and restore statics
  in `afterEach`.
- **Keep the fuzzy fixtures honest**: `createDBLPFuzzyHit()` /
  `createSOAPPreprint()` mirror the real #106 case (extended title, same
  first author, same year); the preprint fixture needs a `date` or the year
  gate is only half-tested.
