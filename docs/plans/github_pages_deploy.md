# Plan: Serve the PWA on GitHub Pages

## Goal
Deploy Mana Vault to GitHub Pages as a project site at
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
- **Card images:** offline-only, no exceptions. **No CDN hotlinking** (e.g. no
  fetching from `cards.scryfall.io` at runtime) — images only ever come from
  an asset the app itself ships/downloads. Where art isn't available locally,
  show a blank placeholder rather than falling back to a network fetch. See
  Phase 4 for the design.
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

## Phase 1 — Make the app base-path agnostic ✅ done

Everything currently assumes the app is served from `/`. Under a project site
it is served from `/mtg_scanner_js/`, so every absolute path needs to become
base-relative.

| File | Current | Change |
|---|---|---|
| `vite.config.ts` | no `base` set (defaults to `/`) | `base: process.env.BASE_PATH ?? "/"`, set `BASE_PATH=/mtg_scanner_js/` only in the CI build |
| `src/workers/detection-worker.ts:30-49` | `HashDB.load("/db/hash-db.bin")` | resolve relative to the worker's own `self.location`, since workers don't see `document.baseURI` / `import.meta.env.BASE_URL` the same way the main thread does |
| `src/ui/scanner-view.ts:130` | `fetch("/db/metadata.json")` | base-relative fetch |
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

## Phase 2 — Shrink and version the database ✅ done

Current sizes: `hash-db.bin` 2.4 MB (fine as-is), `metadata.json` **14.4 MB**
(was parsed synchronously on the main thread in `scanner-view.ts` at scanner
init — this was the bigger problem, not raw size).

Done, in priority order:
1. **Trim metadata fields.** Checked the actual bulk data first: the build
   already uses Scryfall's `unique_artwork` bulk file, which is ~99.2%
   English already (53,307 of 53,719 rows) and averages ~1.05 printings per
   illustration. So the "drop unused fields" idea didn't apply — every field
   (`id, set, set_name, collector_number, lang, released_at, rarity`) is
   consumed by `card-search.ts` or `scanner-view.ts`'s alternate-printing
   picker. Filtering `printings` to `lang === "en"` (keeping the original
   list as a fallback for the 396 illustrations with no English printing at
   all) is now done in `tools/build-hashdb.ts`, but only trims metadata.json
   by a rounding error (~0.8% of rows) — **the 4-6 MB estimate above was
   wrong**, actual size is still ~14.4 MB. Kept the filter anyway since it's
   free and correct, but it isn't the size lever this doc assumed.
2. **Rely on gzip in transit.** No code needed — GitHub Pages does this
   automatically for `application/json`.
3. **Move the parse off the main thread.** Done via a new dedicated
   `src/workers/metadata-worker.ts` (not the detection worker — metadata is
   also needed for the manual "Add Card" search, which shouldn't block on
   OpenCV init). `scanner-view.ts` now awaits the worker's parsed result
   instead of calling `fetch().then(r => r.json())` inline.
4. **Fix cache invalidation.** Done via content-hashing: `build-hashdb.ts`
   now writes `public/db/version.json` with a SHA-256-derived hash of
   `hash-db.bin`. Runtime code (`src/workers/db-version.ts`) fetches that
   marker first and appends `?v=<hash>` to the DB/metadata requests, so a
   rebuilt DB is a new cache key rather than stuck stale under the fixed
   `mana-vault-db-v1` cache name. `src/sw.ts` excludes `version.json` itself
   from the `cacheFirst` route so the marker is always fetched fresh.

`dist/` size is essentially unchanged by this phase (~28 MB) — the real win
was moving the 14.4 MB `JSON.parse` off the main thread and fixing cache
staleness, not shrinking the payload. Actual `dist/` size stays comfortably
under the 1 GB Pages cap either way.

---

## Phase 3 — CI/CD ✅ done

`.github/workflows/deploy.yml` implemented:
```
  on: push to main, workflow_dispatch
  permissions: pages: write, id-token: write
  build job:
    - checkout
    - setup-deno
    - gh release download db-latest --dir public/db     # hash-db.bin + metadata.json + version.json
    - deno task opencv:download                        # vendor/ is gitignored, must be fetched
    - BASE_PATH=/${{ repo name }}/ deno task build
    - touch dist/.nojekyll
    - actions/upload-pages-artifact (path: dist)
  deploy job (needs: build):
    - actions/deploy-pages
```

Companion local task `deno task db:release` (`tools/release-db.ts`) runs the
existing 3-step pipeline (`db:download` → `db:art` → `db:build`) and then
`gh release upload`s `hash-db.bin` + `metadata.json` + `version.json`. Rather
than a bumped version tag (`db-v3`, `db-v4`, ...) that would need a matching
edit in `deploy.yml` every release, it overwrites one moving `db-latest`
tag/release — CI always fetches "whatever's current" with zero workflow
changes per DB rebuild. `version.json`'s content hash (Phase 2) is what
actually distinguishes DB versions for cache-busting purposes; the release
tag doesn't need to. If per-build rollback/history is ever needed, switch to
timestamped tags and update the `gh release download` line in `deploy.yml`.

