# agents.md — Project Context for AI Agents

> This file exists to help AI agents get up to speed with the project quickly.
> Read this before exploring the codebase.

## What This Project Is

An offline-first PWA for scanning Magic: The Gathering cards with a phone camera and managing them in a local collection organized by folders. Cards are identified by matching their artwork against a pre-built perceptual hash database — no network needed at scan time.

**Stack**: Deno + Vite + Vanilla TypeScript + OpenCV.js (WASM) + IndexedDB

## Quick Reference

### Documentation

Documentation around high-level behaviour, architecture, and design decisions is in the `docs/` folder.

Features yet to be implemented are tracked in `docs/plans/` (with some design notes).

### Commands

```sh
deno task dev          # Vite dev server on :3000 (hot reload, LAN accessible; SW is a no-op pass-through)
deno task build        # Production build → dist/
deno task preview      # Serve the production build (use this to test real SW caching/offline)

deno task db:download  # Download Scryfall bulk card data → data/bulk/
deno task db:art       # Download art crop images → data/art/ (hours, resumable)
deno task db:build     # Generate hash-db.bin + metadata.json → public/db/
deno task opencv:download  # Download & patch OpenCV.js 4.13.0 → vendor/opencv/opencv.cjs
deno task test         # Run tests (deno test -A)
```

### Build Output

```
dist/
  index.html
  registerSW.js                      # SW registration shim (injected by vite-plugin-pwa)
  sw.js                              # Service worker (fixed name, not hashed)
  assets/index-[hash].js             # App bundle (~32 KB)
  assets/index-[hash].css            # Styles (~7 KB)
  assets/detection-worker-[hash].js  # OpenCV worker (~5 KB)
  assets/mod-[hash].js               # OpenCV WASM (~10.8 MB, cached lazily by SW at runtime)
```

### Key Directories

| Path             | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `src/`           | PWA source (Vite bundles this)                                 |
| `src/workers/`   | Web Worker for OpenCV (runs off main thread)                   |
| `tools/`         | Deno CLI scripts for building the hash database                |
| `vendor/opencv/` | Vendored OpenCV.js 4.13.0 (WASM embedded, downloaded via task) |
| `public/db/`     | Generated hash DB + metadata (gitignored, built by tools)      |
| `data/`          | Downloaded Scryfall data (gitignored, large)                   |

## Architecture at a Glance

```
[Camera] → [Web Worker: OpenCV contour/warp/crop ×4 orientations] → [pHash+dHash] → [Hamming search] → [Staging] → [IndexedDB]
```

The worker returns the art crop for **all four 90° rotations** of the detected
card; the main thread hashes each and keeps the best DB match. This makes
recognition robust to card/photo orientation (see "Orientation Handling").

Two separate concerns:
1. **Build pipeline** (`tools/`): Deno scripts that download from Scryfall and produce a binary hash DB
2. **PWA** (`src/`): Browser app that uses that DB to match scanned cards offline

## Critical Knowledge

### The Hash Algorithms Live in a Shared Module

The pHash and dHash computation lives in **one place**: `src/matching/hash-core.ts`.
It is imported by both:
- `tools/build-hashdb.ts` — uses `npm:sharp` for 32x32 grayscale resizing, then calls the shared hash functions
- `src/matching/hasher.ts` — uses bilinear interpolation on browser `ImageData` for 32x32 grayscale resizing, then calls the shared hash functions

The image preprocessing (resizing to 32x32 grayscale) differs between build and client because
`sharp` (native C++) isn't available in the browser and `ImageData` isn't available in the build tool.
The core hash math (DCT for pHash, gradient comparison for dHash) is identical.

### OpenCV.js Vendoring

OpenCV.js is **vendored** (not installed from npm). The setup:

