/**
 * Collection store: main-thread RPC client.
 *
 * The actual SQLite/OPFS work happens in a dedicated Worker (see
 * `store-worker.ts`) — `@sqlite.org/sqlite-wasm`'s OPFS support only works
 * inside a Worker thread, unlike the previous Turso driver which hid its
 * own worker/SharedArrayBuffer bridge behind a main-thread-callable async
 * API. See docs/turso_wasm_hang_and_alternatives.md for the full story.
 *
 * This class is a thin hand-rolled RPC client: each public method posts
 * `{id, method, args}` to the worker and resolves/rejects a Promise when a
 * matching `{id, result}`/`{id, error}` response arrives. Method names and
 * signatures mirror `StoreCore` (see store-core.ts) exactly, so this file
 * has no business logic of its own.
 */

export type {
  CardCondition,
  CardEntry,
  CollectionSnapshot,
  Folder,
  StagingItem,
} from "./store-core.ts";
import type { CardEntry, Folder, StagingItem } from "./store-core.ts";
import type { DiffRow } from "./diff.ts";

export const DB_PATH = "/mana-vault.db";

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}

class CollectionStore {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = new Worker(new URL("./store-worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<RpcResponse>) => {
        const { id, result, error } = event.data;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
      };
      this.worker = worker;
    }
    return this.worker;
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, method, args });
    });
  }

  open(path: string = DB_PATH): Promise<void> {
    return this.call("open", path);
  }

  close(): Promise<void> {
    return this.call("close");
  }

  exportBytes(): Promise<Uint8Array> {
    return this.call("exportBytes");
  }

  importBytes(bytes: Uint8Array): Promise<{ folders: number; cards: number }> {
    return this.call("importBytes", bytes);
  }

  ensureDefaultFolder(): Promise<void> {
    return this.call("ensureDefaultFolder");
  }

  getAllFolders(): Promise<Folder[]> {
    return this.call("getAllFolders");
  }

  getFolder(id: string): Promise<Folder | undefined> {
    return this.call("getFolder", id);
  }

  createFolder(name: string, color?: string): Promise<Folder> {
    return this.call("createFolder", name, color);
  }

  putFolder(folder: Folder): Promise<void> {
    return this.call("putFolder", folder);
  }

  deleteFolder(id: string): Promise<void> {
    return this.call("deleteFolder", id);
  }

  renameFolder(id: string, newName: string): Promise<void> {
    return this.call("renameFolder", id, newName);
  }

  reorderFolders(orderedIds: string[]): Promise<void> {
    return this.call("reorderFolders", orderedIds);
  }

  getFolderCardCount(folderId: string): Promise<number> {
    return this.call("getFolderCardCount", folderId);
  }

  getCardsByFolder(folderId: string): Promise<CardEntry[]> {
    return this.call("getCardsByFolder", folderId);
  }

  getCard(id: string): Promise<CardEntry | undefined> {
    return this.call("getCard", id);
  }

  putCard(card: CardEntry): Promise<void> {
    return this.call("putCard", card);
  }

  deleteCard(id: string): Promise<void> {
    return this.call("deleteCard", id);
  }

  getAllCards(): Promise<CardEntry[]> {
    return this.call("getAllCards");
  }

  getTotalCardCount(): Promise<number> {
    return this.call("getTotalCardCount");
  }

  commitAdd(folderId: string, items: readonly StagingItem[]): Promise<{ applied: number }> {
    return this.call("commitAdd", folderId, items);
  }

  commitRemove(
    folderId: string,
    items: readonly { scryfallId: string; illustrationId: string; quantity: number }[],
  ): Promise<{ applied: number; skipped: number }> {
    return this.call("commitRemove", folderId, items);
  }

  commitMove(
    sourceFolderId: string,
    destinationFolderId: string,
    items: readonly { scryfallId: string; illustrationId: string; quantity: number }[],
  ): Promise<{ applied: number; skipped: number }> {
    return this.call("commitMove", sourceFolderId, destinationFolderId, items);
  }

  applyCardDiffs(diffs: { folderId: string; diff: DiffRow<CardEntry>[] }[]): Promise<void> {
    return this.call("applyCardDiffs", diffs);
  }
}

export const collectionStore = new CollectionStore();