This keeps the multi-hour, ~5 GB Scryfall art download entirely off CI and
out of git history, while still giving CI a reproducible source for the DB.

**Repo setting required:** Settings → Pages → Source = "GitHub Actions"
(not the legacy `gh-pages` branch, which this plan does not use).

**Not yet done:** nobody has run `deno task db:release` against the real repo
yet, so the `db-latest` release doesn't exist — the workflow will fail at the
`gh release download` step until that's done once, manually, with `gh auth
login` access to the repo.

---

## Phase 4 — Card images

**Decision: no CDN hotlinking, ever.** An earlier pass of this work
implemented hotlinking card art from `cards.scryfall.io` at runtime — that
was wrong per the locked decision above and has been reverted. Images are
offline-only: local asset if present, blank placeholder otherwise, no
network fallback to any third party.

**UI slots wired, art not shipped yet ✅ partial.** `src/collection/card-image.ts`
resolves a **local, same-origin** path (`${BASE_URL}art/<illustrationId>.jpg`)
— keyed by `illustrationId` to match `tools/build-hashdb.ts`'s art filenames,
not `scryfallId`. Wired into the two card-list renderers that previously
showed name/set text only: `renderCardItem` (Collection view) and
`renderStagedCard` (scan staging review), each with an `onerror` handler that
swaps the `<img>` to a blank `.card-thumb-blank` placeholder instead of a
broken-image icon. Since the actual art pack (option B below) isn't built,
every image currently 404s and falls back to blank — that's the intended,
correct behavior until B ships, not a bug.

The app previously displayed **no card images** at runtime — only the user's
own captured/warped frame (`scanner-view.ts:804-816`, the match splash).
Card identification is pure hash-vs-hash against `hash-db.bin`; Scryfall
images were used only offline, at DB-build time. Measured source sizes for
the option-B/C/D alternatives below:

| Source | Files | Total | Avg/file |
|---|---|---|---|
| `data/full_art` (Scryfall `small`, 146×204) | 51,371 | 801 MB | ~14 KB |
| `data/crop_art` (Scryfall `art_crop`, full res) | 51,374 | 4.2 GB | ~85 KB |

**801 MB will not go on GitHub Pages as part of the site.** It's within the
1 GB cap only by itself (leaving nothing for the app/DB), and 51k individual
requests would blow past the bandwidth soft limit quickly if served to every
visitor. `data/crop_art` (4.2 GB) shouldn't be shipped at all — it's a
build-time input only.

**Not built — this is now the only path forward for real art, pick up when
wanted:**

**B. Downloadable offline art pack (the actual feature).**
Ship the 801 MB as sharded bundles (e.g. 20-40 `.zip`/`.tar` shards, or a
single packed blob + offset index mirroring the `hash-db.bin` approach) as
**GitHub Release assets** (2 GB/file limit, served from GitHub's own CDN —
Release-asset bandwidth is not counted against the Pages site quota). The app
would offer an explicit "Download offline art (~Ν MB)" action, fetch shards
with progress, and unpack into a Cache API bucket or an IndexedDB blob store
at the `art/<illustrationId>.jpg` paths `card-image.ts` already requests —
once unpacked, the existing `<img>` tags resolve automatically with no
further UI change needed.
- Re-encoding to WebP/AVIF at 146×204 should cut 801 MB to roughly
  300-400 MB.
- Mobile storage quotas need explicit handling: iOS Safari caps origin
  storage (~1 GB, evictable under pressure); call
  `navigator.storage.persist()` and handle `QuotaExceededError` gracefully.

**C. Object storage (Cloudflare R2 or similar).** Worth revisiting if the
pack grows past what Release assets comfortably serve, or if range-request
access to individual images becomes useful. Requires an account and CORS
configuration — more infrastructure than B needs, so not a first choice.

**D. `crop_art` (4.2 GB).** Not part of any shipping plan. If an art-crop
view is ever wanted in the UI, derive it client-side by cropping the
already-available full-art image rather than shipping a second 4.2 GB asset
set.

---

## Issues summary

| Issue | Severity | Mitigation |
|---|---|---|
| Absolute `/`-rooted paths break under `/mtg_scanner_js/` | Blocker | Resolved — Phase 1 |
| SW `cacheFirst` on `/db/*` never invalidates → stale DB forever | High | Resolved — Phase 2, content-hashed `version.json` + `?v=` query |
| 14.4 MB `JSON.parse` on the main thread at scanner init | High | Resolved — Phase 2, moved to `metadata-worker.ts` (field-trim didn't reduce size, see Phase 2 notes) |
| Missing `icon-192.png` / `icon-512.png` → app not installable | Medium | Resolved — Phase 1, generated from `icon.svg` |
| `dist/`, `public/db/`, `vendor/` are all gitignored → CI must reconstruct them | Medium | Resolved — Phase 3, Release-asset DB download + `deno task opencv:download` in CI |
| 801 MB of card art won't fit Pages' practical bandwidth/size budget | Medium | Not started — Phase 4, design only |
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