1. `deno task opencv:download` runs `tools/download-opencv.ts`, which:
   - Downloads the official OpenCV 4.13.0 release zip from GitHub
   - Extracts `js/bin/opencv.js` (the UMD build with base64-embedded WASM)
   - Applies 3 patches for Deno compatibility (Emscripten's environment detection mistakes Deno for Node.js due to Deno's `process` shim)
   - Writes the patched file to `vendor/opencv/opencv.cjs`

2. `vendor/opencv/mod.ts` is the ES module wrapper that:
   - Imports the CJS file (`.cjs` extension ensures Deno loads it as CommonJS)
   - Waits for `onRuntimeInitialized` via top-level await
   - Re-exports the ready-to-use `cv` object as the default export
   - **Exports TypeScript types** (`Cv`, `Mat`, `MatVector`, `Rect`, `Size`) describing the subset of the OpenCV.js API this project uses

3. Both the browser worker (`src/workers/detection-worker.ts`) and Deno tests import from `vendor/opencv/mod.ts`

The `.cjs` file is ~10.5 MB and gitignored. Run `deno task opencv:download` after cloning.

### OpenCV.js Types

OpenCV.js ships **no** type declarations. The `mirada` npm package provides
typings, but they model the C++-style OpenCV API and don't cover OpenCV.js
runtime specifics we depend on (`.delete()`, `.intAt()`, typed-array `.data`,
constructable `cv.Mat`/`cv.Size`/`cv.Rect`, integer enum constants, etc.).

So `vendor/opencv/mod.ts` declares its own focused, accurate `Cv`/`Mat`/
`MatVector`/`Rect`/`Size` interfaces covering exactly the API surface this
project uses, and casts the runtime `cv` object to `Cv`. **There is no `any` in
the OpenCV-facing code** — `pipeline.ts`, `identify.ts`, `detection-worker.ts`,
and the tests all use these types. When you add a new OpenCV call, add its
signature/constant to the `Cv` interface in `mod.ts` rather than reaching for
`any`.

### OpenCV Memory Management

OpenCV.js uses manual memory management (WASM heap). Every `cv.Mat` must be `.delete()`-ed or you leak memory. The detection pipeline (`src/detection/pipeline.ts`) is careful about this with `try/finally` blocks. If you add new Mat operations, always delete them.

**Critical: `clone()` vs `copyTo()` for ROI Mats.** In OpenCV.js, `mat.roi(rect)` creates a non-contiguous Mat that shares the parent's row stride. `clone()` preserves this non-contiguous layout — the resulting Mat has the parent's step size, and `mat.data` reads garbled bytes across row boundaries. Always use `copyTo()` to create truly contiguous copies of ROIs. `pipeline.ts` and `matToImageData` both handle this.

### Orientation Handling

The detector locates a card-shaped quad and warps it to an upright 745×1040
rectangle, but **cannot know which of the four sides is the top** — the card
may be photographed rotated, or the source JPEG may carry an unapplied EXIF
orientation. The perceptual-hash matcher is **not** rotation-invariant, so
orientation must be resolved.

Rather than guessing, the pipeline produces the art crop for **all four 90°
rotations** and the matcher keeps whichever best matches the DB:

- `extractArtRegionsAllOrientations(cv, cardMat)` (pipeline.ts) → 4 `ImageData`
  crops indexed `[0°, 90°, 180°, 270°]` (clockwise quarter-turns).
- The worker returns these as `artRegions: ImageData[]` (replacing the old
  single `artRegion`).
- `matchArtOrientations(db, artRegions)` (identify.ts) hashes each and returns
  the best `{ match, orientation }`. `matchArtOrientationsInSubset(...)` is the
  folder-scoped variant for scan-to-select.
- `identifyCardInMat(cv, src, db)` (identify.ts) runs the whole thing end-to-end
  from a source Mat — used by tests and any caller where OpenCV + the DB coexist.

This is why the full-pipeline tests can feed **raw** image files (each fixture
in a different orientation) without rotating anything in test code.

### Binary Hash DB Format

