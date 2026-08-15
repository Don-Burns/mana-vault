# Plan: Bulk-add UI (paste a decklist) (deferred)

## Goal
Let a user add many printings to a folder in one action — paste a decklist
and have every line resolved and staged — instead of today's one-at-a-time
search → pick-printing → confirm flow (`e2e/printing-picker.spec.ts`).

## Status: deferred
Not implemented. Motivated by the "500 unique printings" collection-move
perf test, which currently seeds via `collectionStore.commitAdd()` directly
through a test-only `window.__collectionStore` hook in `src/main.ts` (see
`e2e/collection-move-performance.spec.ts`) rather than any real UI, because
no bulk entry point exists yet.

## Open concern: paste syntax undecided
Needs a decision before implementing:
- Quantity prefix (`4 Lightning Bolt`) vs. suffix (`Lightning Bolt x4`) vs.
  both accepted.
- Set-code hints (`4 Lightning Bolt (M11)`) — honored to pick a specific
  printing, or ignored (always auto-pick via `defaultPrintingFor`)?
- One name per line only, or also comma/semicolon-separated?

## Design sketch (for when unblocked)
- New entry point next to today's `#staging-search-input` (e.g. a "Paste
  list" button) opening a `<textarea>` for a full decklist.
- Parser: split input into lines → `{ qty, name }` pairs.
- Resolve each name against local `metadata.json` reusing existing lookups
  in `src/collection/card-search.ts`:
  - `groupedCardSearch` (or a direct name match) to find the card.
  - `defaultPrintingFor()` to auto-pick a printing — no per-card picker
    UI in the common case.
  - Names with no match collected into a "not found" list shown to the
    user instead of silently dropped.
- Resolved lines become `StagedCard`s pushed into `StagingList`
  (`src/collection/staging.ts`) as one batch, same shape the one-at-a-time
  flow already produces — no new staging data model needed.
- Reuses the existing merge-view review step (`src/ui/merge-view.ts`)
  before committing, so bulk add still gets a diff preview like every other
  add/remove/move flow.

## Note
Once this exists, `e2e/collection-move-performance.spec.ts` should switch
its seeding step from the `window.__collectionStore` test hook to driving
this real UI, and that hook can likely be removed.
