# MTG Card Scanner PWA

A fully offline-capable Progressive Web App for scanning and managing Magic: The Gathering card collections. Uses computer vision (OpenCV.js) and perceptual hashing to identify cards by their artwork — no internet required at scan time.

## Features

### Card Scanning
- **Camera-based detection**: Real-time card detection using rear camera with live overlay showing detected card outline
- **Auto-capture**: Automatically captures when a card is held steady in frame (stability detection across consecutive frames)
- **Manual capture**: Tap-to-capture fallback for difficult conditions
- **Art-based recognition**: Identifies cards by matching artwork using perceptual hashing (pHash + dHash), supporting non-English cards
- **Orientation-robust**: Sideways cards are resolved geometrically from the detected quad, and both 180° flips are hashed, so cards held sideways/upside-down (or photos with unapplied EXIF orientation) still identify correctly
- **Cluttered-scene detection**: Combines Canny edge and Otsu threshold contour passes to find a card even when it rests on a bright surface (e.g. a sheet of paper)
- **Frame type awareness**: Classifies card frames (modern 2003+, old border, borderless/full-art) to correctly isolate the art region
- **Confidence scoring**: Shows match confidence percentage; requires ≥20% to accept a card (weaker guesses shown in red but not added); top-N candidates ranked

### Collection Management
- **Folder system**: Organize cards into flat folders (e.g., "Trade Binder", "EDH Deck", "Bulk Rares")
- **Default "Unsorted" folder**: Always exists, cannot be deleted
- **Per-folder quantities**: Each card entry belongs to exactly one folder; moving transfers quantity
- **Card conditions**: Track NM, LP, MP, HP, DMG per entry

### Scanning Workflows

#### Scan-to-Add
1. Select a destination folder from the dropdown
2. Point camera at cards — app auto-detects and matches
3. Matched cards accumulate in a staging list
4. Review the staging list: adjust versions, quantities, remove mistakes
5. Confirm to commit all staged cards into the selected folder

#### Scan-to-Select
1. Open a folder in the Collection view
2. Tap "Scan Select" to activate camera
3. Scan physical cards — the app matches against only the cards in *this folder* (by exact illustration)
4. Matched cards are highlighted/selected in the folder's card list
5. Close scanner, then use "Move to..." to transfer the selection to another folder

#### Manual Selection + Move
1. Open a folder, tap "Select" to enter selection mode
2. Tap cards to select/deselect them
3. Use "Move to..." to pick a destination folder
4. Quantities transfer; if the same printing exists at the destination, quantities merge

### Offline Support
- Full offline operation after initial database download
- Service Worker caches: app shell, OpenCV WASM (~10.8MB), hash database, metadata
- Caching strategies: cache-first for large assets, stale-while-revalidate for app code, network-first for HTML

### Data Management
- **Export**: JSON (preserves folder structure) or CSV
- **Import**: JSON import restores full collection with folders
- **IndexedDB**: All collection data stored locally in the browser

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────┐
│  BUILD TOOLING (Deno CLI — run once to generate DB)     │
│                                                         │
│  download-bulk.ts → download-art.ts → build-hashdb.ts   │
│       │                   │                  │          │
│  Scryfall API        Art crop images    hash-db.bin     │
│  (bulk JSON)         (~50k JPEGs)       + metadata.json │
└─────────────────────────────────────────────────────────┘
                                    ↓ (static assets in public/db/)
┌─────────────────────────────────────────────────────────┐
│  PWA (Vanilla TypeScript, fully offline)                 │
│                                                         │
│  ┌──────────┐    ┌────────────────┐    ┌────────────┐  │
│  │  Camera  │ →  │  OpenCV.js     │ →  │   Hash     │  │
│  │  Feed    │    │  (Web Worker)  │    │   Matcher  │  │
│  └──────────┘    └────────────────┘    └────────────┘  │
│       ↓                                      ↓          │
│  ┌──────────────────┐    ┌─────────────────────────┐   │
│  │  Staging List    │ →  │  Collection (IndexedDB) │   │
│  │  (review batch)  │    │  Folders + Cards        │   │
│  └──────────────────┘    └─────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Detection Pipeline (runs in Web Worker)

