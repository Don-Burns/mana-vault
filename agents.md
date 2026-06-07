# agents.md — Project Context for AI Agents

> This file exists to help AI agents get up to speed with the project quickly.
> Read this before exploring the codebase.

## What This Project Is

An offline-first PWA for scanning Magic: The Gathering cards with a phone camera and managing them in a local collection organized by folders. Cards are identified by matching their artwork against a pre-built perceptual hash database — no network needed at scan time.

**Stack**: Deno + Vite + Vanilla TypeScript + OpenCV.js (WASM) + IndexedDB

## Quick Reference

### Commands

```sh
deno task dev          # Vite dev server on :3000 (hot reload, LAN accessible)
deno task build        # Production build → dist/
deno task preview      # Preview production build

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
  sw.js                              # Service worker (fixed name, not hashed)
  assets/main-[hash].js              # App bundle (~27 KB)
  assets/main-[hash].css             # Styles (~7 KB)
  assets/detection-worker-[hash].js  # OpenCV worker (~4 KB)
  assets/opencv-[hash].js            # OpenCV WASM (~10.8 MB, cached by SW)
```

### Key Directories

| Path | Purpose |
|------|---------|
| `src/` | PWA source (Vite bundles this) |
| `src/workers/` | Web Worker for OpenCV (runs off main thread) |
| `tools/` | Deno CLI scripts for building the hash database |
| `vendor/opencv/` | Vendored OpenCV.js 4.13.0 (WASM embedded, downloaded via task) |
| `public/db/` | Generated hash DB + metadata (gitignored, built by tools) |
| `data/` | Downloaded Scryfall data (gitignored, large) |

## Architecture at a Glance

```
[Camera] → [Web Worker: OpenCV contour/warp/crop] → [pHash+dHash] → [Hamming search] → [Staging] → [IndexedDB]
```

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

3. Both the browser worker (`src/workers/detection-worker.ts`) and Deno tests import from `vendor/opencv/mod.ts`

The `.cjs` file is ~10.5 MB and gitignored. Run `deno task opencv:download` after cloning.

### OpenCV Memory Management

OpenCV.js uses manual memory management (WASM heap). Every `cv.Mat` must be `.delete()`-ed or you leak memory. The detection pipeline (`src/detection/pipeline.ts`) is careful about this with `try/finally` blocks. If you add new Mat operations, always delete them.

**Critical: `clone()` vs `copyTo()` for ROI Mats.** In OpenCV.js, `mat.roi(rect)` creates a non-contiguous Mat that shares the parent's row stride. `clone()` preserves this non-contiguous layout — the resulting Mat has the parent's step size, and `mat.data` reads garbled bytes across row boundaries. Always use `copyTo()` to create truly contiguous copies of ROIs. `pipeline.ts` and `matToImageData` both handle this.

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
- Service worker is a separate Rollup entry point with a fixed output name `sw.js`
- COOP/COEP headers are set in dev server for SharedArrayBuffer compatibility

### Scryfall Data Model

- `illustration_id`: shared across reprints with the same art (this is what we hash)
- `oracle_id`: logical card identity across all printings/languages
- `scryfall_id` (just `id` in their API): unique per exact printing
- One illustration can have many printings. The metadata JSON maps `illustration_id → {name, oracle_id, printings[]}`

## File-by-File Summary

### src/

