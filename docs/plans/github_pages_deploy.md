# Plan: Serve the PWA on GitHub Pages

## Goal
Deploy the MTG Scanner PWA to GitHub Pages as a project site at
`https://<user>.github.io/mtg_scanner_js/`, fully offline-capable after first
load (hash DB + metadata), with a path to add offline card art later.

## Decisions (locked)
- **Hosting type:** GitHub Pages **project site** (`/mtg_scanner_js/` subpath),
  not a user/org root site or custom domain. This requires a Vite `base` and
  fixing every hardcoded `/`-rooted path in the app.
- **Database delivery:** commit the built `hash-db.bin` + `metadata.json` into
  the deployed Pages artifact (not fetched cross-origin at runtime). They stay
  gitignored in the repo; CI pulls the pre-built files in from a GitHub Release
  and bundles them into `dist/` before publishing.
- **DB build location:** built **locally** (`deno task db:download && db:art &&
  db:build`) and uploaded as a GitHub Release asset. CI does **not** run the
  Scryfall bulk-art download (~5 GB, hours, 75ms/request rate limit) — it only
  downloads the pre-built Release asset and packages it.
- **Card images:** out of scope for the first deploy. Full-art images
  (`data/full_art`, 801 MB / 51,371 files) are wanted **offline-optional** as a
  later feature — see Phase 4 for the design, not implemented now.
- **Deliverable for this pass:** this plan document only. No code changes yet.

## Constraints verified
| GitHub Pages limit | Value | Status |
|---|---|---|
| Published site size | 1 GB soft cap | OK — current `dist/` ~28 MB, DB after shrinking ~15-20 MB |
| Per-file size | 100 MB | OK — largest tracked asset is the 10.9 MB OpenCV chunk |
| Bandwidth | ~100 GB/month soft | OK for app shell + DB; would **not** be OK for shipping 801 MB of art to every visitor |
| Custom response headers | Not supported (no COOP/COEP, no custom CSP) | Checked — see below |
| SPA URL rewriting | Not supported (static file server only) | Mitigated with `404.html` copy of `index.html` |
| HTTPS | Always on | Satisfies the Camera API's secure-context requirement |

**COOP/COEP finding:** `vite.config.ts`'s dev server sets
`Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy:
require-corp`, which are normally needed for `SharedArrayBuffer`/threaded
WASM and are **not configurable on GitHub Pages**. This turned out not to
matter: `vendor/opencv/opencv.mjs` (10,964,567 bytes) inlines its `.wasm`
payload as base64 and does not use `SharedArrayBuffer`, `Atomics.wait`, or
pthreads (verified by grep). So the vendored OpenCV build runs fine without
those headers, and GitHub Pages is viable for this app.

---

## Phase 1 — Make the app base-path agnostic

Everything currently assumes the app is served from `/`. Under a project site
it is served from `/mtg_scanner_js/`, so every absolute path needs to become
base-relative.

| File | Current | Change |
|---|---|---|
| `vite.config.ts` | no `base` set (defaults to `/`) | `base: process.env.BASE_PATH ?? "/"`, set `BASE_PATH=/mtg_scanner_js/` only in the CI build |
| `src/workers/detection-worker.ts:30-49` | `HashDB.load("/db/hash-db.bin")` | resolve relative to the worker's own `self.location`, since workers don't see `document.baseURI` / `import.meta.env.BASE_URL` the same way the main thread does |
| `src/ui/scanner-view.ts:105-114` | `fetch("/db/metadata.json")` | base-relative fetch |
| `src/sw.ts` | `APP_SHELL = ["/", "/index.html", "/manifest.json", "/icon.svg"]`; route check `url.pathname.startsWith("/db/")` | prefix `APP_SHELL` entries with the base path; change the route check to a suffix/contains match so it still matches under a subpath |
| `public/manifest.json` | `start_url: "/"`, icons at `/icon.svg` | add `scope`, `id`, base-prefix `start_url` and icon paths |
| `index.html` | any absolute `/icon.svg`, `/manifest.json` links | base-relative |