```
Camera Frame
    │
    ▼
Grayscale → Gaussian Blur
    │
    ├── Canny Edge Detection → Dilate ──┐
    └── Otsu Threshold → Morph-Close ───┤   (two complementary candidate sources)
                                        ▼
                              Find Contours (RETR_LIST)
    │
    ▼
Collect ALL card-shaped quads → select best (prefer a small card nested
inside a brighter backing, e.g. a card on paper; else the largest)
    │
    ▼
4-Point Perspective Warp → Flat 745×1040 card image
    │
    ▼
For each of 2 rotations (0°/180°):
    Frame Type Classification → Art Region Extraction → ImageData
    │
    ▼
Main thread hashes both crops → Hamming search → best match wins
(the warp already resolves sideways cards from the quad's long axis; only the
 180° flip is ambiguous, and the matcher is not rotation-invariant)
```

The scanner overlay draws the selected card in **green** and other detected
candidates in **yellow**, so you can see what the detector considers card-like.
A minimum match confidence of **20%** is required to accept a card; weaker
guesses are still shown (in red) but not added to the collection.

### Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Runtime | Deno | TypeScript execution, task runner, npm compatibility |
| Bundler | Vite | Fast dev server, ES module bundling, worker support |
| Language | Vanilla TypeScript | No framework, full control, minimal bundle size |
| Image Processing | OpenCV.js (WASM) | Card detection, perspective correction, image manipulation |
| Hashing | Custom pHash + dHash | Perceptual hashing for art-based card identification |
| Storage | IndexedDB | Local collection persistence with folder/card schema |
| Offline | Service Worker (vite-plugin-pwa) | Cache app shell, WASM, hash DB for full offline use |
| Card Data | Scryfall API | Bulk data download + art crop images (one-time) |
| Image Processing (build) | Sharp | Server-side image resizing for hash computation |

---

## Project Structure

```
mtg_scanner_js/
├── deno.json                 # Tasks, imports, compiler options
├── vite.config.ts            # Vite config (WASM, workers, COOP/COEP headers)
├── index.html                # App shell with nav + main content area
├── .gitignore
│
├── public/
│   ├── manifest.json         # PWA manifest (standalone, portrait)
│   ├── icon.svg              # App icon
│   └── db/                   # Generated hash database (gitignored)
│       ├── hash-db.bin       # Binary perceptual hash database
│       └── metadata.json     # Card metadata (illustration → printings)
│
├── src/
│   ├── main.ts              # Boot sequence, view routing, SW registration
│   ├── styles.css           # All application styles
│   ├── sw.ts                # Service Worker with caching strategies
│   │
│   ├── camera/
│   │   └── capture.ts       # MediaDevices API wrapper, frame capture
│   │
│   ├── detection/
│   │   ├── detector.ts      # Main thread ↔ Worker bridge (async API)
│   │   ├── pipeline.ts      # Core CV: contour detection, warp, art extraction (typed with Cv/Mat)
│   │   ├── identify.ts      # Orientation resolution + hash-match orchestration
│   │   └── frame-classifier.ts  # Classify modern/old/borderless frames
│   │
│   ├── matching/
│   │   ├── hasher.ts        # Client-side pHash + dHash from ImageData
│   │   ├── hashdb.ts        # Load + parse binary hash DB into typed arrays
│   │   └── matcher.ts       # Hamming distance search, confidence scoring
│   │
│   ├── collection/
│   │   ├── store.ts         # IndexedDB schema, folder + card CRUD, move ops
│   │   ├── staging.ts       # Scan session staging list with change events
│   │   └── export.ts        # JSON/CSV export, JSON import
│   │
│   ├── ui/
│   │   ├── scanner-view.ts  # Camera feed + detection + matching + staging UI
│   │   └── collection-view.ts  # Folders + cards + scan-to-select + move flow
│   │
│   └── workers/
│       └── detection-worker.ts  # OpenCV.js processing (contour, warp, extract)
│
├── tools/                    # Deno CLI tools for database generation
│   ├── config.ts            # Shared paths, types, Scryfall config
│   ├── download-bulk.ts     # Fetch Scryfall default_cards bulk JSON
│   ├── download-art.ts      # Download art_crop images (rate-limited, resumable)
│   └── build-hashdb.ts      # Compute hashes, generate binary DB + metadata
│
├── tests/                    # Full-pipeline + unit tests (deno test)
│   ├── card_detection_test.ts
│   └── data/input/           # Real card photos used as fixtures
└── dist/                     # Production build output
```

