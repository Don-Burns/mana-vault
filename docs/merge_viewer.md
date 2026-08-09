# Plan: Merge Viewer

## Goal
Add a "Merge Viewer" — a diff-style preview shown before committing a staging
confirm or a collection-to-collection move — so users see exactly what will
change in the affected collection(s) before confirming, git-diff style
(red = removal/decrease, green = addition/increase).

## Decisions (locked)
- **Entry points**: all three existing confirm flows open the merge viewer
  instead of committing directly:
  1. Scanner staging confirm, **Add** mode (`scanner-view.ts:508-576`,
     `confirmStaging`).
  2. Scanner staging confirm, **Remove** mode (same function/flow).
  3. Scanner staging confirm, **Move** mode (same function/flow).
  4. Collection-view **"Move selected"** — `handleMoveSelected`
     (`collection-view.ts:277-296`) already opens a proper `<dialog
     id="move-dialog">` with a `<select>` of destination folders (not a
     `prompt()` — that was wrong, no placeholder comment exists either). The
     commit itself happens in a separate function, `confirmMove`
     (`collection-view.ts:298-315`), which calls
     `collectionStore.moveCards(...)`. The merge viewer replaces `confirmMove`
     only: dialog confirm → open merge viewer → user confirms → commit.
     Folder selection stays exactly as it is today; no picker rework needed.
- **Diff coloring applies only to real collection panels**, not to the
  transient staging list:
  - The staging list (the temporary set of scanned/selected cards) is
    rendered plain — it's just "what you're about to apply," not a diff.
  - Every **real collection** touched by the operation gets a diffed panel:
    Add → destination folder only. Remove → source folder only. Move →
    **both** source and destination folders (each is a real collection
    changing state). Collection-view "Move selected" → both source and
    destination folders.
- **Ordering** is an ordered multi-select (checkbox per field, check order =
  priority order, each active field has its own asc/desc toggle, default
  asc) that applies uniformly to every panel in the viewer (staging list +
  all collection panels), so cards line up row-for-row across panels
  wherever possible. Default active criteria: **color, cmc, name** (all
  asc). Unchecking then rechecking a field re-appends it at the end of
  priority order (does not restore its old position).
- **Sort fields**: name, set + collector number, quantity are available
  immediately (already on `CardEntry`/`StagedCard`). CMC, color, and rarity
  are also in scope but require schema/data additions (see Phase 1).
- **Scope of this doc**: design only, no implementation yet.

## Background (current architecture)
- **Staging**: `StagingList` (`src/collection/staging.ts:34-147`), in-memory,
  pub/sub via `onChange`. `StagedCard` (`staging.ts:10-24`): `id,
  illustrationId, scryfallId, oracleId, name, setCode, setName,
  collectorNumber, quantity, condition, confidence, alternativePrintings?,
  scannedAt`.
- **Scanner confirm flow** (`src/ui/scanner-view.ts`):
  - `ScanMode = "add" | "remove" | "move"` (line 7).
  - `confirmStaging` (lines 508-576) resolves each staged card to a
    `CardEntry` in the relevant folder(s) via `resolveEntry`, then calls
    `collectionStore.addCard` / `removeCard`-equivalent / `moveCard`
    directly. No preview step exists today — confirm commits immediately.
    Unmatched cards are skipped and reported only as a count in a status
    string ("Moved N card(s), M skipped").
- **Collection-view move**: `handleMoveSelected` (`collection-view.ts:277-296`)
  already opens a `<dialog id="move-dialog">` with a folder `<select>`; the
  actual commit is in `confirmMove` (`collection-view.ts:298-315`), which
  calls `collectionStore.moveCards(ids, destFolderId)` (`store.ts:400-407`).
  No `prompt()` and no placeholder comment — this is a real dialog already,
  just missing the preview step.
- **Store data model** (`src/collection/store.ts`) — **backed by Turso
  (SQLite/WASM), not IndexedDB**: schema is a real SQL table
  (`store.ts:13-46`), so new columns need explicit `ALTER TABLE ... ADD
  COLUMN` in the schema, not a schemaless free-for-all.
  - `Folder` (50-57): `id, name, color, sortOrder, createdAt, isDefault?`.
  - `CardEntry` (59-73): `id, folderId, scryfallId, illustrationId, oracleId,
    name, setCode, setName, collectorNumber, quantity, condition, notes,
    dateAdded`. **No CMC/color/rarity fields.**
  - `moveCard`/`moveCards` (351-407) merge into an existing destination entry
    by `scryfallId` if present, otherwise create a new entry; decrement/delete
    the source entry.
- **No existing sort utility for card lists** — `collection-view.ts` renders
  `getCardsByFolder` results in raw index order, no `.sort()` anywhere for
  cards. Folder-level `sortOrder` (`store.ts:184-195`) is unrelated.
