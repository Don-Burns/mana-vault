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
  4. Collection-view **"Move selected"** (`collection-view.ts:214-250`,
     `handleMoveSelected`) — replaces the `prompt()` folder picker (the code
     comment at line 226 already flags this as a placeholder). Folder
     selection becomes part of the merge viewer instead of a separate prompt.
- **Diff coloring applies only to real collection panels**, not to the
  transient staging list:
  - The staging list (the temporary set of scanned/selected cards) is
    rendered plain — it's just "what you're about to apply," not a diff.
  - Every **real collection** touched by the operation gets a diffed panel:
    Add → destination folder only. Remove → source folder only. Move →
    **both** source and destination folders (each is a real collection
    changing state). Collection-view "Move selected" → both source and
    destination folders.
- **Ordering** is a single control (one ordering method active at a time) that
  applies uniformly to every panel in the viewer (staging list + all
  collection panels), so cards line up row-for-row across panels wherever
  possible.
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
- **Collection-view move**: `handleMoveSelected` (`collection-view.ts:214-250`)
  uses a plain `prompt()` numbered-list dialog to pick a destination folder,
  then calls `collectionStore.moveCards(ids, destFolder.id)`
  (`store.ts:350-357`). Explicitly marked as a placeholder in a code comment.
- **Store data model** (`src/collection/store.ts`):
  - `Folder` (17-24): `id, name, color, sortOrder, createdAt, isDefault?`.
  - `CardEntry` (26-40): `id, folderId, scryfallId, illustrationId, oracleId,
    name, setCode, setName, collectorNumber, quantity, condition, notes,
    dateAdded`. **No CMC/color/rarity fields.**
  - `moveCard`/`moveCards` (301-357) merge into an existing destination entry
    by `scryfallId` if present, otherwise create a new entry; decrement/delete
    the source entry.
- **No existing sort utility for card lists** — `collection-view.ts` renders
  `getCardsByFolder` results in raw index order, no `.sort()` anywhere for
  cards. Folder-level `sortOrder` (`store.ts:184-195`) is unrelated.
- **No existing diff/color-coded UI** — no added/removed CSS classes exist.
  `styles.css:15-16` defines `--success` (green) and `--warning` (orange)
  custom properties; no `--danger`/red variable yet. Closest existing pattern
  is the `.selection-bar` bottom action bar (`collection-view.ts:39-45`), not
  a diff view.
- `docs/usage_workflow.md` currently describes Add/Remove/Move scanner modes
  and check-in/check-out terminology (lines 17-39) without any preview step —
  this doc will need updating once the merge viewer ships.

## Data model changes (Phase 1)
To support CMC/color/rarity sorting, `CardEntry` and `StagedCard` need new
optional fields populated from Scryfall data already available at scan/add
time (Scryfall lookups already happen for matching — no new network calls,
just persist more of the response):
```ts
cmc?: number;
colors?: string[];      // e.g. ["W", "U"], [] for colorless
rarity?: string;        // "common" | "uncommon" | "rare" | "mythic"
```
- Optional fields → existing IndexedDB records without them just sort as
  "unknown" (push to end, stable fallback to name).
- No migration required (IndexedDB is schemaless per-record beyond declared
  indexes); no new index needed since sorting happens in-memory after fetch.

## Ordering methods
A single dropdown, applied identically across every panel in the viewer:
- **Name** (alphabetical) — default, no data dependency.
- **Set + collector number** — existing fields.
- **Quantity** (desc) — existing fields.
- **Mana value (CMC)** — needs Phase 1 field.
- **Color** (WUBRG + colorless/multicolor bucket order) — needs Phase 1 field.
- **Rarity** (common → uncommon → rare → mythic) — needs Phase 1 field.

Implement as one shared `sortCards(cards, method)` utility (new file, e.g.
`src/collection/sort.ts`) consumed by both the merge viewer and (later,
optionally) `collection-view.ts`, since no such utility exists today.

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

### Phase 1 — Data (cards database)
- Add `cmc?`, `colors?`, `rarity?` to `CardEntry` (`store.ts:26-40`) and
  `StagedCard` (`staging.ts:10-24`).
- Populate them wherever Scryfall card data is already fetched (scanner
  match/add path) — no new API calls, existing responses just aren't
  persisted yet.
- No migration needed — optional fields, existing IndexedDB records without
  them sort as "unknown"/fallback to name.

### Phase 2 — Ordering
- `src/collection/sort.ts`: `type SortMethod = "name" | "set" | "quantity" |
  "cmc" | "color" | "rarity"`; `sortCards(cards, method): sorted copy`.
- Unit test covering each method, including mixed/missing optional fields
  (pre-Phase-1 records).
- Wire the ordering dropdown control (shared across all merge-viewer panels)
  — this can be built/tested standalone before the diff/UI phases exist, e.g.
  temporarily wired into `collection-view.ts` card list rendering as a smoke
  test.

### Phase 3 — Diff computation
- Pure function, e.g. `computeDiff(before: CardEntry[], after: CardEntry[]):
  DiffRow[]`, `DiffRow = { card, before: number, after: number }` — used to
  derive add/remove/increase/decrease per row.
- Unit test covering: full add, full remove, increase, decrease, unchanged.

### Phase 4 — UI
- Build `src/ui/merge-view.ts` per "UI shape" above; wire in CSS classes.
- Wire into `confirmStaging` (Add/Remove/Move) and `handleMoveSelected`,
  replacing direct commit / `prompt()` with "open merge viewer → user
  confirms → then commit using existing store calls."

### Phase 5 — Docs
- Update `docs/usage_workflow.md` (currently lines 17-39) to describe the
  merge viewer preview step in each mode.

## Files touched
- `src/collection/store.ts` (schema fields)
- `src/collection/staging.ts` (schema fields)
- `src/collection/sort.ts` (new)
- `src/collection/diff.ts` (new)
- `src/ui/merge-view.ts` (new)
- `src/ui/scanner-view.ts` (`confirmStaging` wiring)
- `src/ui/collection-view.ts` (`handleMoveSelected` wiring)
- `src/styles.css` (`--danger`, diff classes)
- `docs/usage_workflow.md`

## Explicitly out of scope
- Multi-criteria/secondary sort (e.g. "color then name") — single ordering
  method only, per locked decision.
- Diff/preview for plain check-in/check-out outside the three named entry
  points (e.g. manual one-by-one checkout mentioned in
  `docs/usage_workflow.md` stays as-is).
- Any backend/IndexedDB→Turso concerns (`docs/plans/turso_collection_db.md`
  is a separate, orthogonal plan — `CardEntry` field additions here apply
  regardless of which backend lands first).
