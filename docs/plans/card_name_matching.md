# Plan: Card Name Matching (OCR + Manual Entry)

## Goal
Add two complementary, non-camera-hash paths to identify/verify cards:
1. **OCR name verification (B):** read the printed card title from the scan and fuse it with the art-hash result (confidence-dependent).
2. **Manual name entry (fallback):** let users type a card name to add to the staging list when detection fails.

## Background (current architecture)
- Detection pipeline warps a card to a flat **745×1040** upright rect (`src/detection/pipeline.ts:423`) and extracts an art crop by frame type (`extractArtRegion`, `pipeline.ts:476`; regions in `src/detection/frame-classifier.ts:19`).
- Both portrait orientations are hashed; best art match wins (`matchArtOrientations`, `src/detection/identify.ts:57`).
- `findMatches` returns top-N by Hamming distance (`src/matching/matcher.ts:28`); accept threshold is 20% art confidence.
- `metadata.json` maps `illustration_id → { name, printings[] }` (`tools/config.ts:53`); English is the primary name (`tools/build-hashdb.ts:87`).
- Scanner UI reads `metadata.illustrations[id].name` and builds staging items (`src/ui/scanner-view.ts:229,261,281`).
- OpenCV.js build (`vendor/opencv/opencv.mjs`) has `dnn`/EAST (text **detection**) but **no** `cv.text`/`OCRTesseract` (no text **recognition**). Hence Tesseract.js for recognition.

## Engine decision
- **OpenCV** for title-strip isolation + preprocessing (uses existing dep).
- **Tesseract.js** (WASM) for character recognition — offline, lazy-loaded, SW-cached like OpenCV WASM / hash DB (`README.md:286`).
- Recognition is a **closed-vocabulary** problem: OCR output is fuzzy-matched only against the top-N candidate names, so imperfect OCR is tolerable.

## Role of the name: confidence-dependent fusion
- Art-hash runs first (fast). OCR runs on the **winning orientation's** title strip only (avoid 4× cost).
- Fusion rules:
  - Art high + name agrees → boost confidence.
  - Art candidates tie / same-art → name breaks the tie (disambiguate).
  - Art low (<20%) but name reads strongly → rescue (accept above a name-confidence floor).

---

## Feature B — OCR name verification

### Phase 1 — Title-strip extraction (pure OpenCV)
- Add `TITLE_REGIONS: Record<FrameType, [l,t,r,b]>` beside `ART_REGIONS` in `frame-classifier.ts` (top title band; per-frame: modern ~4–11% height, old-border differs, borderless overlay).
- Add `extractTitleRegion(cv, cardMat): ImageData` in `pipeline.ts`, mirroring `extractArtRegion`.
- Emit the title crop for the **best orientation only** — worker computes it after art match. Add optional `titleRegion?: ImageData` to `PipelineResult` and the worker result message.

### Phase 2 — Preprocessing (pure OpenCV)
- New `src/matching/text-prep.ts`: grayscale → upscale 2–3× → Otsu/adaptive threshold → optional deskew → clean binary title image.

### Phase 3 — Recognition (Tesseract.js)
- Add `tesseract.js` dependency.
- New `src/matching/ocr.ts`: lazily-init a Tesseract worker with a restricted whitelist (letters, digits, apostrophe, comma, hyphen, space). Return raw text + confidence.
- Lazy-load and SW-cache the English `traineddata` (~3–4 MB) in its own cache, like the hash DB.

### Phase 4 — Name fusion + re-ranking (pure logic)
- New `src/matching/name-match.ts`: normalized fuzzy distance (Levenshtein / Jaro-Winkler) between OCR text and candidate names only.
- Extend `matchArtOrientations` (`identify.ts:57`) to return **top-N** with names (join via metadata).
- Add a fuser producing combined confidence per the rules above.
- Extend `MatchResult` (`matcher.ts:10`) with optional `nameConfidence`, `matchedVia: "art" | "art+name" | "name"`.

### Phase 5 — UI + wiring
- `scanner-view.ts` (~229/281): show how it matched and the fused confidence; generalize the 20% gate to the fused score.

### Phase 6 — Tests
- Extend `tests/` with fixtures from `tests/data/input/`: title extraction, preprocessing, fuzzy name resolution, end-to-end fusion.

---

## Manual name entry (detection fallback)
Alternative path to add cards to the staging list without detection.

- **UI:** add a "Type card name" control in the scanner view near the staging list (`scanner-view.ts`). Text input with autocomplete/suggestions.
- **Lookup:** in-memory search over `metadata.illustrations` names (case/diacritic-insensitive substring + fuzzy rank). Data already loaded — no new fetch/DB change. Optionally build a lightweight name index at metadata load.
- **Disambiguation:** on selecting a name, resolve to its `illustration_id`; if multiple printings, reuse the existing printing/version picker used by staging.
- **Staging:** construct the same staging item shape used by the matched path (`scanner-view.ts:261`), with `matchedVia: "manual"`.
- **Reuse:** Feature B's `name-match.ts` fuzzy matcher powers both OCR fusion and manual-entry ranking.

---

## Out of scope / risks
- **Non-English titles:** metadata stores English as primary (`build-hashdb.ts:87`); OCR-ing a foreign title against English names won't match. Storing per-language names is a **follow-up** metadata change.
- **Old-border / stylized / foil titles** are hardest for OCR; closed-vocabulary fuzzy match mitigates.
- **Bundle size:** Tesseract WASM + traineddata add ~a few MB; must be lazy-loaded and SW-cached, excluded from install precache.
- **Per-scan latency:** OCR is ~hundreds of ms; run on captured still only, not live preview.

## New/changed files (summary)
- New: `src/matching/text-prep.ts`, `src/matching/ocr.ts`, `src/matching/name-match.ts`, `docs/plans/card_name_matching.md`.
- Changed: `frame-classifier.ts` (TITLE_REGIONS), `pipeline.ts` (extractTitleRegion + PipelineResult), `workers/detection-worker.ts` (emit title crop), `identify.ts` (top-N + fusion), `matcher.ts` (MatchResult fields), `scanner-view.ts` (UI: fused display + manual entry), `sw.ts` (cache traineddata), dependency manifest (`deno.json`) for `tesseract.js`.
