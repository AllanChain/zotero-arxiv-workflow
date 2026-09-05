# Repository Guidelines

Contributor guide for **arXiv Workflow for Zotero**, a Zotero 8/9/10 plugin that
updates preprint entries (arXiv, bio/med/chem/psy-arXiv) with their published
versions: find the DOI/URL, import the journal item, merge it with the preprint.
Built from the [Zotero plugin template](https://github.com/windingwind/zotero-plugin-template)
with TypeScript, `zotero-plugin-toolkit`, and `zotero-plugin-scaffold`.

## Structure

- `src/` — entry points `addon.ts` / `hooks.ts` / `index.ts`; features in
  `src/modules/` (`arxiv-merge`, `prefer-pdf`, `update-pdf`, `preferences`,
  `arxiv-update`); cross-cutting helpers in `src/utils/`.
- `src/modules/arxiv-update/` — the update pipeline, split by responsibility:
  `fetcher.ts` all network I/O (per-host throttle, timeouts, credentials),
  `paper-finder.ts` "which DOI/URL does this preprint correspond to" (one
  method per source, `find()` as a resumable generator), `manager.ts`
  `UpdateManager` (task queue, row state, and the paused reviews, notifies
  `onChange`), `update-dialog.ts` the dialog window/table plus the
  candidate-confirm window, `status.ts` status grouping and sort order.
  Shared pure matching lives in `src/utils/title-match.ts`; the row/paper
  types (`PaperIdentifier`, `CandidateInfo`, `FinderIterator`,
  `UpdateTableData`) are in `src/types.ts`.
- `test/` — mocha specs mirroring the `src/` layout (`test/arxiv-update/` for
  the update feature). `test/helpers.ts` is Zotero test setup;
  `test/arxiv-update/helpers.ts` holds shared update fixtures.
- `addon/` — packaged assets: `manifest.json`, `prefs.js`, `bootstrap.js`,
  XHTML/CSS in `content/`, strings in `locale/` (`en-US`, `zh-CN`).
- `typings/` — ambient declarations; `build/` — generated `.xpi` (gitignored).

When in doubt about `Zotero.*` behavior, read Zotero's own source
(https://github.com/zotero/zotero, mainly `chrome/content/zotero/xpcom/`) —
several gotchas below rest on it.

## Commands

```bash
npm run start      # build + launch Zotero with the plugin (dev)
npm run build      # build the .xpi and type-check (tsc --noEmit)
npm test           # mocha against a real Zotero instance
npm run lint:check # prettier + eslint (lint:fix to auto-apply)
```

Dev and tests both need `.env` (copy `.env.example`) pointing at a Zotero binary
and a scratch profile. Tests are offline by design — see below.

## Style

- TypeScript, Prettier (2-space, LF, 80 col), ESLint via
  `@zotero-plugin/eslint-config`.
- Features go in `src/modules/`, reusable code in `src/utils/`; prefer
  domain-meaningful helpers over inline logic.

## Testing

- `npm test` defaults to **watch mode and never exits** — run
  `npm test -- --exit-on-finish` for a clean exit code. Mocha flags
  (`--grep`, `--debug`) are not supported. Each run is ~15-30 s.
- The suite is **stateful**: all specs share the profile at `.scaffold/test/`.
  Unexplained failures (`ztoolkit is not defined`, `merge` `before all` hook)
  are usually stale state — rerun once before debugging. Reset shared prefs
  through `resetUpdateSourcePrefs()`, not per-pref one-offs.
- Keep tests offline: inject the `UpdateManager` seams and set
  `downloadJournalPDF` to `false`, otherwise the task reaches
  `Zotero.Attachments.addAvailableFile` and the network.

## Gotchas

- **Network only through `fetcher.ts`.** `Zotero.HTTP.request` (not `fetch`) is
  required so requests follow Zotero's proxy/cookie setup that campus users rely
  on. Every URL goes through a per-host queue (1 request / 1.5 s). Zotero itself
  already retries 429/5xx and honors `Retry-After` (`errorDelayMax: 30000` caps
  our side), so **do not add another retry layer** — an API key buys latency,
  not correctness; word the settings copy accordingly.
- **Keep the finder seam URL-only.** `PaperFinder` takes `(item, fetcher)` where
  `Fetcher` is `{ fetchText, fetchJSON }`; headers/auth are applied inside
  `requestBounded` via `authHeaders(url)`. That keeps a key from leaking to the
  wrong host, keeps finders as "decode this response" logic, and makes
  `authHeaders` the single place to assert what goes on the wire. Don't add
  pref/logging/request-option injection to `PaperFinder` — tests have real prefs
  (via `setPluginPref`) and real `ztoolkit` (via `getPlugin()`).
- **`PaperFinder.find()` tries enabled sources in a fixed order** (`updateSource.*`
  prefs) and swallows each source's failure. A _definitive_ result — a DOI from
  `relatedDOI`/`semanticScholar`, or an exact title match from DBLP/PubMed —
  wins immediately and later sources are never queried. Fuzzy matches never
  are: the strongest one across _all_ published sources is held for user
  confirmation, so a strong PubMed hit beats a weak DBLP hit regardless of
  order. A missing result is therefore "no source matched", not "no error
  occurred" — check the task log before assuming a source is broken.
- **`find()` is a resumable generator, not a promise.** It yields the best
  `TentativePaperIdentifier` and stops; `_all_` published sources have already
  been queried by then, so a yield costs the whole published search. Resuming
  it means the user _rejected_ the candidate, which is what unlocks the arXiv
  self-update stage; confirming never resumes it (the approved candidate is
  imported directly). Don't "simplify" this to a promise — the pause is the
  feature. Only one candidate is surfaced per run; the rest are dropped.
- **A `needs-confirmation` row is parked state in the manager, not a waiting
  task.** The task reports the status and returns, freeing its concurrency
  slot; `UpdateManager.reviews` (keyed by row id) holds the item, the
  candidate, and the paused iterator until the user acts. `confirm()` /
  `skip()` both re-enter through `runTask`, so they stay throttled — never do
  that work inline. Parked rows survive the dialog window closing, and nothing
  yet drops a review when its item is deleted from the library.
- **`PaperIdentifier` is a discriminated union on `tentative`** (`src/types.ts`):
  `{ tentative: true, candidate }` for a fuzzy match, `tentative?: false`
  otherwise. Use `isTentativePaperIdentifier()` to branch; a fuzzy candidate is
  only importable after confirmation, so nothing may treat `candidate` as
  optional on the tentative side.
- **Update-table cells bind to the row id, never the render `index`** —
  `sortByStatusPriority` reorders rows on every `updateRow`, so an index
  captured at render time can name a different row by click time. For the same
  reason `UpdateDialog.openCandidateDialog` holds the dialog _window_ and is
  written once, never cleared: the click guard asks `window.closed`. An "is a
  dialog open" flag that several code paths reset (including the dialog's
  `unload`) is what races — a late reset unlocks a dialog opened afterwards, a
  missed reset locks the feature forever.
- **`UpdateManager` has two injectable seams** (`UpdateManagerOptions`):
  `fetcher` and `createItem`. Tests replace both so find → import → merge →
  report runs offline; the production defaults are `defaultFetcher` and the
  translator-based `createItemByZotero`.
- **`PQueue.add()` starts the task synchronously**, so the first status is
  reported before `createUpdateTasks` fires its own `onChange`. Assert on
  deduped/ordered statuses (`trackStatuses` / `assertInOrder` in
  `manager.test.ts`), not on an exact `onChange` sequence.
- **Test path aliases depend on esbuild's tsconfig auto-discovery.**
  `zotero-plugin test` passes neither `alias` nor `tsconfig`, so `@/*`,
  `@test/*`, `@pkg` resolve only through `compilerOptions.paths` in the _root_
  `tsconfig.json` (the map would resolve to `test/src` if moved into
  `test/tsconfig.json`). Keep it baseUrl-less — TS 6 rejects `baseUrl`. A broken
  alias surfaces only as an esbuild error in `npm test`, never in `npm run build`.
- **Test bundles run as scripts in the Zotero window, not the plugin sandbox**,
  so `ztoolkit` / `addon` are undefined until `getPlugin()` runs in a `before`
  hook. Any spec that imports `src/` modules needs that call first.
- **Dialog tests drive the real `update-dialog.xhtml`** and
  `candidate-confirm.xhtml` (chrome:// resolves because the tester loads the
  real plugin) and rely on `UpdateDialog`'s statics (`window`, `tableHelper`,
  `open`, `openCandidateDialog`) as the seam — fake `window` as
  `{ document, closed }` and restore the statics in `afterEach`. Confirmation
  tests seed `manager.reviews` directly instead of running a finder, and find
  the live confirm dialog by enumerating `Services.wm` for the preprint-title
  element (see `findCandidateDialogs`).
- **Keep the fuzzy fixtures honest.** `createDBLPFuzzyHit()` / `createSOAPPreprint()`
  mirror the real #106 case (extended title, same first author, same year); the
  preprint fixture needs a `date` or the year gate is only half-tested.

## Commits & PRs

- Conventional Commits (commitlint + husky): lowercase subject ≤ 50 chars,
  types `feat`/`fix`/`docs`/`style`/`refactor`/`test`/`ci`/`chore`; explain the
  _why_ in the body.
- PRs target `main` and must pass CI (lint, build, test on Zotero 8/9/10).
