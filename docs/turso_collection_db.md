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

### Never open two connections at once (export/import)

`@tursodatabase/database-wasm` runs a **single page-wide Worker**, set up
once at module load (`index-default.js`'s top-level `setupMainThread`
singleton), and every `Database` connection — the live one and any scratch
connection — shares one module-scoped `IONotifier` instance
(`@tursodatabase/database-wasm-common`). Each connection's internal step
loop does `await ioNotifier.waitForCompletion()` when it hits a pending
async I/O op, and any connection's op finishing calls the *same* shared
`notify()`, waking every waiter.

This is a real missed-wakeup race: if a step loop's async I/O completes and
calls `notify()` in the gap before that loop has registered its own waiter,
the wakeup is lost — the connection then hangs until some *other*
connection happens to do I/O and calls `notify()` again. With two
concurrent connections (e.g. a scratch db opened for export while the live
one is idle) this can hang indefinitely with no error, only resolving once
an unrelated later db call on the *other* connection fires. This actually
happened: `exportAsDB()`/`importFromDB()` used to open a second ("scratch")
connection while the live one was still open, and export would sometimes
hang until the next unrelated write (e.g. adding a card) happened to wake
it back up.

**Rule going forward: never have two `Database` connections open at the
same time in this app.** `collection/export.ts`'s `exportAsDB()` and
`importFromDB()` now `checkpointWal()` + `close()` the live connection
before opening any scratch connection or reading the db file's raw bytes,
and reopen it in a `finally`. This is also strictly simpler/faster for
export than the old approach (a plain OPFS file read instead of an
in-memory copy into a scratch db). The UI (`collection-view.ts`) shows a
full-view busy overlay blocking all folder/card mutation while the live
connection is briefly closed during export/import.

If a future feature seems to need two connections open concurrently
(e.g. a second scratch db for some other reason), don't — sequence the
work so only one connection is ever open, or this bug class recurs. This is
a constraint of the vendored driver, not something fixable in our code.

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
