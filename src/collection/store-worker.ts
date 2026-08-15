/// <reference lib="webworker" />
/**
 * Store worker: hosts the real, persisted collection database.
 *
 * OPFS persistence via @sqlite.org/sqlite-wasm's `opfs-sahpool` VFS is only
 * usable from inside a Worker (see docs/turso_wasm_hang_and_alternatives.md
 * for why). This worker owns the actual `sqlite3.oo1.DB` instance and runs
 * `StoreCore`'s synchronous SQL logic against it; `store.ts` on the main
 * thread is a thin RPC client that talks to this worker over
 * `postMessage()`.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { OpfsSAHPoolDatabase, SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import { type Sqlite3Db, StoreCore } from "./store-core.ts";

let poolUtil: SAHPoolUtil | null = null;
let db: OpfsSAHPoolDatabase | null = null;
let store: StoreCore | null = null;
let currentPath = "";

async function ensurePool(): Promise<SAHPoolUtil> {
  if (!poolUtil) {
    const sqlite3 = await sqlite3InitModule();
    poolUtil = await sqlite3.installOpfsSAHPoolVfs({});
  }
  return poolUtil;
}

async function open(path: string): Promise<void> {
  const pool = await ensurePool();
  db?.close();
  currentPath = path;
  db = new pool.OpfsSAHPoolDb(path);
  store = new StoreCore(db as unknown as Sqlite3Db);
}

function close(): void {
  db?.close();
  db = null;
  store = null;
}

function exportBytes(): Promise<Uint8Array> {
  if (!poolUtil) throw new Error("Store is not open");
  return poolUtil.exportFile(currentPath);
}

async function importBytes(bytes: Uint8Array): Promise<{ folders: number; cards: number }> {
  const pool = await ensurePool();
  close();
  try {
    await pool.importDb(currentPath, bytes);
  } catch (err) {
    // Reopen the live db as it was before the failed import attempt — the
    // caller (export.ts) expects the collection to survive an invalid
    // upload untouched.
    db = new pool.OpfsSAHPoolDb(currentPath);
    store = new StoreCore(db as unknown as Sqlite3Db);
    throw err;
  }
  db = new pool.OpfsSAHPoolDb(currentPath);
  store = new StoreCore(db as unknown as Sqlite3Db);
  return { folders: store.getAllFolders().length, cards: store.getAllCards().length };
}

interface RpcRequest {
  id: number;
  method: string;
  args: unknown[];
}

self.onmessage = async (event: MessageEvent<RpcRequest>) => {
  const { id, method, args } = event.data;
  try {
    let result: unknown;
    switch (method) {
      case "open":
        await open(args[0] as string);
        break;
      case "close":
        close();
        break;
      case "exportBytes":
        result = await exportBytes();
        break;
      case "importBytes":
        result = await importBytes(args[0] as Uint8Array);
        break;
      default: {
        if (!store) throw new Error(`Store is not open (called ${method})`);
        // deno-lint-ignore no-explicit-any
        result = (store as any)[method](...args);
      }
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
