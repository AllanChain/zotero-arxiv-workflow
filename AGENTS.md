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
  method per source), `manager.ts` `UpdateManager` (task queue + row state,
  notifies `onChange`), `update-dialog.ts` the dialog window/table,
  `status.ts` status grouping and sort order.
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
  prefs) and swallows each source's failure, returning the first hit. A missing
  result is therefore "no source matched", not "no error occurred" — check the
  task log before assuming a source is broken.
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
- **Dialog tests drive the real `update-dialog.xhtml`** (chrome:// resolves
  because the tester loads the real plugin) and rely on `UpdateDialog`'s statics
  (`window`, `tableHelper`, `open`) as the seam — fake `window` as
  `{ document, closed }` and restore the statics in `afterEach`.

## Commits & PRs

- Conventional Commits (commitlint + husky): lowercase subject ≤ 50 chars,
  types `feat`/`fix`/`docs`/`style`/`refactor`/`test`/`ci`/`chore`; explain the
  _why_ in the body.
- PRs target `main` and must pass CI (lint, build, test on Zotero 8/9/10).
