# Turso WASM Driver Hang: Root Cause and Migration to sqlite-wasm

This documents a real bug in `@tursodatabase/database-wasm` (0.7.2, the
version that was pinned in `deno.json`) that caused large single-transaction
writes to hang forever in the real browser/OPFS driver, the mitigation that
shipped first, and the eventual migration to
[`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm/doc/trunk/index.md) that
replaced Turso entirely and removed the limitation. See
`docs/turso_collection_db.md` for the (now superseded) original Turso
migration and its other OPFS gotchas.

## The bug

`applyCardDiffs` (`src/collection/store.ts`) applies a batch of card
inserts/updates/deletes as one atomic transaction — e.g. "select all, move to
another folder" moves every selected card in a single `commitMove` call.
Empirically, in a real browser against the OPFS driver, transactions
affecting roughly **400-500+ rows hang indefinitely** with no error, no
timeout, nothing in the console. Node's native driver
(`@tursodatabase/database`, used by `tests/*.ts`) never reproduces this —
its `ioStep` is a no-op — so the unit tests were blind to the bug entirely
until an end-to-end test against a real browser was written
(`e2e/collection-move-performance.spec.ts`).

Root cause (confirmed against upstream issues
[turso#8171](https://github.com/tursodatabase/turso/issues/8171) (fixed) and
[turso#8341](https://github.com/tursodatabase/turso/issues/8341) (open, this
variant)): the WASM/OPFS driver's `stepSync()` returns the same `STEP_IO`
result code for two different situations — real pending OPFS I/O, and a
plain internal "Yield" re-poll signal that carries no I/O at all. The driver
only knows how to wake up on a real I/O completion notification, so an
untracked Yield parks the step loop on `ioNotifier.waitForCompletion()`
forever. This is a bug in the vendored driver, not something fixable from
application code except by racing it.

### Bisection notes (single transaction, real browser, WASM/OPFS)

- No fix: hangs at ~150-200 rows in one transaction.
- With `unstickIOStep` alone (per-row statements, see below): pushes the
  threshold to ~490-499 rows (423 fine, 425 hangs — not a clean boundary,
  consistent with an inherently racy bug).
- Multi-row batching (chunking rows into fewer, larger `INSERT`/`UPDATE`/
  `DELETE` statements via `tx.batch()`): **did not move the threshold**
  (420 fine, 425 hangs, same as unbatched). Proved the hang is gated by
  total rows/pages touched in the transaction, not statement count or SQL
  shape.
- A single set-based `INSERT INTO cards (...) SELECT ... FROM staging_table`
  (one statement, one transaction, 500 pre-staged rows): **still hangs**,
  confirming the above — no SQL-shape trick dodges it.

Conclusion: batching/staging-table approaches were tried and abandoned
because they don't raise the safe ceiling at all. Only two things actually
help: racing the hang (mitigation, ships today) or replacing the driver
(alternative, not yet done — see below).

## What shipped first: `unstickIOStep` (since removed)

While still on Turso, `src/collection/store.ts` monkey-patched every
driver-opened `Database` instance's private `ioStep` method to race the
original call against a 25ms timer, resolving on whichever settles first.
This was a **mitigation, not a fix**: it raised the safe ceiling from
~150-200 rows to ~490 rows per transaction, covering the overwhelmingly
common case (normal single-card and small-batch add/move flows), but:

- **Known residual limitation at the time**: single-transaction operations
  affecting ~490+ rows still hung in the real browser. A literal "select
  500 cards, move to another folder" failed
  `e2e/collection-move-performance.spec.ts`'s 1-second budget — that test
  was left in the repo, failing, to document this precisely (it failed
  fast, in ~6s, with a clear message, not a raw 30s+ timeout).
- Multi-row batching in `applyCardDiffs` was implemented, verified against
  unit tests, and then reverted once a spike proved it didn't raise the
  ceiling — not worth the extra complexity for no benefit.

This code no longer exists — the migration below replaced Turso entirely,
which removed the bug rather than just working around it.

## Alternative considered: swap the SQL/storage engine

Turso is a from-scratch reimplementation of SQLite in Rust; it's young, and
this class of WASM-driver bug is a symptom of that. The official
[`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm/doc/trunk/index.md)
package — the actual SQLite C code compiled to WASM, maintained by the
SQLite project itself — is a much more mature OPFS implementation and does
not share Turso's WASM-specific driver internals.

### Spike: does it actually avoid the hang?

A throwaway Playwright test (not committed — probe files are deleted after
use per this repo's convention) loaded `@sqlite.org/sqlite-wasm` in a
dedicated Worker, installed the `opfs-sahpool` VFS, and ran a single
transaction inserting N rows:

| Rows   | Result                              |
|--------|--------------------------------------|
| 500    | **~19.5ms**, no hang                 |
| 20,000 | **~152ms**, no hang (40x the row count that breaks Turso) |

Decisive result: the hang is specific to Turso's WASM driver, not a
fundamental OPFS/browser limitation. The official SQLite WASM build handles
the same (and far larger) workloads without issue, and dramatically faster.

### `opfs` vs `opfs-sahpool`

Both are real OPFS-backed persistence for `@sqlite.org/sqlite-wasm`, neither
has Turso's `stepSync`/`ioStep` bug. They differ in locking strategy and
deployment requirements:

| | `opfs` (default) | `opfs-sahpool` |
|---|---|---|
| Needs COOP/COEP headers (`SharedArrayBuffer`) | Yes — same requirement Turso has today | **No** |
| Multi-tab concurrency | Yes, with retry-on-`SQLITE_BUSY` (docs report 8-10 concurrent workers handled in 2026 testing, given short transactions) | **No** — a second tab's `installOpfsSAHPoolVfs()` call fails outright unless the app implements the newer pause/unpause cooperative-handoff API (3.50+) |
| Filesystem transparency | Client filenames map 1:1 to real OPFS files — inspectable via devtools/OPFS Explorer | No — manages its own private name→file mapping; import/export must go through its `importDb`/`exportFile` API, not raw OPFS byte access |
| Performance | Slower than sahpool for batch-heavy workloads (per docs; not benchmarked here) | **Fastest of the OPFS options** (confirmed: 20,000-row transaction in ~152ms) |

**Decision: `opfs-sahpool`.** This app is already effectively single-tab —
`main.ts` closes the connection on `pagehide` specifically because OPFS
forbids reopening a file while a handle elsewhere is open, so the
no-multi-tab-concurrency limitation isn't a regression from where the app
already is. Dropping COOP/COEP is a genuine simplification independent of
the hang fix: it deletes the `coi-serviceworker`-style header injection in
`src/sw.ts` (`withCoiHeaders`, wrapping every response) and the associated
forced-reload-after-`serviceWorker.ready` dance in `src/main.ts`
(`ensureCrossOriginIsolated`) — both exist *only* because Turso's WASM
binary needs `SharedArrayBuffer`.

## Why this is a bigger change than "swap the driver"

Turso's WASM driver lets you `connect()` and await its async API directly
from the **main thread** — it manages its own internal worker/
`SharedArrayBuffer` bridge invisibly. `@sqlite.org/sqlite-wasm`'s OPFS
support (both `opfs` and `opfs-sahpool`) requires the SQLite module itself
to be loaded and run **inside a Worker thread** — there is no main-thread
convenience wrapper. Client code must either live in that worker directly,
or talk to it via message-passing.

Today, **the entire app runs on the main thread with no worker boundary
around the store at all**: `src/ui/collection-view.ts` (~20 call sites),
`src/ui/scanner-view.ts` (~10 call sites), `src/main.ts`, and
`src/collection/export.ts` all call `collectionStore` methods directly from
DOM event handlers / app boot code, in-process. (The app's other two
`Worker()` usages — card detection, metadata loading — are unrelated and
don't touch the store.)

The one thing working in our favor: `CollectionStore`'s public methods are
already all async (return Promises), so a driver swap should not require
touching any of those ~30 call sites — only `store.ts`'s internals and
`export.ts` need to change shape.

### Proposed shape (now implemented)

1. A new dedicated Worker (`src/collection/store-worker.ts`) that runs
   `sqlite3.oo1.OpfsSAHPoolDb` synchronously inside the worker.
2. All the actual SQL/schema/transaction logic lives in
   `src/collection/store-core.ts` as a plain synchronous class (`StoreCore`),
   storage-engine agnostic — it only depends on a minimal `Sqlite3Db`
   interface (`exec`/`selectObjects`/`selectValue`/`transaction`), not on
   Workers, OPFS, or RPC at all. `store-worker.ts` instantiates it against
   the real `OpfsSAHPoolDb`; `tests/test-store.ts` instantiates it against
   an in-memory `sqlite3.oo1.DB` for fast non-browser tests.
3. `src/collection/store.ts` is now a thin RPC client: spins up the worker,
   and exposes the exact same public method signatures the UI already
   calls, implemented as a small hand-rolled request/response protocol over
   `postMessage` (`{id, method, args}` in, `{id, result}` or `{id, error}`
   out) — no new dependency. (The SQLite project's own `Worker1`/`Promiser`
   wrapper was considered and rejected: the docs explicitly call it
   deprecated and "too fragile, too imperformant, too limited for any
   non-toy software.")
4. `src/collection/export.ts` was reworked to go through the worker's
   `importDb`/`exportFile` calls (exposed as `exportBytes`/`importBytes` RPC
   methods) instead of raw OPFS byte access, since `opfs-sahpool` manages
   its own private file mapping rather than exposing a real filesystem to
   reach into directly. This also simplified export/import considerably:
   no more checkpoint-WAL/close/scratch-file/reopen dance — `exportBytes`
   works on the live open connection, and `importBytes` closes, imports,
   and reopens entirely inside the worker.
5. `src/sw.ts` and `src/main.ts` had the COOP/COEP injection and forced
   reload removed entirely (`withCoiHeaders`, `ensureCrossOriginIsolated`),
   along with `vite.config.ts`'s dev-server COOP/COEP headers. No special
   hosting requirement remains for the collection store.
6. `deno.json`: the three `@tursodatabase/*` imports were dropped in favor
   of `@sqlite.org/sqlite-wasm`. `tests/*.ts` moved from the Node-native
   Turso driver to `tests/test-store.ts`'s in-memory `sqlite3.oo1.DB`
   wrapper around `StoreCore` (sqlite-wasm's Node build is in-memory-only,
   which is all these tests need).

### Result

`e2e/collection-move-performance.spec.ts` (500-card single-transaction
move) now **passes** — the ~490-row limitation is gone, not just raised.
The same spike numbers from above hold in the real app: no hang observed at
20,000+ rows in one transaction, comfortably above any realistic collection
operation size.

