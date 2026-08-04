# Scan Dedup (Same-Card-In-View Suppression)

## Summary

Previously, when a card just sat in view of the camera, the auto-capture
stability check (8 stable frames) plus the 2s capture cooldown still fired
repeatedly — identifying and staging the same physical card over and over
every couple of seconds, silently inflating its staged quantity.

The scanner now suppresses re-adding a card if it matches the last card added
to staging, unless the camera has seen no card at all for 500ms in between
(card removed and re-shown = a deliberate new scan).

## What Changed

### `src/ui/scan-dedup.ts` (new)

`ScanDedupTracker` — a small, pure, DOM/camera-free class:

- `onFound()` — call when a card is detected in the current frame; resets the
  "empty" timer.
- `onNotFound(now)` — call when no card is detected; starts the empty timer on
  the first miss, and latches `hadGap = true` once the timer reaches the
  configured gap (default 500ms).
- `shouldSkip(candidateScryfallId, lastStagedScryfallId)` — true if the
  candidate matches the last staged printing and no gap has occurred yet.
- `recordCapture()` — call after a card is actually staged; re-arms the
  duplicate check for the next capture.

### `src/ui/scanner-view.ts`

- `processFrame` calls `dedup.onFound()` / `dedup.onNotFound(Date.now())`
  alongside the existing corner-stability tracking (reuses the same
  per-frame `result.found` signal, no extra detection work).
- `handleCapture` compares the resolved default printing's `scryfallId`
  against `staging.getAll().at(-1)?.scryfallId` via `dedup.shouldSkip(...)`.
  If it's a duplicate, the match splash/status still updates (so the user
  sees the scan happened) but `staging.add()` is skipped. Otherwise the card
  is staged as before and `dedup.recordCapture()` is called.
- Manual capture (button click) goes through the same `handleCapture` path,
  so it is also deduped — this matches "identical card in view" semantics
  rather than treating manual clicks as a forced override.

## Why scryfallId, not illustrationId

Dedup compares on the exact printing (`scryfallId`) that would be staged,
not just the artwork (`illustrationId`). This matches how `StagingList.add()`
itself merges duplicates (by `scryfallId`), so "don't re-add" and "would have
merged anyway" use the same identity.

## Correctness

- First scan of a session always proceeds (`lastStagedScryfallId` is
  `undefined`, never equals any candidate).
- A different card is never suppressed, regardless of gap state.
- Detector flicker (found → not found → found, all within the gap window)
  resets the empty timer on every `onFound()`, so a shaky detection loop
  cannot accidentally accumulate a gap and let a duplicate through.
- Covered by `tests/scan_dedup_test.ts` (tracker logic) and
  `tests/staging_test.ts` (merge-by-`scryfallId` behavior it relies on).
