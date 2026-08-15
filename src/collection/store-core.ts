/**
 * Collection store: core SQL/business logic, storage-engine agnostic.
 *
 * Runs against any `sqlite3.oo1.DB`-compatible instance (the same
 * synchronous Object-Oriented API #1 that @sqlite.org/sqlite-wasm exposes
 * for in-memory Node/Deno testing, and for `OpfsSAHPoolDatabase` inside the
 * real browser worker). This file has zero knowledge of Workers, OPFS, or
 * RPC — see `store-worker.ts` for the browser-side worker that hosts this
 * against a real persisted db, and `store.ts` for the main-thread RPC
 * client that talks to that worker.
 */

import {
  clampToSource,
  computeDiff,
  type DiffRow,
  findMatch,
  simulateAdd,
  simulateRemove,
} from "./diff.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT,
    color TEXT,
    sortOrder INTEGER,
    createdAt TEXT,
    isDefault INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_folders_sortOrder ON folders(sortOrder);
  CREATE INDEX IF NOT EXISTS idx_folders_name ON folders(name);

  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    folderId TEXT,
    scryfallId TEXT,
    illustrationId TEXT,
    oracleId TEXT,
    name TEXT,
    setCode TEXT,
    setName TEXT,
    collectorNumber TEXT,
    quantity INTEGER,
    condition TEXT,
    notes TEXT,
    dateAdded TEXT,
    cmc REAL,
    colors TEXT,
    rarity TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cards_folderId ON cards(folderId);
  CREATE INDEX IF NOT EXISTS idx_cards_scryfallId ON cards(scryfallId);
  CREATE INDEX IF NOT EXISTS idx_cards_illustrationId ON cards(illustrationId);
  CREATE INDEX IF NOT EXISTS idx_cards_oracleId ON cards(oracleId);
  CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
  CREATE INDEX IF NOT EXISTS idx_cards_folder_scryfall ON cards(folderId, scryfallId);
