/**
 * Test-only async wrapper around StoreCore + an in-memory sqlite3.oo1.DB.
 *
 * Exercises the exact same SQL/business logic (`store-core.ts`) that the
 * real app runs inside its store worker (`store-worker.ts`), just without
 * the Worker/OPFS layer — sqlite-wasm's Node build only supports in-memory
 * databases, which is all these tests need (see
 * docs/turso_wasm_hang_and_alternatives.md). Method names mirror
 * `StoreCore` exactly; each one is wrapped in a Promise purely so existing
 * `await`-based test code doesn't need to change.
 */

import initSqlite3 from "@sqlite.org/sqlite-wasm";
import type { Database } from "@sqlite.org/sqlite-wasm";
import {
  type CardEntry,
  type CollectionSnapshot,
  type Folder,
  readSnapshot,
  type Sqlite3Db,
  type StagingItem,
  StoreCore,
  writeSnapshot,
} from "../src/collection/store-core.ts";

export type {
  CardCondition,
  CardEntry,
  CollectionSnapshot,
  Folder,
  StagingItem,
} from "../src/collection/store-core.ts";

let sqlite3Promise: ReturnType<typeof initSqlite3> | null = null;

export class TestStore {
  private db: Database | null = null;
  private core: StoreCore | null = null;

  async open(): Promise<void> {
    if (!sqlite3Promise) sqlite3Promise = initSqlite3();
    const sqlite3 = await sqlite3Promise;
    this.db = new sqlite3.oo1.DB(":memory:", "c");
    this.core = new StoreCore(this.db as unknown as Sqlite3Db);
  }

  private get store(): StoreCore {
    if (!this.core) throw new Error("TestStore is not open");
    return this.core;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
    this.core = null;
  }

  async snapshot(): Promise<CollectionSnapshot> {
    return readSnapshot(this.db as unknown as Sqlite3Db);
  }

  async loadSnapshot(data: CollectionSnapshot): Promise<void> {
    writeSnapshot(this.db as unknown as Sqlite3Db, data);
  }

  async ensureDefaultFolder() {
    return this.store.ensureDefaultFolder();
  }
  async getAllFolders() {
    return this.store.getAllFolders();
  }
  async getFolder(id: string) {
    return this.store.getFolder(id);
  }
  async createFolder(name: string, color?: string) {
    return this.store.createFolder(name, color);
  }
  async putFolder(folder: Folder) {
    return this.store.putFolder(folder);
  }
  async deleteFolder(id: string) {
    return this.store.deleteFolder(id);
  }
  async renameFolder(id: string, newName: string) {
    return this.store.renameFolder(id, newName);
  }
  async reorderFolders(orderedIds: string[]) {
    return this.store.reorderFolders(orderedIds);
  }
  async getFolderCardCount(folderId: string) {
    return this.store.getFolderCardCount(folderId);
  }
  async getCardsByFolder(folderId: string) {
    return this.store.getCardsByFolder(folderId);
  }
  async getCard(id: string) {
    return this.store.getCard(id);
  }
  async putCard(card: CardEntry) {
    return this.store.putCard(card);
  }
  async deleteCard(id: string) {
    return this.store.deleteCard(id);
  }
  async getAllCards() {
    return this.store.getAllCards();
  }
  async getTotalCardCount() {
    return this.store.getTotalCardCount();
  }
  async commitAdd(folderId: string, items: readonly StagingItem[]) {
    return this.store.commitAdd(folderId, items);
  }
  async commitRemove(
    folderId: string,
    items: readonly { scryfallId: string; illustrationId: string; quantity: number }[],
  ) {
    return this.store.commitRemove(folderId, items);
  }
  async commitMove(
    sourceFolderId: string,
    destinationFolderId: string,
    items: readonly { scryfallId: string; illustrationId: string; quantity: number }[],
  ) {
    return this.store.commitMove(sourceFolderId, destinationFolderId, items);
  }
}
