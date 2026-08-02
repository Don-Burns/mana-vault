# Hamming Distance Refactor

## Summary

The matcher previously computed Hamming distance with BigInt XOR + Brian
Kernighan bit counting per DB entry.

It now uses 32-bit word popcount on pre-split hash arrays:

- Query hash split once into `high32` and `low32`
- Per entry distance:
  - `popcount32(queryHigh ^ entryHigh)`
  - `+ popcount32(queryLow ^ entryLow)`

This removes per-entry BigInt bit-loop overhead in the hot path.

## What Changed

### `src/matching/hashdb.ts`

- Added cached `Uint32Array` views for each hash space:
  - art: `pHashHighs`, `pHashLows`, `dHashHighs`, `dHashLows`
  - full: `fullPHashHighs`, `fullPHashLows`, `fullDHashHighs`, `fullDHashLows`
- Parser now fills these arrays directly while reading DB entries.
- Added getters for the 32-bit arrays so matcher loops can avoid BigInt work.

### `src/matching/matcher.ts`

- Replaced `hammingDistance64(bigint, bigint)` with `popcount32(number)` SWAR
  implementation.
- Query hashes are split once per search call.
- Match loops use integer XOR + popcount for both pHash and dHash distances.

## Correctness

- Search scoring logic is unchanged:
  - `combined = pDist * 0.6 + dDist * 0.4`
  - thresholding and confidence mapping unchanged
- Zero-hash filtering behavior is unchanged.
- Microbenchmark tool verifies baseline vs optimized hit counts are equal.

## Performance

Measured on this repo with `tools/bench-matcher.ts` (example run,
`--queries=16 --rounds=2 --space=both`):

- ART space: ~100x faster
- FULL space: ~50x faster

Exact numbers vary by CPU/runtime, but the optimization consistently removes the
previous hot-spot.
