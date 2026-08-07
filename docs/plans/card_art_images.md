# Plan: Card Art Images (scanner toast, staging search, merge viewer)

## Goal
Show real card art in three places that currently render text-only:
1. Scanner match toast (`showMatchSplash`) — replaces the live-scanned crop.
2. Staging review's card search results and staged-card list.
3. Merge viewer rows (staging column + diff panels).

## Decisions
- **Scanner toast:** Scryfall art *replaces* the scanned crop canvas — the confidence % already tells the user how sure the match is; showing both the scan and the art is redundant.
- **Merge viewer:** small square art-crop thumbnail before the name, sized to fit the existing fixed `2.2rem` row height (`styles.css:664-669`) so panel scroll-sync isn't affected.
- **Source: pre-bundled at build time**, not live Scryfall fetches. Reuses the existing (currently hash-DB-only) `tools/download-art.ts` dedup-by-`illustration_id` pipeline — the same key already carried on every `StagedCard`/`CardEntry`/search result.
- **No network fallback.** If a thumbnail isn't in the bundle (card added after the last DB rebuild, or a build failure for that one image), the UI simply shows no image — text-only, same as today. No new SW route, no live Scryfall calls.

## The size problem
`metadata.json` has 51,371 unique illustrations. Any of them can be scanned or searched offline at any time, so thumbnails need the same precache discipline as the hash DB (not a "cache what's been seen" lazy scheme). Individual per-card files at any real quality would be tens of MB across 51k separate small HTTP requests.

Minimal approach: extremely small (~32×45px) WebP thumbnails packed into **one binary blob** (same pattern as the hash DB), with a byte-offset index. Ballpark: ~500–800 bytes/thumbnail × 51k ≈ 25–40MB total, one file, one HTTP request — cached exactly like `db/hashdb.bin` today.

## Build-time changes
1. **`tools/download-art.ts`** (exists, currently only feeds the hash builder): add a resize+recompress step per downloaded `art_crop` → tiny WebP. Check for an already-available image-resize primitive (Deno std, or whatever the project already depends on) before adding a new dependency.
2. **New `tools/build-thumbdb.ts`** (mirrors `build-hashdb.ts`): pack all thumbnails into `public/db/thumbs.bin` + `public/db/thumbs-index.json` (`illustration_id → {offset, length}`). Content-hash it into the existing `version.json` stamp alongside the hash DB (`sw.ts:100-112` already treats `?v=<hash>` as the cache-busting mechanism for `db/`).
3. Wire into the existing `deno task db:*` pipeline — extend it, don't add a new top-level task type.

## Runtime changes
4. **New `src/collection/thumb-store.ts`**: loads `thumbs-index.json`, fetches `thumbs.bin` once (or via `Range` requests, whichever fits the existing metadata-worker loading pattern in `src/workers/metadata-worker.ts`), slices out each thumbnail, and returns a Blob URL per `illustration_id`. Lazy-init once, same lifecycle as metadata load. Returns `undefined` for unknown ids — no error, no placeholder fetch.
5. **`sw.ts`**: `thumbs.bin`/`thumbs-index.json` live under `public/db/`, so they're automatically covered by the existing cache-first `db/` branch (`sw.ts:106-112`). No new route.

## UI changes
6. **`src/ui/scanner-view.ts`**: `showMatchSplash()` (`:808-845`) — replace the `<canvas>` scanned-crop path with an `<img>` sourced from `thumbStore.get(illustrationId)`; if `undefined`, hide the image element (same as the current `cardImage` falsy branch). Keep name/confidence text unchanged. Once nothing else consumes the scanned `cardImage`, drop that plumbing from `handleCapture()` (`:295,317,340`) and `identify.ts` — check callers first before removing.
7. **`src/collection/card-search.ts`**: no data-shape change — `searchCards()` already returns `illustrationId`.
8. **`showStagingReview()`** search results (`:513-521`) and **`renderStagedCard()`** (`:551-567`): add a small `<img>` per row keyed by `illustrationId` / `item.illustrationId`; omit the element entirely when the store returns `undefined`.
9. **`src/ui/merge-view.ts`**: `renderPlainRow()` (`:338`) and `renderDiffRow()` (`:348`) — add a thumbnail `<img>` before `merge-row-name`, omitted when missing. **Prerequisite to verify:** confirm `MergeCard` actually carries `illustrationId` through from `StagedCard`/`CardEntry` (currently only `scryfallId`/`setCode`/`collectorNumber`/`name`/`quantity` are used in these renderers) — trace the type definition in `src/collection/store.ts` and wherever `MergeCard`/`SortableCard`/`DiffableCard` are declared before assuming this is a no-op on the data side.
10. **`src/styles.css`**: `.match-splash img` sizing (reuse existing canvas sizing rules `:750-780`); new small thumbnail style for `.staging-search-result`/`.staged-card`; `.merge-row` thumbnail sized to fit the fixed `2.2rem` row (`:664-669`).

## Verification
- Run the build pipeline; confirm `thumbs.bin`/`thumbs-index.json` are produced and land in the expected size ballpark; spot-check a handful of illustration_ids decode to valid small images.
- Manual pass: scan a card → toast shows art; open staging search → thumbnails in dropdown and staged list; open merge viewer → thumbnails in all panels, rows still aligned across panel scroll-sync.
- Offline check (SW installed, network off): all three surfaces show art for bundled cards; cards missing from the bundle show text-only, no broken image icon, no layout shift.

## New/changed files (summary)
- New: `tools/build-thumbdb.ts`, `src/collection/thumb-store.ts`, `public/db/thumbs.bin`, `public/db/thumbs-index.json`, `docs/plans/card_art_images.md`.
- Changed: `tools/download-art.ts` (resize step), `src/ui/scanner-view.ts` (toast + staging rows), `src/ui/merge-view.ts` (row thumbnails), `src/styles.css` (thumbnail sizing), possibly `src/collection/store.ts` (thread `illustrationId` into `MergeCard` if missing), `deno.json` (extend `db:*` task).
