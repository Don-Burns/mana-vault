# Plan: Remote card image cache (deferred)

## Goal
Avoid re-fetching a card's Scryfall image every time it's displayed, by
caching fetched image bytes locally (IndexedDB) keyed by `scryfallId`.

## Status: deferred
Not implemented. Blocked on the growth concern below — revisit once that's
answered.

## Open concern: unbounded growth
Every distinct `scryfallId` ever viewed would get its own cached blob with no
eviction. A large/varied collection (or repeated scanning across many cards)
could grow this cache indefinitely with no TTL, size cap, or LRU eviction.
Needs a bound before this is safe to ship, e.g.:
- Cap total cache size / entry count, evict oldest (LRU) past the cap.
- And/or TTL per entry.
- And/or only cache cards actually in the user's collection (bounded by
  collection size) rather than every card ever looked up (e.g. staging
  search previews of cards never added).

## Design sketch (for when unblocked)
- Guard all IndexedDB access with `typeof indexedDB === "undefined"` so it
  no-ops in the Deno test runtime and any environment lacking it.
- `getCardImageUrl`'s remote branch: check cache → hit returns
  `URL.createObjectURL(blob)`; miss does an actual `fetch` (not just
  building a URL string), stores the blob, returns the object URL; fetch
  failure falls back to today's plain remote URL string.
- No `URL.revokeObjectURL` cleanup initially — add if profiling shows
  memory growth from object URLs.
- Test: fake in-memory `globalThis.indexedDB` stub in
  `card-image.test.ts` to verify cache hit skips the second `fetch`.

## Note
This is separate from `docs/plans/card_art_images.md`, which prebuilds a
single small thumbnail blob (`thumbs.bin`) at build time for a different
purpose (toast/search/merge-view thumbnails). This plan is about the
full-size remote fallback path in `src/collection/card-image.ts`.