`;

// Columns added after the initial schema. New installs get them via SCHEMA
// above; existing databases get them via this guarded ALTER TABLE list.
const MIGRATIONS = [
  "ALTER TABLE cards ADD COLUMN cmc REAL",
  "ALTER TABLE cards ADD COLUMN colors TEXT",
  "ALTER TABLE cards ADD COLUMN rarity TEXT",
];

export type CardCondition = "NM" | "LP" | "MP" | "HP" | "DMG";

export interface Folder {
  id: string;
  name: string;
  color: string; // CSS color for visual distinction
  sortOrder: number;
  createdAt: string;
  isDefault?: boolean; // True for the "Unsorted" folder
}

export interface CardEntry {
  id: string;
  folderId: string;
  scryfallId: string; // Exact printing identifier
  illustrationId: string; // For art matching
  oracleId: string; // Logical card identity
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  quantity: number;
  condition: CardCondition;
  notes: string;
  dateAdded: string;
  cmc?: number;
  colors?: string[];
  rarity?: string;
}

/** A staged card's fields, independent of which folder it lands in. */
export type StagingItem = Omit<
  CardEntry,
  "id" | "folderId" | "dateAdded" | "notes"
>;

/** The subset of sqlite3.oo1.DB's API this file relies on. */
export interface Sqlite3Db {
  exec(sql: string | { sql: string; bind?: unknown }): unknown;
  selectObjects(sql: string, bind?: unknown): Record<string, unknown>[];
  selectValue(sql: string, bind?: unknown): unknown;
  transaction<T>(callback: (db: Sqlite3Db) => T): T;
}

const FOLDER_COLUMNS = "id, name, color, sortOrder, createdAt, isDefault";
const FOLDER_VALUES = "(:id, :name, :color, :sortOrder, :createdAt, :isDefault)";
const CARD_COLUMNS =
  "id, folderId, scryfallId, illustrationId, oracleId, name, setCode, setName, collectorNumber, quantity, condition, notes, dateAdded, cmc, colors, rarity";
const CARD_VALUES =
  "(:id, :folderId, :scryfallId, :illustrationId, :oracleId, :name, :setCode, :setName, :collectorNumber, :quantity, :condition, :notes, :dateAdded, :cmc, :colors, :rarity)";

function folderParams(folder: Folder): Record<string, unknown> {
  return {
    ":id": folder.id,
    ":name": folder.name,
    ":color": folder.color,
    ":sortOrder": folder.sortOrder,
    ":createdAt": folder.createdAt,
    ":isDefault": folder.isDefault ? 1 : 0,
  };
}

function folderFromRow(row: Record<string, unknown>): Folder {
  return {
    id: row.id as string,
    name: row.name as string,
    color: row.color as string,
    sortOrder: row.sortOrder as number,
    createdAt: row.createdAt as string,
    isDefault: row.isDefault === 1,
  };
}

function cardParams(card: CardEntry): Record<string, unknown> {
  return {
    ":id": card.id,
    ":folderId": card.folderId,
    ":scryfallId": card.scryfallId,
    ":illustrationId": card.illustrationId,
    ":oracleId": card.oracleId,
    ":name": card.name,
    ":setCode": card.setCode,
    ":setName": card.setName,
    ":collectorNumber": card.collectorNumber,
    ":quantity": card.quantity,
    ":condition": card.condition,
    ":notes": card.notes,
    ":dateAdded": card.dateAdded,
    ":cmc": card.cmc ?? null,
    ":colors": card.colors ? JSON.stringify(card.colors) : null,
    ":rarity": card.rarity ?? null,
  };
}

function cardFromRow(row: Record<string, unknown>): CardEntry {
  return {
    id: row.id as string,
    folderId: row.folderId as string,
    scryfallId: row.scryfallId as string,
    illustrationId: row.illustrationId as string,
    oracleId: row.oracleId as string,
    name: row.name as string,
    setCode: row.setCode as string,
    setName: row.setName as string,
    collectorNumber: row.collectorNumber as string,
    quantity: row.quantity as number,
    condition: row.condition as CardCondition,
    notes: row.notes as string,
    dateAdded: row.dateAdded as string,
    cmc: row.cmc == null ? undefined : (row.cmc as number),
    colors: row.colors ? JSON.parse(row.colors as string) : undefined,
    rarity: row.rarity == null ? undefined : (row.rarity as string),
  };
}

export interface CollectionSnapshot {
  folders: Folder[];
  cards: CardEntry[];
}

export function readSnapshot(db: Sqlite3Db): CollectionSnapshot {
  return {
    folders: db.selectObjects("SELECT * FROM folders ORDER BY sortOrder").map(folderFromRow),
    cards: db.selectObjects("SELECT * FROM cards").map(cardFromRow),
  };
}

export function writeSnapshot(db: Sqlite3Db, data: CollectionSnapshot): void {
  db.transaction((tx) => {
    tx.exec("DELETE FROM cards; DELETE FROM folders;");
    for (const folder of data.folders) {
      tx.exec({
        sql: `INSERT INTO folders (${FOLDER_COLUMNS}) VALUES ${FOLDER_VALUES}`,
        bind: folderParams(folder),
      });
    }
    for (const card of data.cards) {
      tx.exec({
        sql: `INSERT INTO cards (${CARD_COLUMNS}) VALUES ${CARD_VALUES}`,
        bind: cardParams(card),
      });
    }
  });
}

export function initSchema(db: Sqlite3Db): void {
  db.exec(SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Column already exists — fine, this is a guarded no-op migration.
    }
  }
}

/**
 * Core CRUD + diff-based commit logic for the collection, synchronous and
 * storage-engine agnostic. Deliberately has no `open`/`close`/driver
 * concerns — the caller (worker or test) owns the `Sqlite3Db` lifetime.
 */
export class StoreCore {
  constructor(private db: Sqlite3Db) {
    initSchema(this.db);
  }

  // ─── Folders ───────────────────────────────────────────────

  ensureDefaultFolder(): void {
    if (this.getAllFolders().length > 0) return;
    this.putFolder({
      id: crypto.randomUUID(),
      name: "Unsorted",
      color: "#666",
      sortOrder: 0,
      createdAt: new Date().toISOString(),
      isDefault: true,
    });
  }

  getAllFolders(): Folder[] {
    return this.db.selectObjects("SELECT * FROM folders ORDER BY sortOrder").map(folderFromRow);
  }

  getFolder(id: string): Folder | undefined {
    const rows = this.db.selectObjects("SELECT * FROM folders WHERE id = :id", { ":id": id });
    return rows[0] ? folderFromRow(rows[0]) : undefined;
  }

  createFolder(name: string, color = "#0f3460"): Folder {
    const maxOrder = this.getAllFolders().reduce((max, f) => Math.max(max, f.sortOrder), -1);
    const folder: Folder = {
      id: crypto.randomUUID(),
      name,
      color,
      sortOrder: maxOrder + 1,
      createdAt: new Date().toISOString(),
    };
    this.putFolder(folder);
    return folder;
  }

  putFolder(folder: Folder): void {
    this.db.exec({
      sql: `INSERT INTO folders (${FOLDER_COLUMNS}) VALUES ${FOLDER_VALUES}
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              color = excluded.color,
              sortOrder = excluded.sortOrder,
              createdAt = excluded.createdAt,
              isDefault = excluded.isDefault`,
      bind: folderParams(folder),
    });
  }

  deleteFolder(id: string): void {
    if (this.getCardsByFolder(id).length > 0) {
      throw new Error("Cannot delete a folder that still contains cards");
    }
    this.db.exec({ sql: "DELETE FROM folders WHERE id = :id", bind: { ":id": id } });
  }

  renameFolder(id: string, newName: string): void {
    const folder = this.getFolder(id);
    if (!folder) throw new Error(`Folder not found: ${id}`);
    this.putFolder({ ...folder, name: newName });
  }

  reorderFolders(orderedIds: string[]): void {
    orderedIds.forEach((id, index) => {
      const folder = this.getFolder(id);
      if (!folder) return;
      this.putFolder({ ...folder, sortOrder: index });
    });
  }

  getFolderCardCount(folderId: string): number {
    return Number(
      this.db.selectValue("SELECT COALESCE(SUM(quantity), 0) FROM cards WHERE folderId = :folderId", {
        ":folderId": folderId,
      }),
    );
  }

  // ─── Cards ─────────────────────────────────────────────────

  getCardsByFolder(folderId: string): CardEntry[] {
    return this.db
      .selectObjects("SELECT * FROM cards WHERE folderId = :folderId", { ":folderId": folderId })
      .map(cardFromRow);
  }

  getCard(id: string): CardEntry | undefined {
    const rows = this.db.selectObjects("SELECT * FROM cards WHERE id = :id", { ":id": id });
    return rows[0] ? cardFromRow(rows[0]) : undefined;
  }

  putCard(card: CardEntry): void {
    this.db.exec({
      sql: `INSERT INTO cards (${CARD_COLUMNS}) VALUES ${CARD_VALUES}
            ON CONFLICT(id) DO UPDATE SET
              folderId = excluded.folderId,
              scryfallId = excluded.scryfallId,
              illustrationId = excluded.illustrationId,
              oracleId = excluded.oracleId,
              name = excluded.name,
              setCode = excluded.setCode,
              setName = excluded.setName,
              collectorNumber = excluded.collectorNumber,
              quantity = excluded.quantity,
              condition = excluded.condition,
              notes = excluded.notes,
              dateAdded = excluded.dateAdded,
              cmc = excluded.cmc,
              colors = excluded.colors,
              rarity = excluded.rarity`,
      bind: cardParams(card),
    });
  }

  deleteCard(id: string): void {
    this.db.exec({ sql: "DELETE FROM cards WHERE id = :id", bind: { ":id": id } });
  }

  getAllCards(): CardEntry[] {
    return this.db.selectObjects("SELECT * FROM cards").map(cardFromRow);
  }

  getTotalCardCount(): number {
    return Number(this.db.selectValue("SELECT COALESCE(SUM(quantity), 0) as total FROM cards"));
  }

  // ─── Staging commits (diff-based) ─────────────────────────

  commitAdd(folderId: string, items: readonly StagingItem[]): { applied: number } {
    const before = this.getCardsByFolder(folderId);
    const after = simulateAdd(before, items, (item) => ({
      ...item,
      id: crypto.randomUUID(),
      folderId,
      notes: "",
      dateAdded: new Date().toISOString(),
    }));
    this.applyCardDiffs([{ folderId, diff: computeDiff(before, after) }]);
    return { applied: items.length };
  }

  commitRemove(
    folderId: string,
    items: readonly { scryfallId: string; illustrationId: string; quantity: number }[],
  ): { applied: number; skipped: number } {
    const before = this.getCardsByFolder(folderId);
    const after = simulateRemove(before, items);
    const skipped = items.filter((i) => !findMatch(before, i)).length;
    this.applyCardDiffs([{ folderId, diff: computeDiff(before, after) }]);
    return { applied: items.length - skipped, skipped };
  }

  commitMove(
    sourceFolderId: string,
    destinationFolderId: string,
    items: readonly { scryfallId: string; illustrationId: string; quantity: number }[],
  ): { applied: number; skipped: number } {
    const sourceBefore = this.getCardsByFolder(sourceFolderId);
    const destBefore = this.getCardsByFolder(destinationFolderId);
    const clamped = clampToSource(sourceBefore, items);
    const skipped = items.length - clamped.length;

    const sourceAfter = simulateRemove(sourceBefore, clamped);
    const destAfter = simulateAdd(
      destBefore,
      clamped,
      (card): CardEntry => ({
        ...card,
        id: crypto.randomUUID(),
        folderId: destinationFolderId,
        notes: "",
        dateAdded: new Date().toISOString(),
      }),
    );

    this.applyCardDiffs([
      { folderId: sourceFolderId, diff: computeDiff(sourceBefore, sourceAfter) },
      { folderId: destinationFolderId, diff: computeDiff(destBefore, destAfter) },
    ]);
    return { applied: items.length - skipped, skipped };
  }

  /**
   * Apply precomputed before/after diffs for one or more folders as a
   * single atomic transaction: one INSERT/UPDATE/DELETE per changed row.
   * See docs/turso_wasm_hang_and_alternatives.md for why this stayed
   * unbatched (a multi-row-statement version was tried against the old
   * Turso driver and didn't help there — moot now: the real SQLite WASM
   * build doesn't have that hang at all, see the same doc).
   */
  applyCardDiffs(diffs: { folderId: string; diff: DiffRow<CardEntry>[] }[]): void {
    this.db.transaction((tx) => {
      for (const { folderId, diff } of diffs) {
        for (const row of diff) {
          if (row.kind === "unchanged") continue;
          if (row.kind === "removed") {
            tx.exec({ sql: "DELETE FROM cards WHERE id = :id", bind: { ":id": row.card.id } });
          } else if (row.kind === "added") {
            tx.exec({
              sql: `INSERT INTO cards (${CARD_COLUMNS}) VALUES ${CARD_VALUES}`,
              bind: cardParams({ ...row.card, folderId, quantity: row.after }),
            });
          } else {
            tx.exec({
              sql: "UPDATE cards SET quantity = :quantity WHERE id = :id",
              bind: { ":quantity": row.after, ":id": row.card.id },
            });
          }
        }
      }
    });
  }
}
