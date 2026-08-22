# Plan: Card Detection on Non-White Surfaces

## Status: partially implemented
The symmetric brightness-difference nesting and frame-edge rejection
described below (originally "Step 1" groundwork) shipped as part of the
sleeve/mat detection work — see `src/detection/pipeline.ts`
(`collectCardQuads`'s `touchesFrameEdge` check, `selectCardQuad`'s
`Math.abs(other.mean - c.mean)` nesting check) and
`tests/card_detection_test.ts` (`THALIA`, `VILLAINOUS_WEALTH_MAT`,
`VILLAINOUS_WEALTH_WHITE`, `CONDUIT_SLEEVED` fixtures, added as this plan's
"Step 0").

Results against the new fixtures:
- `thalia_guadian_of_thraben_on_mat.jpg` (card on a patterned mat, no
  sleeve): **passes**.
- `villainous_wealth_sleeved_on_white.jpg` (sleeved, on a plain white
  surface): **passes**.
- `villainous_wealth_sleeved_on_mat.jpg` and
  `conduit_of_worlds_sleeved_on_mat.jpg` (card/sleeve on a dark, textured
  mat): **still fail** — the printed card's own border has essentially no
  brightness contrast against the mat, so no grayscale-only pass (Canny,
  Otsu, adaptive threshold) can find its true boundary; only the brighter
  art region registers as a contour and gets mistaken for the whole card.
  This is exactly the "same brightness, different hue" failure mode this
  plan's Step 2 (color-distance pass) was written to address, and remains
  **unimplemented** — it's the next thing to pick up here.

## Goal
Improve `detectCardInMat` (`src/detection/pipeline.ts`) so it can find a card
photographed directly on a non-white, non-paper surface (wood desk, dark
playmat, patterned mousepad) — a scenario the current test fixtures don't
actually cover, and the current heuristics aren't designed for.

## Background (current architecture)
- `detectCardInMat` (`pipeline.ts:47`) converts the source frame to grayscale
  in the first step and every downstream signal — Canny, Otsu threshold,
  adaptive threshold (`pipeline.ts:53-166`) — only ever sees luminance. Color
  (hue/saturation) is discarded before detection starts.
- `selectCardQuad` (`pipeline.ts:268`) prefers the smallest card-shaped quad
  nested inside a larger enclosing quad whose mean intensity differs by more
  than `BACKING_BRIGHTNESS_MARGIN = 25` (now checked in either direction,
  brighter or darker — previously brighter-only), and falls back to "largest
  card-shaped quad" otherwise. Frame-edge-hugging quads (e.g. the camera
  frame itself) are now rejected outright before this step.
- All existing "real-world" fixtures in `tests/data/input/` that pass today
  (`webcam_pic_noisy*.jpg`) have the card resting on a **sheet of white paper**
  placed on a dark desk — the paper-nesting heuristic is what's actually
  finding the card in every one of them. `thalia_guadian_of_thraben_on_mat.jpg`
  and `villainous_wealth_sleeved_on_white.jpg` now also cover a card directly
  on a patterned mat / plain white surface with no paper involved.
  `villainous_wealth_sleeved_on_mat.jpg` and
  `conduit_of_worlds_sleeved_on_mat.jpg` cover a card directly on a **dark**
  textured surface, and remain unsolved (see Status above).
- Three candidate-collection passes currently feed `collectCardQuads`
  (`pipeline.ts`, factored out into `findCardQuadCandidates` so it can also
  run on an already-warped card to find a nested sleeve edge — see
  `docs/plans/` sleeve detection work): Canny edges, Otsu threshold, and
  adaptive threshold. All three operate on the same grayscale `blurred` Mat.

## Why CLAHE alone is insufficient
CLAHE (Contrast Limited Adaptive Histogram Equalization) is a preprocessing
step, not a segmentation method: it redistributes intensity within local
tiles to recover contrast compressed by unevenness in *lighting* (shadows,
glare, a dim room). Applied to `gray`/`blurred` before the three existing
passes, it would help all of them when the failure mode is global
illumination. It does **not** help when the card and surface are genuinely
close in both brightness *and* hue (e.g. a black-bordered card on a black
desk) — there is no contrast to recover, because color is discarded before
CLAHE ever sees it. On a **textured** surface (wood grain, patterned mat),
CLAHE can also amplify that texture's local contrast, flooding Canny/adaptive
threshold with spurious edges — a real regression risk, not just a
non-improvement.

The actual bottleneck is that everything currently runs on grayscale only.
A black card sleeve and a brown wood desk can be near-identical in
brightness while obviously different in hue/saturation — information
discarded at `cvtColor(..., cv.COLOR_RGBA2GRAY)` before detection starts.
`villainous_wealth_sleeved_on_mat.jpg` / `conduit_of_worlds_sleeved_on_mat.jpg`
are now live, checked-in examples of exactly this failure mode.

## Plan (incremental, cheapest/lowest-risk first)