```
Header (16 bytes):
  [0..3]   "MTGH"        (magic, ASCII)
  [4..5]   version        (uint16 BE, currently 1)
  [6..9]   entry_count    (uint32 BE)
  [10..11]  hash_size      (uint16 BE, currently 8 = 64 bits)
  [12..15]  reserved       (zeros)

Per entry (32 bytes):
  [0..15]   illustration_id  (UUID hex-decoded to 16 raw bytes)
  [16..23]  pHash            (uint64 BE)
  [24..31]  dHash            (uint64 BE)
```

Both `tools/build-hashdb.ts` (writer) and `src/matching/hashdb.ts` (reader) must agree on this format.

### View Pattern

UI views are factory functions returning `{ el: HTMLElement, init: () => void, destroy: () => void }`. The `App` class in `main.ts` calls `destroy()` on the old view and `init()` on the new one when navigating. Resources (camera, workers) must be cleaned up in `destroy()`.

### IndexedDB Schema

Two object stores:
- **`folders`**: keyPath `id`. Indexes: `sortOrder`, `name`. Has a permanent "Unsorted" default folder (`isDefault: true`).
- **`cards`**: keyPath `id`. Indexes: `folderId`, `scryfallId`, `illustrationId`, `oracleId`, `name`, compound `[folderId, scryfallId]`. Each card belongs to exactly one folder. Moving transfers quantity; same printing in same folder merges.

The singleton `collectionStore` in `src/collection/store.ts` must have `.open()` called before any operations (done in `main.ts` boot).

### Deno + Vite Integration

- Vite runs via `deno run -A npm:vite` — Deno's Node compat layer
- `deno.json` has `"nodeModulesDir": "auto"` so npm packages resolve for Vite's bundler
- OpenCV.js is vendored in `vendor/opencv/` (not from npm) — see "OpenCV.js Vendoring" section above
- The `tools/` scripts use `/// <reference lib="deno.ns" />` because `deno.json` compilerOptions target DOM (for the PWA source)
- The service worker is built and served by **`vite-plugin-pwa`** in `injectManifest` mode (see "Service Worker" below)
- COOP/COEP headers are set in dev server for SharedArrayBuffer compatibility

### Service Worker

`src/sw.ts` is a hand-written service worker (custom caching strategies), built
via `vite-plugin-pwa` in `injectManifest` mode. Key points:

- **It works in dev too.** `devOptions.enabled: true` serves the worker from the
  dev server (at `dev-sw.js?dev-sw`) and `injectRegister: "auto"` injects the
  registration script — so no SW code is needed in `main.ts`.
- **Dev is a transparent pass-through.** In dev, `vite-plugin-pwa` replaces
  `self.__WB_MANIFEST` with `[]`; `sw.ts` detects this (`IS_DEV`) and the fetch
  handler returns immediately, intercepting nothing. This is essential —
  caching Vite's on-the-fly transformed modules / HMR / OpenCV WASM would serve
  stale/broken content and break the app (notably: the OpenCV worker fails to
  init and detection silently returns "no card"). **Never cache dev assets.**
- **Prod precache excludes the big stuff.** The OpenCV bundle (`mod-*.js`, ~11 MB)
  and `db/**` (~15 MB) are `globIgnores`d — they're cached lazily at runtime by
  the SW's own cache-first rules, not precached at install (which also keeps the
  build under workbox's 2 MiB-per-asset limit).