- **No existing diff/color-coded UI** — no added/removed CSS classes exist.
  `styles.css:15-16` defines `--success` (green) and `--warning` (orange)
  custom properties; no `--danger`/red variable yet.
- **No live Scryfall API calls at runtime** — the app only fetches a
  prebuilt `/db/metadata.json` (`scanner-view.ts:140-142`). Scryfall's bulk
  data is consumed offline by `tools/build-hashdb.ts`, via the `CardData`
  interface (`tools/config.ts:34-46`), which whitelists specific fields and
  currently **excludes `cmc`/`colors`/`rarity`**. These aren't "already
  fetched but unpersisted" at runtime — getting them requires widening
  `CardData` and `CardMetadata`/`IllustrationEntry`/`PrintingInfo`
  (`tools/config.ts:48-66`), then re-running the offline hash-db build to
  regenerate `metadata.json` before the runtime scanner can read them.
- `docs/usage_workflow.md` currently describes Add/Remove/Move scanner modes
  and check-in/check-out terminology (lines 17-39) without any preview step —
  this doc will need updating once the merge viewer ships.

## Data model changes (Phase 1)
To support CMC/color/rarity sorting, `CardEntry` and `StagedCard` need new
optional fields. Unlike a schemaless store, this touches three layers:
1. **Offline build tool**: widen `CardData` (`tools/config.ts:34-46`) to
   extract `cmc`/`colors`/`rarity` from the Scryfall bulk data, and add them
   to `CardMetadata`/`IllustrationEntry`/`PrintingInfo` (`tools/config.ts:
   48-66`) so they end up in the generated `metadata.json`.
2. **Re-run** `deno task db:build` (or equivalent) to regenerate
   `data/output/metadata.json` with the new fields present.
3. **Runtime**: add `cmc?`, `colors?`, `rarity?` to `CardEntry` (`store.ts:
   59-73`, plus `ALTER TABLE cards ADD COLUMN ...` in the SQL schema at
   `store.ts:13-46`) and `StagedCard` (`staging.ts:10-24`); thread them
   through `scanner-view.ts` where `illustration`/`defaultPrinting` are read
   from metadata (around line 332) into `staging.add(...)`.
```ts
cmc?: number;
colors?: string[];      // e.g. ["W", "U"], [] for colorless
rarity?: string;        // "common" | "uncommon" | "rare" | "mythic"
```
- Optional fields → existing rows without them just sort as "unknown" (push
  to end, stable fallback to name).
- Since this is a real SQLite table (Turso), missing columns must be added
  via `ALTER TABLE cards ADD COLUMN cmc REAL`, etc. in `SCHEMA` — `CREATE
  TABLE IF NOT EXISTS` alone won't add columns to an already-created table,
  so existing installs need an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  (or equivalent guarded migration) run at `open()` time.

## Ordering methods
An ordered multi-select, applied identically across every panel in the
viewer. Each field can be checked on/off; check order sets priority
(1st checked = primary key, etc.); each active field has its own asc/desc
toggle (default asc). A stable `name` (asc) tiebreak is always appended
last so ties don't jitter:
- **Name** (alphabetical) — no data dependency.
- **Set + collector number** — existing fields.
- **Quantity** — existing fields.
- **Mana value (CMC)** — needs Phase 1 field.
- **Color** (WUBRG + colorless/multicolor bucket order) — needs Phase 1 field.
- **Rarity** (common → uncommon → rare → mythic) — needs Phase 1 field.

Default active criteria on open: **color, cmc, name**, all ascending.

Implement as one shared `sortCards(cards, criteria)` utility (new file, e.g.
`src/collection/sort.ts`, `criteria: SortCriterion[]` where `SortCriterion =
{ method: SortMethod; direction: "asc" | "desc" }`) consumed by both the
merge viewer and (later, optionally) `collection-view.ts`, since no such
utility exists today.

## Diff computation
For each real collection panel, compute a row-level diff between "current
folder contents" and "contents after applying the pending operation":
- **Full addition** (card not previously in folder, or moving in a new
  printing): entire row green.
- **Full removal** (quantity would drop to 0, or card entirely removed):
  entire row red — no visual "half state," matches unix diff/git diff
  behavior for whole-line add/remove.
- **Quantity increase** (existing entry, count goes up): row stays neutral,
  only the new count number is green-highlighted, e.g. `2 → 5` with `5` in
  green.
- **Quantity decrease** (existing entry, count reduced but not to 0): same
  pattern, decreased number in red, e.g. `5 → 2` with `2` in red.
- Unchanged cards in a folder (present but not touched by the operation):
  rendered plain, no color — needed for context so the user can see where
  changed rows fall in the sort order.
- The staging list panel itself: plain rows, no diff color (see Decisions).

## CSS
- Add `--danger` custom property (red) alongside existing `--success` (green)
  in `styles.css` (near line 15-16).