### Step 0 — Ground-truth fixtures — done
`thalia_guadian_of_thraben_on_mat.jpg`,
`villainous_wealth_sleeved_on_mat.jpg`,
`villainous_wealth_sleeved_on_white.jpg`, and
`conduit_of_worlds_sleeved_on_mat.jpg` are checked in and wired into
`tests/card_detection_test.ts`'s `FIXTURES` array. Two of the four pass
today; the remaining two are the concrete regression target for Steps 1-2
below.

### Step 1 — CLAHE preprocessing (small effort, low-medium risk)
- Apply `cv.CLAHE` (or manual tile-histogram-equalization if the vendored
  OpenCV.js build lacks a bound `CLAHE` class — needs checking, same as the
  `adaptiveThreshold` binding that had to be added to `vendor/opencv/mod.ts`
  last time) to `gray` before `GaussianBlur`, feeding all three existing
  passes uniformly.
- Validate against `villainous_wealth_sleeved_on_mat.jpg` /
  `conduit_of_worlds_sleeved_on_mat.jpg` **and** the full existing suite —
  main regression risk is new spurious contours on textured backgrounds
  outranking the real card in `selectCardQuad`.
- If the vendored OpenCV.js build has no CLAHE binding, this step also
  requires extending `vendor/opencv/mod.ts`'s `Cv` interface (precedent:
  `adaptiveThreshold` was added there for the Toshiro fix).
- Expected to help only partially: both failing fixtures are close in *hue*
  as well as brightness in places, which CLAHE cannot recover.

### Step 2 — Color-distance candidate pass (medium effort/risk)
A 4th `collectCardQuads` source, following the same additive pattern as the
adaptive-threshold pass:
- Convert the source frame to HSV or Lab (once, alongside the existing
  grayscale conversion — color data must survive past the first `cvtColor`
  call, unlike today).
- Sample the four image corners as a background-color estimate (assumes the
  corners are usually background, not card — fails if the camera is zoomed in
  tight on the card; check against `villainous_wealth_sleeved_on_mat.jpg` /
  `conduit_of_worlds_sleeved_on_mat.jpg` to confirm this holds for those
  photos specifically).
- Threshold pixels by color distance (hue/saturation-aware, not just
  brightness) from that estimate; morphologically close; find contours; feed
  through the existing `collectCardQuads` → `isCardShaped` → `selectCardQuad`
  pipeline unchanged.
- This directly targets same-brightness/different-hue backgrounds, which no
  grayscale-only pass can structurally solve, and is the most likely fix for
  the two still-failing fixtures.

### Step 3 — Learned/statistical background model (only if 1+2 plateau)
E.g. GrabCut-style iterative background/foreground segmentation instead of a
hand-tuned corner sample. Larger effort, higher risk, not started unless
Steps 1-2 are validated against the checked-in fixtures and still
insufficient.

## Trade-offs

| Step | Effort | Risk | Solves |
|---|---|---|---|
| 0. New fixtures | small (needs real photos) | none | done — validates everything below |
| 1. CLAHE | small | low-medium (textured backgrounds may get noisier; may need a new `Cv` binding) | lighting-only contrast loss |
| 2. Color-distance pass | medium | medium (corner-sampling assumption; first time color survives past the initial grayscale conversion) | same-brightness/different-hue backgrounds — the two still-failing fixtures |
| 3. Learned background model | large | high | whatever 1+2 can't |

## Out of scope / risks
- CLAHE tile-grid size/clip-limit are untuned; will need a small parameter
  sweep against the checked-in fixtures, same as the `blockSize`/`C` sweep
  done for adaptive threshold.
- Color-distance corner-sampling assumes background visibility at the
  frame's edges; a tightly-cropped photo breaks the assumption and would
  need a different background estimate (e.g. a border ring instead of just
  four corner points) — flagged here, not solved.
- `selectCardQuad`'s intensity-difference nesting heuristic
  (`BACKING_BRIGHTNESS_MARGIN`) now checks either direction (brighter or
  darker backing), which is what let `thalia_guadian_of_thraben_on_mat.jpg`
  and `villainous_wealth_sleeved_on_white.jpg` pass, but it's still
  fundamentally brightness-based; it does not and cannot help when the card
  and its backing are close in brightness too (the two still-failing
  fixtures) — that needs Step 2's color-distance signal instead.

## New/changed files (summary)
- New: fixtures in `tests/data/input/` (Step 0, done), this doc.
- Changed (done, Step 1 groundwork): `tests/card_detection_test.ts` (new
  `Fixture` entries), `src/detection/pipeline.ts` (frame-edge rejection,
  symmetric brightness-diff nesting, `findCardQuadCandidates` factored out).
- Changed (not done, Steps 1-2 proper): `src/detection/pipeline.ts` (CLAHE
  preprocessing, color-distance candidate pass), possibly
  `vendor/opencv/mod.ts` (new `Cv` bindings, precedent: `adaptiveThreshold`).
</content>