**Additional gotchas:**
- **Service worker scope** is limited to the directory it's served from —
  `/mtg_scanner_js/sw.js` can only control `/mtg_scanner_js/*`, which is what
  we want, but `vite-plugin-pwa`'s `injectRegister: "auto"` output
  (`dist/registerSW.js`) needs to be checked after setting `base` to confirm
  it registers with the right scope.
- **`.nojekyll`** must be added to the published artifact — GitHub's Jekyll
  processing strips `_`-prefixed paths/files by default.
- **Missing icons:** `public/manifest.json` references `/icon-192.png` and
  `/icon-512.png`, neither of which exists (only `icon.svg` does). Until
  these are generated, the PWA will fail Chrome's installability checks.
- **`404.html`:** the router in `src/main.ts` is state-based (not
  `history.pushState`-based), so this is low-risk today, but adding a
  `404.html` copy of `index.html` is cheap insurance against future deep
  linking.

---

## Phase 2 — Shrink and version the database

Current sizes: `hash-db.bin` 2.4 MB (fine as-is), `metadata.json` **14.4 MB**
(parsed synchronously on the main thread in `scanner-view.ts` at scanner
init — this is the bigger problem).

Recommended, in priority order:
1. **Trim metadata fields.** `metadata.json` currently stores every printing
   (`id, set, set_name, collector_number, lang, released_at`) for all 51k
   illustrations. Filtering to `lang === "en"` and dropping unused fields
   should bring 14.4 MB down to roughly 4-6 MB.
2. **Rely on gzip in transit.** GitHub Pages gzips `application/json`
   automatically; this repetitive JSON should compress to roughly 2-3 MB over
   the wire even before trimming. This alone makes the download acceptable —
   the remaining cost is the `JSON.parse` pause, not the transfer.
3. **Move the parse off the main thread.** Load `metadata.json` in the
   detection worker (which already loads `hash-db.bin`) or a dedicated
   worker, and post back only the single matched card's record instead of
   parsing 14+ MB of JSON on the UI thread at startup.
4. **Fix cache invalidation.** `src/sw.ts` serves `/db/*` with `cacheFirst`
   against a fixed cache name (`mtg-scanner-db-v1`). Once installed, a client
   will **never** see an updated DB unless the cache name changes. Either
   content-hash the DB filenames (`hash-db.<hash>.bin`) so the URL itself
   changes, or inject a build-time version into the SW's cache name constant.

Expected result: `dist/` shrinks from ~28 MB to roughly 15-20 MB, comfortably
under all Pages limits.

---

## Phase 3 — CI/CD

No CI/CD exists today (`.github/` is absent). Proposed setup:

```
.github/workflows/deploy.yml
  on: push to main, workflow_dispatch
  permissions: pages: write, id-token: write
  steps:
    - checkout
    - setup-deno
    - gh release download <db-tag> --dir public/db     # pre-built hash-db.bin + metadata.json
    - deno task opencv:download                        # vendor/ is gitignored, must be fetched
    - BASE_PATH=/mtg_scanner_js/ deno task build
    - touch dist/.nojekyll
    - actions/upload-pages-artifact@... (path: dist)
    - actions/deploy-pages@...
```

Companion local task, `deno task db:release`, runs the existing 3-step
pipeline (`db:download` → `db:art` → `db:build`) and then `gh release upload`s
`hash-db.bin` + `metadata.json` under a version tag (e.g. `db-v3`). This keeps
the multi-hour, ~5 GB Scryfall art download entirely off CI and out of git
history, while still giving CI a reproducible, versioned source for the DB.

**Repo setting required:** Settings → Pages → Source = "GitHub Actions"
(not the legacy `gh-pages` branch, which this plan does not use).

---

## Phase 4 — Card images (design only, not built now)

The app currently displays **no card images** at runtime — only the user's
own captured/warped frame (`scanner-view.ts:438-465`). Card identification is
pure hash-vs-hash against `hash-db.bin`; Scryfall images are used only
offline, at DB-build time. Adding real card art for display is a future
feature, wanted **offline-optional**. Measured source sizes:

| Source | Files | Total | Avg/file |
|---|---|---|---|
| `data/full_art` (Scryfall `small`, 146×204) | 51,371 | 801 MB | ~14 KB |
| `data/crop_art` (Scryfall `art_crop`, full res) | 51,374 | 4.2 GB | ~85 KB |