| File | Lines | What It Does |
|------|-------|-------------|
| `main.ts` | 74 | Boot: open IndexedDB, register SW, create App with view routing |
| `styles.css` | 549 | All CSS. Dark theme via custom properties. Nav forced to bottom with `order: 1` |
| `sw.ts` | 132 | Service worker. Cache-first for WASM/DB, stale-while-revalidate for assets |
| `camera/capture.ts` | 139 | Camera class wrapping getUserMedia. Frame handler loop via rAF |
| `detection/detector.ts` | 115 | Main thread ↔ Worker bridge. Async `detect(ImageData)` → `DetectionResult` |
| `detection/pipeline.ts` | ~260 | Core detection functions: contour detection, perspective warp, art extraction. Shared by worker and tests |
| `detection/frame-classifier.ts` | ~90 | Classify card frame type by border thickness. Exports `ART_REGIONS` crop ratios |
| `workers/detection-worker.ts` | ~80 | Thin wrapper: loads OpenCV, converts ImageData↔Mat, delegates to pipeline.ts |
| `matching/hasher.ts` | ~65 | Client-side ImageData → 32×32 grayscale (area-averaged) → hash-core.ts |
| `matching/hash-core.ts` | 88 | Shared pHash (DCT) + dHash (gradient) algorithms. Used by both client and build tool |
| `matching/hashdb.ts` | 159 | Parse binary hash DB into BigUint64Array. Private constructor, use `HashDB.load()` |
| `matching/matcher.ts` | 145 | Hamming distance brute-force search. 60/40 pHash/dHash weighting. Confidence via exp decay |
| `collection/store.ts` | 423 | IndexedDB singleton. Folders + cards CRUD, move with quantity split/merge, export/import |
| `collection/staging.ts` | 147 | In-memory staging list with change notification. Deduplicates by scryfallId |
| `collection/export.ts` | 129 | JSON/CSV export, JSON import. Import is destructive (clears first) |
| `ui/scanner-view.ts` | 422 | Camera + detection + matching + staging review. Auto-capture after 15 stable frames |
| `ui/collection-view.ts` | 437 | Folder list + card list + manual select + scan-to-select + move flow |

### tools/

| File | Lines | What It Does |
|------|-------|-------------|
| `config.ts` | 69 | Shared paths, types, constants (rate limit, hash size, Scryfall URL) |
| `download-bulk.ts` | 169 | Fetch Scryfall bulk JSON, extract fields, handle DFCs, write cards.json |
| `download-art.ts` | 177 | Download art_crop JPEGs per illustration_id. Rate-limited, resumable via .progress.json |
| `build-hashdb.ts` | 230 | Compute hashes with sharp (imports hash-core.ts), write binary DB + metadata JSON, copy to public/db/ |
| `download-opencv.ts` | ~80 | Download OpenCV.js 4.13.0 from GitHub, patch for Deno, write to vendor/opencv/opencv.cjs |

## Detection Pipeline Details

```
Camera frame (1280×720 RGBA)
  → Grayscale
  → Gaussian blur (5×5)
  → Canny (50, 150)
  → Dilate (3×3)
  → findContours (RETR_EXTERNAL)
  → Filter: area 5-95% of frame, approxPolyDP to 4 vertices, convex, aspect ratio 0.55-0.85
  → Order corners (sum/difference sort → TL, TR, BR, BL)
  → getPerspectiveTransform → warpPerspective to 745×1040
  → classifyFrameType (border thickness measurement)
  → Crop art region (percentages from ART_REGIONS lookup)
  → Return {corners, cardMat, artMat} to worker
  → Worker converts to ImageData and posts to main thread
```

Auto-capture triggers after 15 consecutive frames where all 4 corners moved < 15px. 2-second cooldown between captures to avoid duplicates.

## Matching Details

- Brute-force Hamming distance over all entries (< 5ms for 50k, using bigint XOR + Kernighan popcount)
- Combined score: `pHash_dist * 0.6 + dHash_dist * 0.4`
- Threshold: combined score < 25 to be considered a candidate
- Confidence: `100 * e^(-score * 0.12)` (score 0 → 100%, score 10 → ~30%, score 25 → ~5%)
- `findMatchesInSubset` restricts search to a Set of illustration_ids (used for scan-to-select)

## Known Limitations / Future Work

- Folder picker for moves uses `prompt()` — needs a proper modal dialog
- No tests yet (the `tests/` directory is empty) ← **resolved: 7 tests in `tests/card_detection_test.ts` cover the full pipeline: OpenCV contour detection, perspective warp, art extraction, hash computation (server + client paths), and matching**
- `captureFrame()` in camera creates a new canvas each call (could reuse)
- `detector.ts` pending promises never time out — if the worker stalls, they leak
- `importCollection` is destructive (clears before import, no merge option)
- The hash algorithms are duplicated between tools and src (could extract a shared module but Deno vs browser runtimes make this tricky) ← **resolved: now in `src/matching/hash-core.ts`**
- OpenCV.js comes from a third-party npm wrapper (`@techstark/opencv-js`) ← **resolved: vendored official 4.13.0 build in `vendor/opencv/`**
- No lazy-loading of OpenCV — it blocks the worker on first load
- Frame classifier thresholds are heuristic and untested against real card photos ← **partially resolved: classifier rewritten to use border thickness measurement; tested against one real photo; needs more test fixtures**
- Statistics view not implemented
- No PWA install prompt UX