---

## Technical Details

### Hash Database Format

Binary file with a fixed-size header and entry array for fast typed-array access:

```
Header (16 bytes):
  [0..3]   Magic: "MTGH" (4 bytes ASCII)
  [4..5]   Version: 1 (uint16 BE)
  [6..9]   Entry count (uint32 BE)
  [10..11]  Hash size: 8 bytes (uint16 BE)
  [12..15]  Reserved (zeros)

Entries (32 bytes each):
  [0..15]   illustration_id (UUID as 16 raw bytes, no dashes)
  [16..23]  pHash (64-bit, big-endian)
  [24..31]  dHash (64-bit, big-endian)
```

**Size estimate**: ~50k unique illustrations × 32 bytes = ~1.6 MB

### Perceptual Hash Algorithms

**pHash (Perceptual Hash)**:
1. Resize art to 32×32 grayscale
2. Compute 2D DCT (Discrete Cosine Transform)
3. Take top-left 8×8 DCT coefficients (low frequencies)
4. Compute median of 64 values
5. Each bit = 1 if coefficient > median → 64-bit hash

**dHash (Difference Hash)**:
1. Resize art to 9×8 grayscale
2. Compare adjacent horizontal pixels
3. Each bit = 1 if left pixel > right pixel → 64-bit hash

**Matching**: Combined score = `pHash_distance × 0.6 + dHash_distance × 0.4` (pHash weighted higher for frequency-domain robustness). Hamming distance computed via XOR + Kernighan's bit-counting.

### Frame Type Classification

Cards are classified by analyzing the border region:
- **Modern (2003+)**: Thin black/colored border. Art at ~5.7% inset, ~11.5% from top to ~55% height.
- **Old border (pre-2003)**: Thicker textured border (>7% card width). Art slightly inset further.
- **Borderless/full-art**: High color variance at edges (image content at border). Art extends nearly to edges.

Classification uses: edge pixel color variance, border thickness measurement, and average edge brightness.

### IndexedDB Schema

**Folders store** (keyPath: `id`):
- `id`, `name`, `color`, `sortOrder`, `createdAt`, `isDefault`
- Indexes: `sortOrder`, `name`

**Cards store** (keyPath: `id`):
- `id`, `folderId`, `scryfallId`, `illustrationId`, `oracleId`, `name`, `setCode`, `setName`, `collectorNumber`, `quantity`, `condition`, `notes`, `dateAdded`
- Indexes: `folderId`, `scryfallId`, `illustrationId`, `oracleId`, `name`, compound `[folderId, scryfallId]`

### Web Worker Architecture

OpenCV.js (~10.8 MB WASM) runs in an ES module Web Worker to keep the UI at 60fps:

```
Main Thread                    Worker Thread
───────────                    ─────────────
Camera frame (ImageData)  ──→  OpenCV processing:
                               - Two-source contour detection
                               - Perspective warp
                               - Art extraction ×2 orientations
                          ←──  Result: {corners, candidates, cardImage, artRegions[2]}

Main thread then:
- Draws overlay (selected quad green, other candidates yellow)
- Hashes both orientation crops, keeps the best DB match
- Searches hash DB (brute-force, <5ms for 50k entries)
- Adds match to staging list (if confidence ≥ 20%)
```