**801 MB will not go on GitHub Pages as part of the site.** It's within the
1 GB cap only by itself (leaving nothing for the app/DB), and 51k individual
requests would blow past the bandwidth soft limit quickly if served to every
visitor. `data/crop_art` (4.2 GB) shouldn't be shipped at all — it's a
build-time input only.

Options for when this is built:

**A. Hotlink Scryfall's CDN at runtime (recommended to start).**
`metadata.json` printings already carry Scryfall `id`s, so image URLs are
derivable directly:
`https://cards.scryfall.io/small/front/<id[0]>/<id[1]>/<id>.jpg` (per
Scryfall's documented URL scheme). Zero hosting cost, zero build work,
permitted by Scryfall's API guidelines. Add a runtime `cacheFirst` SW route
for `cards.scryfall.io` with an LRU eviction cap, so images the user actually
scans become available offline automatically after first view. Downside: the
first view of any given card requires network access.

**B. Downloadable offline art pack (the actual "offline-optional" feature).**
Ship the 801 MB as sharded bundles (e.g. 20-40 `.zip`/`.tar` shards, or a
single packed blob + offset index mirroring the `hash-db.bin` approach) as
**GitHub Release assets** (2 GB/file limit, served from GitHub's own CDN —
Release-asset bandwidth is not counted against the Pages site quota). The app
would offer an explicit "Download offline art (~Ν MB)" action, fetch shards
with progress, and unpack into a Cache API bucket or an IndexedDB blob store.
Pairs naturally with option A: hotlink until the user opts into the full
offline pack.
- Re-encoding to WebP/AVIF at 146×204 should cut 801 MB to roughly
  300-400 MB.
- Mobile storage quotas need explicit handling: iOS Safari caps origin
  storage (~1 GB, evictable under pressure); call
  `navigator.storage.persist()` and handle `QuotaExceededError` gracefully.

**C. Object storage (Cloudflare R2 or similar).** Worth revisiting if the
pack grows past what Release assets comfortably serve, or if range-request
access to individual images becomes useful. Requires an account and CORS
configuration — more infrastructure than A/B need, so not a first choice.

**D. `crop_art` (4.2 GB).** Not part of any shipping plan. If an art-crop
view is ever wanted in the UI, derive it client-side by cropping the
already-available full-art image rather than shipping a second 4.2 GB asset
set.

---

## Issues summary

| Issue | Severity | Mitigation |
|---|---|---|
| Absolute `/`-rooted paths break under `/mtg_scanner_js/` | Blocker | Phase 1 |
| SW `cacheFirst` on `/db/*` never invalidates → stale DB forever | High | Content-hash DB filenames or version the SW cache name |
| 14.4 MB `JSON.parse` on the main thread at scanner init | High | Trim fields, gzip (automatic on Pages), move parse into a worker |
| Missing `icon-192.png` / `icon-512.png` → app not installable | Medium | Generate PNG icons from `icon.svg` |
| `dist/`, `public/db/`, `vendor/` are all gitignored → CI must reconstruct them | Medium | Release-asset DB download + `deno task opencv:download` in CI |
| 801 MB of card art won't fit Pages' practical bandwidth/size budget | Medium | Serve via Scryfall CDN hotlink and/or Release-asset offline pack |
| No custom response headers on Pages (no COOP/COEP) | Resolved | Verified no `SharedArrayBuffer`/pthreads usage; vendored OpenCV inlines WASM as base64 |
| 10.9 MB OpenCV JS chunk | Low | Already excluded from SW precache, cached lazily at runtime; gzips to ~4 MB in transit |
| Camera API requires a secure context | Resolved | GitHub Pages serves HTTPS by default |

## Open questions
- Offline art pack format: sharded archives vs. a single packed blob + offset
  index (mirroring `hash-db.bin`)? The latter is more consistent with the
  existing DB design but needs its own loader code.
- Should non-English printings be dropped from `metadata.json` entirely, or
  kept but deprioritized/compacted, in case language filtering is wanted in
  the collection UI later?
