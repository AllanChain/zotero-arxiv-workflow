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
  parked reviews), `update-dialog.ts` (windows), `status.ts`. Pure title
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
- **Table cells bind to the row id, never the render `index`** — rows re-sort
  on every `updateRow`. Same reason `openCandidateDialog` is written once and
  never cleared: the guard asks `window.closed`; a resettable "is a dialog
  open" flag is what races. A click while a dialog is open _replaces_ it
  (close + reopen) rather than focusing it — Wayland forbids one window from
  raising another. Safe because the dialog's `unload` resolves its opener's
  `answer` as `cancel`, leaving that row pending.
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
  `src/` modules. Dialog tests drive the real XHTML via `UpdateDialog`
  statics as the seam: fake `window` as `{ document, closed }`, restore
  statics in `afterEach`, seed `manager.reviews` directly, and find live
  confirm dialogs with `findCandidateDialogs()`.
- **Keep the fuzzy fixtures honest**: `createDBLPFuzzyHit()` /
  `createSOAPPreprint()` mirror the real #106 case (extended title, same
  first author, same year); the preprint fixture needs a `date` or the year
  gate is only half-tested.