- New classes: `.diff-row-added` / `.diff-row-removed` (full-row background/
  border tint) and `.diff-count-up` / `.diff-count-down` (inline color on the
  quantity number only), mirroring the existing `--success`/`--warning` usage
  pattern already in the codebase (e.g. `.staged-confidence`).

## UI shape
- New view/component, e.g. `src/ui/merge-view.ts`, opened modally (or as a
  full-screen overlay, consistent with the existing staging review overlay in
  `scanner-view.ts`) instead of the current inline confirm/`prompt()`.
- Layout: one panel per affected real collection (1 panel for Add/Remove, 2
  panels side-by-side for Move flows) + the plain staging list, all sharing
  the single ordering control.
- Confirm/Cancel buttons at the bottom, replacing the current direct-commit
  behavior in `confirmStaging` and the `prompt()` in `handleMoveSelected`.
- Skipped/unmatched cards (existing behavior in Remove/Move resolution)
  surface as their own visually distinct row (not red/green — no quantity
  change happens) with the existing skip-count summary text.

## Steps

### Phase 1 — Data (offline build + runtime schema)
- Widen `tools/config.ts`'s `CardData`/`CardMetadata`/`IllustrationEntry`/
  `PrintingInfo` to carry `cmc`/`colors`/`rarity` from Scryfall bulk data,
  re-run the hash-db build to regenerate `metadata.json`.
- Add `cmc?`, `colors?`, `rarity?` to `CardEntry` (`store.ts:59-73`) with a
  guarded `ALTER TABLE cards ADD COLUMN` migration in `SCHEMA`, and to
  `StagedCard` (`staging.ts:10-24`).
- Thread the fields from `scanner-view.ts`'s metadata lookup into
  `staging.add(...)` and from there into `collectionStore.addCard(...)`.
- Existing rows without these columns populated sort as "unknown"/fallback
  to name — no backfill required.

### Phase 2 — Ordering
- `src/collection/sort.ts`: `type SortMethod = "name" | "set" | "quantity" |
  "cmc" | "color" | "rarity"`; `SortCriterion = { method: SortMethod;
  direction: "asc" | "desc" }`; `sortCards(cards, criteria: SortCriterion[]):
  sorted copy`, chaining base-ascending comparators per criterion (flipped
  if `desc`), with a final stable `name` (asc) tiebreak.
- `DEFAULT_SORT_CRITERIA` = color/cmc/name, all asc.
- Unit test covering each method (single-criterion asc/desc), multi-criteria
  chaining/tie-break, and mixed/missing optional fields (pre-Phase-1
  records).
- Wire the ordered multi-select control (shared across all merge-viewer
  panels) — this can be built/tested standalone before the diff/UI phases
  exist.

### Phase 3 — Diff computation
- Pure function, e.g. `computeDiff(before: CardEntry[], after: CardEntry[]):
  DiffRow[]`, `DiffRow = { card, before: number, after: number }` — used to
  derive add/remove/increase/decrease per row.
- Unit test covering: full add, full remove, increase, decrease, unchanged.

### Phase 4 — UI
- Build `src/ui/merge-view.ts` per "UI shape" above; wire in CSS classes.
- Wire into `confirmStaging` (Add/Remove/Move) and `confirmMove`
  (`collection-view.ts:298-315`), replacing direct commit with "open merge
  viewer → user confirms → then commit using existing store calls."

### Phase 5 — Docs
- Update `docs/usage_workflow.md` (currently lines 17-39) to describe the
  merge viewer preview step in each mode.

## Files touched
- `src/collection/store.ts` (schema fields + migration)
- `src/collection/staging.ts` (schema fields)
- `tools/config.ts` (`CardData`/metadata interfaces)
- `src/collection/sort.ts` (new)
- `src/collection/diff.ts` (new)
- `src/ui/merge-view.ts` (new)
- `src/ui/scanner-view.ts` (`confirmStaging` wiring + thread cmc/colors/rarity)
- `src/ui/collection-view.ts` (`confirmMove` wiring)
- `src/styles.css` (`--danger`, diff classes)
- `docs/usage_workflow.md`

## Explicitly out of scope
- Diff/preview for plain check-in/check-out outside the three named entry
  points (e.g. manual one-by-one checkout mentioned in
  `docs/usage_workflow.md` stays as-is).
- Any backend/IndexedDB→Turso concerns (`docs/plans/turso_collection_db.md`
  is a separate, orthogonal plan — `CardEntry` field additions here apply
  regardless of which backend lands first).

## Post-implementation note
This plan predates a later perf refactor: `addCard`/`moveCard`/`moveCards`
(referenced above) were replaced by `commitAdd`/`commitRemove`/`commitMove`
(`store.ts`) and a shared `applyCardDiffs` transaction, using diff logic from
`src/collection/diff.ts` — the same diff computation this doc describes for
the merge viewer's preview is now reused for the actual commit, so preview
and commit are guaranteed to match. Behavior described above is unchanged.