### Service Worker Caching Strategy

Built with `vite-plugin-pwa` (injectManifest mode) from the hand-written
`src/sw.ts`. It is a **transparent no-op in the dev server** (caching Vite's
transient dev modules would break HMR and OpenCV) and only applies real caching
in production builds. To test offline/caching behaviour, use a production build:
`deno task build && deno task preview`.

| Asset Type | Strategy | Rationale |
|-----------|----------|-----------|
| HTML (navigate) | Network-first | Get latest app version |
| JS/CSS/SVG | Stale-while-revalidate | Fast load, background update |
| OpenCV WASM | Cache-first (lazy, at runtime) | Rarely changes, ~11 MB; excluded from install precache |
| Hash DB + metadata | Cache-first (lazy, separate cache) | Large (~15 MB); excluded from install precache |
| App shell (HTML/CSS/JS/manifest/icon) | Precached at install | Small, needed for offline start |
| Other requests | Network-first with cache fallback | Graceful offline |

---

## Usage

### Prerequisites
- [Deno](https://deno.land/) v2.0+

### Development

```sh
# Start dev server (hot reload, accessible on LAN for mobile testing)
deno task dev
```

Opens at `http://localhost:3000`. Access from your phone on the same network using your machine's IP.

### Building the Card Database

This is a one-time process (re-run when new sets release):

```sh
# 1. Download Scryfall bulk card data (~200MB JSON)
deno task db:download

# 2. Download art crop images (~50k images, rate-limited, resumable)
#    This takes several hours. Safe to interrupt and resume.
deno task db:art

# 3. Generate the hash database + metadata
#    Requires: deno install --allow-scripts=npm:sharp@0.33.2
deno task db:build
```

The output (`public/db/hash-db.bin` and `public/db/metadata.json`) is served as static assets to the PWA.

### Production Build

```sh
deno task build    # Outputs to dist/
deno task preview  # Preview the production build locally
```

Deploy the `dist/` directory to any static hosting (Netlify, Vercel, Cloudflare Pages, etc.). Ensure the host serves with appropriate headers for WASM (COOP/COEP if SharedArrayBuffer is needed).

---

## Design Decisions

### Why perceptual hashing over OCR?
- Works for non-English cards (matches by art, not text)
- Works for foils, worn cards, and cards at odd angles
- No runtime API calls needed (fully offline)
- Hash DB is compact (~1.6 MB for 50k cards)

### Why OpenCV.js in a Web Worker?
- OpenCV WASM is 10.8 MB — loading blocks the main thread
- Processing each frame (edge detection, perspective warp) takes 20-50ms
- Worker keeps camera preview and UI responsive at 60fps

### Why a binary hash DB format?
- Fast to load (single fetch, parse into typed arrays)
- Compact (32 bytes per entry vs. JSON overhead)
- Direct BigUint64Array access for Hamming distance computation
- Cacheable by Service Worker as a single binary blob

### Why Vanilla TypeScript (no framework)?
- Minimal bundle size (26 KB app code gzipped)
- No framework churn or dependency updates
- Full control over DOM updates and lifecycle
- Camera/canvas/worker APIs are imperative by nature

---

## Future Improvements

- [ ] Statistics view (card counts per folder, set completion percentages, estimated value)
- [ ] PWA install prompt with guided UX
- [ ] Lazy-load OpenCV (don't block initial render)
- [ ] Chunk hash DB for incremental download
- [ ] Better folder picker dialog (replace `prompt()` with modal)
- [ ] Card detail view with Scryfall link and price info
- [ ] Batch quantity editing in staging review
- [ ] Undo/redo for collection operations
- [ ] Dark/light theme toggle
- [ ] Multiple hash DB versions for set-based updates (download only new sets)
