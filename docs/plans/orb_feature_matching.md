# Plan (deferred): ORB/Feature-Based Card Matching

## Status
Not started. Written up as an alternative to consider later if the
hash-based approach (`src/matching/hasher.ts`, `hashdb.ts`, `matcher.ts`)
plateaus — e.g. if sleeve-margin handling (contour-based inner-quad
detection) and full-card false-positive fixes still leave too many
low-confidence/wrong matches on real-world photos.

## Current approach (for contrast)
- Each candidate view is downsampled to 32×32 grayscale, then reduced to a
  64-bit pHash (8×8 low-frequency DCT, thresholded against the median) and a
  64-bit dHash (9×8 gradient comparison).
- `HashDB` stores 4 hash pairs per illustration (art + full-card spaces),
  32/48 bytes per entry — the whole DB is a flat binary file, trivially fast
  to brute-force scan (SWAR popcount over ~10-20k entries in microseconds).
- Matching is a single Hamming-distance scan; no per-image geometry or
  descriptor computation beyond the initial hash.
- This is cheap, small, and fast specifically because it throws away almost
  all spatial detail — a 32×32 image retains only coarse structure. That's
  also its ceiling: two different but similarly-composed/dark pieces of art
  can hash close enough together to produce a confident-looking false match
  (this is exactly what happened with the Thalia, Guardian of Thraben test
  fixture — see `docs/plans/` detection work).

## What ORB-based matching would look like
[ORB](https://en.wikipedia.org/wiki/Oriented_FAST_and_rotated_BRIEF)
(Oriented FAST + rotated BRIEF) detects keypoints (corners/blobs) and
computes a 256-bit binary descriptor per keypoint that's invariant to
rotation and reasonably robust to scale/illumination changes. Matching two
images means comparing sets of descriptors (e.g. via a brute-force
Hamming-distance matcher with ratio testing, or an FLANN/LSH index), then
counting geometrically-consistent inlier matches (via `findHomography` +
RANSAC) as the match score.

Rough shape of the change:
1. **Build time** (`tools/` scripts that populate `hash-db.bin` today): for
   each illustration, compute ORB keypoints + descriptors from the Scryfall
   reference image (both art_crop and full card, mirroring the two existing
   hash spaces) and store them instead of/alongside the 64-bit hashes.
2. **Runtime matching**: for each candidate view (`extractCardCandidates`
   already produces these), compute ORB descriptors and match against every
   DB entry's descriptor set, scoring by inlier count after RANSAC homography
   fitting.
3. Everything upstream (`detectCardInMat`, `extractCardCandidates`,
   `identifyCardInMat`'s orchestration) stays the same — this only replaces
   the matching backend behind `findMatches`.

## Trade-offs vs. the current hash approach

| | Hash (pHash/dHash) | ORB features |
|---|---|---|
| DB size per illustration | 32-48 bytes (4 fixed 64-bit ints) | Variable, typically 500-2000+ bytes (dozens to a few hundred 32-byte descriptors, depending on keypoint count) |
| Total DB size (10-20k illustrations × 2 image spaces) | Single-digit MB | Tens to hundreds of MB — likely needs a different storage/loading strategy than the current flat-binary-file-fetched-into-memory approach |
| Match cost per candidate | One Hamming distance scan over all entries (SWAR popcount, microseconds) | Descriptor matching + RANSAC homography per DB entry (or a coarse pre-filter, e.g. bag-of-visual-words / vocabulary tree, before doing per-entry RANSAC) — orders of magnitude more compute per candidate |
| Robustness to partial occlusion / cropping | Poor — a full-card or art-region hash is sensitive to what fraction of the image is actually card content, which is exactly the sleeve-margin/background-bleed problem this doc exists because of | Good — keypoint matching only needs enough distinctive local features to survive, tolerates crops/occlusion/rotation much better structurally |
| Robustness to low-detail/dark art | Poor — very few DCT/gradient features to hash, prone to collisions (the Thalia case) | Better, but not perfect — dark/low-texture art also yields fewer ORB keypoints, though inlier geometric verification (RANSAC) still filters out coincidental matches that a 64-bit hash can't |
| Implementation/runtime complexity | Already built, small, fast | New build pipeline, new runtime matcher, likely a two-stage search (coarse filter + geometric verification) to stay fast at DB scale, new `vendor/opencv/mod.ts` bindings needed (ORB detector/descriptor, `BFMatcher` or `FlannBasedMatcher`, `findHomography`) |
| Browser/worker feasibility | Runs comfortably in a Web Worker today | Needs profiling — ORB detection + matching thousands of DB entries per scan in a browser worker may be too slow without a proper indexing structure (vocabulary tree / LSH), which is itself a meaningful chunk of work |

## Why this is deferred, not adopted now
The concrete failures diagnosed in the current detection work (frame-hugging
false quads, brightness-only nesting heuristic, sleeve margin, full-card
false positives) are all **geometry/segmentation** problems — the hash
matcher was never given a correctly-cropped image to match against. ORB
would improve robustness to *residual* cropping/occlusion error after
geometry is fixed, but it doesn't fix bad geometry, and it comes with a much
larger implementation, storage, and runtime cost. The cheaper fix (correct
the crop) should be tried and measured first; ORB is worth revisiting only if
correctly-cropped candidates still produce too many low-confidence or wrong
matches.

## If/when revisited
1. Confirm the vendored OpenCV.js build has (or can gain) bindings for
   `ORB_create`/`detectAndCompute`, a matcher (`BFMatcher` is simplest to
   start with), and `findHomography` — same pattern as the `adaptiveThreshold`
   binding that had to be added previously.
2. Prototype against the existing fixture set first (`tests/data/input/`) —
   no new photos needed initially, just a different matching backend — to
   get a real feel for per-candidate match latency before committing to a
   DB format change.
3. Decide on a two-stage search early (coarse filter, e.g. a small bag-of-
   visual-words index, before per-entry RANSAC) — brute-force ORB matching
   against every illustration will not scale to the current DB size.
4. Plan a DB format migration (`hashdb.ts` already has v1→v2 precedent for
   adding the full-card hash space) rather than a wholesale replacement, so
   the two matching strategies could coexist/be compared during rollout.
