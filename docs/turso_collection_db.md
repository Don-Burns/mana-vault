# Turso (SQLite/WASM) Collection Store — superseded

**This document is historical.** The collection store no longer uses Turso.
It migrated to `@sqlite.org/sqlite-wasm` (the official SQLite WASM build)
with the `opfs-sahpool` VFS, running inside a dedicated Worker
(`src/collection/store-worker.ts`), talked to from the main thread via a
small hand-rolled RPC client (`src/collection/store.ts`). See
`docs/turso_wasm_hang_and_alternatives.md` for the full story: the bug in
Turso's WASM driver that motivated the switch, the alternatives considered,
and the new architecture.

Notably, the migration also **removed the COOP/COEP header requirement**
described below — `opfs-sahpool` doesn't need `SharedArrayBuffer`, so
`src/sw.ts`'s header injection, `src/main.ts`'s forced-reload-on-isolation
logic, and `vite.config.ts`'s dev-server headers were all deleted. There is
no longer any special production hosting requirement for the collection
store; a plain static file server is enough.

---

The sections below describe the original Turso-based implementation, kept
for historical context (e.g. if the git history needs explaining).

## Why Turso-in-the-browser (original rationale)

- Persists to **OPFS** → fully local, offline-first is preserved.
- API mirrors `better-sqlite3` but is fully async (`prepare/run/get/all`),
  matching the store's existing async public API — no consumer changes.
- Lets the collection logic be tested against **real SQLite** outside the
  browser, which IndexedDB never allowed.

## Runtime driver: `@tursodatabase/database-wasm`

`store.ts` imported `connect` from the `/vite` subpath export, which shipped
Vite-specific WASM + Web Worker wiring, callable directly from the main
thread (Turso's driver hid its own internal worker/`SharedArrayBuffer`
bridge). This turned out to be one of the reasons it was replaced: the
official `@sqlite.org/sqlite-wasm` build requires client code to explicitly
own the Worker boundary itself, which is more code up front but avoids the
driver bug described in `docs/turso_wasm_hang_and_alternatives.md`.

### Single-tab lock

Turso's OPFS sync access handle locked the database file to **one tab**,
same as the current `opfs-sahpool` VFS.

### Never open two connections at once (export/import)

`@tursodatabase/database-wasm` ran a **single page-wide Worker** and every
`Database` connection shared one module-scoped `IONotifier` instance. This
was a real missed-wakeup race: two concurrent connections could cause one to
hang indefinitely waiting on a notification that had already fired for the
other connection. `exportAsDB()`/`importFromDB()` worked around this by
never having two connections open at once — closing the live connection
before opening any scratch connection. This constraint doesn't apply to the
current architecture (import/export now go through the store worker's
`exportBytes`/`importBytes`, a single connection throughout).

## Testing (original approach)

`@tursodatabase/database` (the native Node binding) and
`@tursodatabase/database-wasm` shared the same SQL semantics, letting
`store.ts`'s SQL/business logic be tested under `deno test` against real
SQLite without a browser. The current architecture achieves the same thing
differently: `src/collection/store-core.ts` holds all the SQL/business
logic independent of Workers/OPFS, and `tests/test-store.ts` runs it against
an in-memory `sqlite3.oo1.DB` (see the new doc for details).