- **To test real caching/offline behaviour**, you must use a production build:
  `deno task build && deno task preview` (dev can't test caching by design).

### Scryfall Data Model

- `illustration_id`: shared across reprints with the same art (this is what we hash)
- `oracle_id`: logical card identity across all printings/languages
- `scryfall_id` (just `id` in their API): unique per exact printing
- One illustration can have many printings. The metadata JSON maps `illustration_id → {name, oracle_id, printings[]}`

## File-by-File Summary

### src/

| File                            | Lines | What It Does                                                                                                                                                                                           |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main.ts`                       | 74    | Boot: open IndexedDB, create App with view routing (SW auto-registered by vite-plugin-pwa)                                                                                                             |
| `styles.css`                    | 549   | All CSS. Dark theme via custom properties. Nav forced to bottom with `order: 1`. Overlay canvas uses `object-fit: cover` to align with the `cover` video feed                                          |
| `sw.ts`                         | ~150  | Hand-written service worker built via vite-plugin-pwa (injectManifest). Transparent pass-through in dev; cache-first WASM/DB + stale-while-revalidate assets in prod                                   |
| `camera/capture.ts`             | 139   | Camera class wrapping getUserMedia. Frame handler loop via rAF                                                                                                                                         |
| `detection/detector.ts`         | ~125  | Main thread ↔ Worker bridge. Async `detect(ImageData)` → `DetectionResult` (found, corners, candidates, cardImage, artRegions[])                                                                       |
| `detection/pipeline.ts`         | ~600  | Core detection: two-source contour detection (Canny + Otsu), nested-quad selection, perspective warp, art extraction, all-4-orientation art crops. Typed with `Cv`/`Mat`. Shared by worker and tests   |
| `detection/identify.ts`         | ~150  | Orientation resolution + matching orchestration: `matchArtOrientations`, `matchArtOrientationsInSubset`, `identifyCardInMat`. Keeps OpenCV work separate from pure hash-matching                       |
| `detection/frame-classifier.ts` | ~90   | Classify card frame type by border thickness. Exports `ART_REGIONS` crop ratios                                                                                                                        |
| `workers/detection-worker.ts`   | ~110  | Thin wrapper: loads OpenCV, converts ImageData→Mat, delegates to pipeline.ts, returns candidates + 4 orientation art crops                                                                             |
| `matching/hasher.ts`            | ~65   | Client-side ImageData → 32×32 grayscale (area-averaged) → hash-core.ts                                                                                                                                 |
| `matching/hash-core.ts`         | 88    | Shared pHash (DCT) + dHash (gradient) algorithms. Used by both client and build tool                                                                                                                   |
| `matching/hashdb.ts`            | 159   | Parse binary hash DB into BigUint64Array. Private constructor, use `HashDB.load()`                                                                                                                     |
| `matching/matcher.ts`           | 145   | Hamming distance brute-force search. 60/40 pHash/dHash weighting. Confidence via exp decay                                                                                                             |
| `collection/store.ts`           | 423   | IndexedDB singleton. Folders + cards CRUD, move with quantity split/merge, export/import                                                                                                               |
| `collection/staging.ts`         | 147   | In-memory staging list with change notification. Deduplicates by scryfallId                                                                                                                            |
| `collection/export.ts`          | 129   | JSON/CSV export, JSON import. Import is destructive (clears first)                                                                                                                                     |
| `ui/scanner-view.ts`            | ~490  | Camera + detection + matching + staging. Auto-capture after 15 stable frames. Draws green box on detection + yellow candidate boxes. Enforces 20% min confidence (below → red status text, not staged) |
| `ui/collection-view.ts`         | ~440  | Folder list + card list + manual select + scan-to-select (orientation-robust) + move flow                                                                                                              |

### tools/

| File                 | Lines | What It Does                                                                                          |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| `config.ts`          | 69    | Shared paths, types, constants (rate limit, hash size, Scryfall URL)                                  |
| `download-bulk.ts`   | 169   | Fetch Scryfall bulk JSON, extract fields, handle DFCs, write cards.json                               |
| `download-art.ts`    | 177   | Download art_crop JPEGs per illustration_id. Rate-limited, resumable via .progress.json               |
| `build-hashdb.ts`    | 230   | Compute hashes with sharp (imports hash-core.ts), write binary DB + metadata JSON, copy to public/db/ |
| `download-opencv.ts` | ~80   | Download OpenCV.js 4.13.0 from GitHub, patch for Deno, write to vendor/opencv/opencv.cjs              |

## Detection Pipeline Details

```
Camera frame (1280×720 RGBA)
  → Grayscale
  → Gaussian blur (5×5)
  → TWO candidate sources (union of results):
      (a) Canny (50,150) → dilate (3×3) → findContours (RETR_LIST)
      (b) Otsu threshold (inverted) → morph-close (7×7) → findContours (RETR_LIST)
  → collectCardQuads: approxPolyDP to 4 vertices, convex, aspect ratio 0.55-0.85,
    area 2-95% of frame → list of ALL card-shaped quads (candidates)
  → selectCardQuad: prefer a small quad nested inside a markedly BRIGHTER larger
    quad (card resting on a pale backing / paper); else the largest quad
  → Order corners (sum/difference sort → TL, TR, BR, BL)
  → getPerspectiveTransform → warpPerspective to 745×1040 (cardMat)
  → For each of 4 rotations (0/90/180/270):
      classifyFrameType → crop art region (ART_REGIONS) → ImageData
  → Return {corners, candidates, cardMat, artRegions[4]} to worker
  → Worker posts corners + candidates + 4 art crops to main thread
  → Main thread hashes each crop, keeps best DB match (resolves orientation)
```

**Why two contour sources?** Canny works for cards on a contrasting background;
Otsu segmentation catches a dark card resting on a bright surface (e.g. a card
on a sheet of paper) where Canny's edges blend into printed content. `RETR_LIST`
(not `RETR_EXTERNAL`) is required so a card *nested inside* a larger bright quad
(the paper) is found at all.

**Why nested-quad selection?** A card photographed on white paper yields two
card-shaped quads: the paper and the card. The card is the smaller one nested
inside the brighter one. But a card photographed alone also yields nested quads
(its art box, text box), so we only drill inward when the enclosing quad is
substantially *brighter* (a blank backing), not merely larger.

**Debug overlay.** The scanner draws the selected card quad in **green** and all
other `candidates` in **yellow**, so you can see exactly what the detector
considers card-like — even when nothing matches. If you see no yellow on an
obvious card, the contour/threshold stage isn't finding it.

Auto-capture triggers after 15 consecutive frames where all 4 corners moved < 15px. 2-second cooldown between captures to avoid duplicates.

## Matching Details

- Brute-force Hamming distance over all entries (< 5ms for 50k, using bigint XOR + Kernighan popcount)
- Combined score: `pHash_dist * 0.6 + dHash_dist * 0.4`
- Threshold: combined score < 25 to be considered a candidate
- Confidence: `100 * e^(-score * 0.12)` (score 0 → 100%, score 10 → ~30%, score 25 → ~5%)
- `findMatchesInSubset` restricts search to a Set of illustration_ids (used for scan-to-select)
- **Minimum confidence 20%** (`MIN_CONFIDENCE` in `scanner-view.ts`): below this, the guess is still shown at the top of the screen with its % but in **red**, and is **not** added to staging. At/above, it's shown normally and staged.

## Known Limitations / Future Work

- Folder picker for moves uses `prompt()` — needs a proper modal dialog
- **Tests**: `tests/card_detection_test.ts` has 8 tests. The three primary ones run the **full pipeline on raw image files** (via `identifyCardInMat`) with no rotation/manipulation in test code — each fixture (`card_on_white.jpg`, `webcam_pic_noisy.jpg`, `webcam_pic_noisy_2.jpg`) is in a different orientation, proving the pipeline resolves orientation itself. The rest cover DB/metadata loading, contour detection, and warp dimensions.
- `captureFrame()` in camera creates a new canvas each call (could reuse)
- `detector.ts` pending promises never time out — if the worker stalls, they leak
- `importCollection` is destructive (clears before import, no merge option)
- No lazy-loading of OpenCV — it blocks the worker on first load
- Frame classifier thresholds are heuristic. Now validated against 3 real webcam photos (incl. cluttered/upside-down cards on paper); still worth expanding fixture coverage.
- Statistics view not implemented
- No PWA install prompt UX
