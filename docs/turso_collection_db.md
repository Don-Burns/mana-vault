# Turso (SQLite/WASM) Collection Store

The collection store (`src/collection/store.ts`) persists folders and cards to
SQLite running in the browser via WebAssembly
([`@tursodatabase/database-wasm`](https://turso.tech/blog/introducing-turso-in-the-browser)),
with the database file persisted to OPFS. This replaced the previous
IndexedDB backend — see `docs/plans/turso_collection_db.md` for the original
migration plan.

## Why Turso-in-the-browser

- Persists to **OPFS** → fully local, offline-first is preserved.
- API mirrors `better-sqlite3` but is fully async (`prepare/run/get/all`),
  matching the store's existing async public API — no consumer changes.
- Lets the collection logic be tested against **real SQLite** outside the
  browser (see Testing below), which IndexedDB never allowed.

## Runtime driver: `@tursodatabase/database-wasm`

`store.ts` imports `connect` from the `/vite` subpath export, which ships the
Vite-specific WASM + Web Worker wiring:

```ts
import { connect } from "@tursodatabase/database-wasm/vite";
```

`CollectionStore.open()` calls `connect(path)` and then `exec()`s the schema
(`CREATE TABLE IF NOT EXISTS ...`) — see the `SCHEMA` constant in
`store.ts` for the full DDL (`folders` and `cards` tables + indexes,
mirroring the old IndexedDB object stores/indexes 1:1).

### Single-tab lock

Turso's OPFS sync access handle locks the database file to **one tab**. A
second tab opening the app cannot also open the DB. `open()` catches the
connect failure and rethrows a clear "database may be open in another tab"
error instead of the raw driver error — surface this to the user rather than
retrying.

### Production COOP/COEP headers (highest-risk item)

Turso-in-the-browser needs `SharedArrayBuffer`, which browsers only expose in
a **cross-origin-isolated** context. The Vite dev server already sends the
required headers (`vite.config.ts`):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**The production host serving `dist/` must send the same two headers**, or
the collection store fails to open in prod even though the rest of the app
(OpenCV, camera, matching) still works fine. See the README's deploy section.

### Offline / service worker

No changes were needed to `src/sw.ts` or `vite.config.ts`. The Turso WASM
binary is emitted as a plain `*.wasm` asset and its worker chunk as a plain
`*.js` asset, so the existing generic rules already cover them:

- `sw.ts`'s cache-first rule for any `.wasm` path.
- `sw.ts`'s stale-while-revalidate rule for `.js`/`.css`/`.svg`.

Verify this still holds after upgrading the Turso package by checking the
`dist/assets/` output of `deno task build` for the emitted `.wasm`/worker
filenames.

## Testing

`@tursodatabase/database` (the native Node binding, dev-only dependency) and
`@tursodatabase/database-wasm` share the same `DatabasePromise` base class
and SQL semantics (see `@tursodatabase/database-common`). This lets
`store.ts`'s real SQL/business logic be tested under `deno test` against real
SQLite, without a browser or OPFS:

```ts
// open(path, driver) — driver defaults to the WASM connect(), tests inject
// the Node native connect() instead.
await collectionStore.open(tempPath, nodeConnect);
```

See `tests/store_test.ts`. Run with:

```sh
deno test -A tests/store_test.ts
```

What this **does not** cover (requires a real browser, manual verification):
OPFS persistence across reloads, the single-tab lock error, and the Vite
WASM/worker wiring in a real production build.

## Dependencies

Added to `deno.json` `imports`:

- `@tursodatabase/database-wasm` — runtime driver (browser/OPFS).
- `@tursodatabase/database` — dev-only, used exclusively by
  `tests/store_test.ts` for the Node-native test driver.
