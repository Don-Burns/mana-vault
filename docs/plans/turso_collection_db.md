# Plan: Replace IndexedDB with Turso (browser SQLite/WASM)

## Goal
Replace the IndexedDB backend of the collection store with
[`@tursodatabase/database-wasm`](https://turso.tech/blog/introducing-turso-in-the-browser)
— the Rust SQLite rewrite running in the browser via WebAssembly, persisting to
OPFS. This is a **full replacement** (no dual backend, no fallback) and preserves
the app's offline-first behavior.

## Decisions (locked)
- **Full replacement** — IndexedDB is removed entirely; Turso is the only store.
- **No migration** — the collection DB is rebuilt from scratch. No need to read or
  copy any existing IndexedDB data.
- **Deliverable** — this plan document only (no implementation yet).

## Background (current architecture)
- `src/collection/store.ts` — singleton `CollectionStore` (exported as
  `collectionStore`) wraps IndexedDB (`mana-vault`, v1) with two object stores:
  - `folders` (keyPath `id`): indexes `sortOrder`, `name`.
  - `cards` (keyPath `id`): indexes `folderId`, `scryfallId`, `illustrationId`,
    `oracleId`, `name`, compound `[folderId, scryfallId]`.
- Public async API (`store.ts`): `open`, `ensureDefaultFolder`, `getAllFolders`,
  `getFolder`, `createFolder`, `putFolder`, `deleteFolder`, `renameFolder`,
  `reorderFolders`, `getFolderCardCount`, `getCardsByFolder`, `getCard`,
  `findCardInFolder`, `addCard`, `putCard`, `deleteCard`, `moveCard`, `moveCards`,
  `getIllustrationIdsInFolder`, `getAllCards`, `getTotalCardCount`,
  `exportCollection`, `importCollection`, `close`.
- Consumers touch **only** the public API — swapping internals requires no
  changes to callers:
  - `src/main.ts:56-57` — `open()` + `ensureDefaultFolder()` on startup.
  - `src/ui/scanner-view.ts:150,387` — read folders, `addCard`.
  - `src/ui/collection-view.ts` — folder/card reads, `moveCards`, `createFolder`,
    `getIllustrationIdsInFolder` (lines 83–398).
  - `src/collection/export.ts:21,39,89` — `exportCollection` / `importCollection`.
- `Folder` and `CardEntry` interfaces (`store.ts:17-40`) stay unchanged.

## Why Turso-in-the-browser fits
- Persists to **OPFS** → fully local, offline-first is preserved.
- API mirrors `better-sqlite3` but **async** (`prepare/run/get/all`) — the current
  store API is already fully async, so no consumer signatures change.
- COOP/COEP headers (required for SharedArrayBuffer) are **already set** on the
  Vite dev server (`vite.config.ts:51-54`).

## Key constraints & risks
1. **Async everywhere** — already satisfied by the current API surface.
2. **Single-tab lock** — Turso's synchronous OPFS access handle locks the DB file
   to one tab; a second tab cannot open it. IndexedDB allowed concurrent tabs.
   Must surface a clear "database in use in another tab" error from `open()`.
3. **Production COOP/COEP** — dev works, but the production host serving `dist/`
   **must** send the same `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` headers, or SharedArrayBuffer
   (and thus Turso) fails in prod. This is the highest-risk item.
4. **Service worker / offline** — the Turso WASM binary + its worker chunk must be
   cached so the DB loads offline after first visit. Current precache globs
   deliberately exclude large assets (`vite.config.ts:24-25`); the Turso WASM
   must be handled (precache small-ish, or runtime cache-first in `sw.ts`).
5. **Deno dependency management** — deps live in `deno.json` imports, not
   `package.json`; must add the npm specifier and use the `/vite` subpath export.
6. **Bundler/WASM** — use `@tursodatabase/database-wasm/vite` export, which ships
   the Vite-specific WASM + Web Worker workarounds.

---

## Steps

### Phase 1 — Dependency & build config
- Add `@tursodatabase/database-wasm` to `deno.json` `imports` (npm specifier).
- Import from the `/vite` subpath in the store to get bundler-safe WASM/worker
  handling.
- Verify Vite `worker.format: "es"` (already set, `vite.config.ts:45-47`) is
  compatible; adjust `optimizeDeps`/`assetsInclude` for `.wasm` if needed.

### Phase 2 — Rewrite CollectionStore internals (`src/collection/store.ts`)
- Replace the `IDBDatabase` field with a Turso connection
  (`await connect("mana-vault.db")` in `open()`).
- Define SQL schema mirroring the current stores/indexes:
  ```sql
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY, name TEXT, color TEXT,
    sortOrder INTEGER, createdAt TEXT, isDefault INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_folders_sortOrder ON folders(sortOrder);
  CREATE INDEX IF NOT EXISTS idx_folders_name ON folders(name);

  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY, folderId TEXT, scryfallId TEXT,
    illustrationId TEXT, oracleId TEXT, name TEXT, setCode TEXT,
    setName TEXT, collectorNumber TEXT, quantity INTEGER,
    condition TEXT, notes TEXT, dateAdded TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cards_folderId ON cards(folderId);
  CREATE INDEX IF NOT EXISTS idx_cards_scryfallId ON cards(scryfallId);
  CREATE INDEX IF NOT EXISTS idx_cards_illustrationId ON cards(illustrationId);
  CREATE INDEX IF NOT EXISTS idx_cards_oracleId ON cards(oracleId);
  CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
  CREATE INDEX IF NOT EXISTS idx_cards_folder_scryfall
    ON cards(folderId, scryfallId);
  ```
- Reimplement each public method with prepared statements. Notable mappings:
  - `getAllFolders` → `SELECT * FROM folders ORDER BY sortOrder`.
  - `findCardInFolder` → `SELECT * WHERE folderId=? AND scryfallId=?`.
  - `addCard` → keep the "increment if exists" merge logic in TS (or use
    `INSERT ... ON CONFLICT`), preserving current behavior.
  - `getTotalCardCount` → `SELECT COALESCE(SUM(quantity),0) FROM cards`.
  - `getFolderCardCount` → `SELECT COUNT(*) FROM cards WHERE folderId=?`.
  - `importCollection` → wrap clear + inserts in a single transaction.
  - `clearAll` → `DELETE FROM cards; DELETE FROM folders;` in a transaction.
- Map `isDefault` boolean ↔ integer (0/1) at the boundary so the `Folder`
  interface is unchanged.
- Keep `Folder` / `CardEntry` interfaces and all method signatures **identical**;
  consumers remain untouched.
- Handle the single-tab lock error in `open()` with a clear message.

### Phase 3 — Offline / service worker (`src/sw.ts`, `vite.config.ts`)
- Ensure the Turso WASM binary + worker chunk are available offline: either add
  them to `injectManifest.globPatterns` or add a runtime cache-first route in
  `sw.ts` (consistent with how OpenCV WASM / hash DB are cached today).

### Phase 4 — Production headers
- Configure the production host to send COOP/COEP headers matching the dev server
  (`vite.config.ts:51-54`). Document the requirement in the README deploy notes.
- If the host cannot set headers, note the fallback (a COEP credentialless
  service-worker shim) as a follow-up.

### Phase 5 — Verify
- Create/rename/reorder/delete folders; add/move/delete cards; quantity merge on
  duplicate printing.
- Reload page → data persists (OPFS).
- Export → import JSON round-trip.
- Offline (second load, network off) → app + DB work.
- Second browser tab → clear locked-DB error, not a crash.

## Files touched
- `deno.json` — add dependency.
- `src/collection/store.ts` — full internal rewrite (public API unchanged).
- `src/sw.ts` and/or `vite.config.ts` — cache Turso WASM/worker for offline.
- `README.md` — update storage description + document prod COOP/COEP requirement.

## Explicitly out of scope
- Migrating existing IndexedDB data (DB is rebuilt from scratch).
- Turso Cloud sync / remote replicas (local OPFS only).
- Moving the reference card DB (`hash-db.bin`, `metadata.json`) into SQLite.
- Any change to consumer/UI code.
