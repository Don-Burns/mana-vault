/**
 * Collection Store
 *
 * Turso (SQLite/WASM, OPFS-backed) storage for the card collection with
 * folder support. Provides CRUD operations for folders and card entries.
 */

import { connect } from "@tursodatabase/database-wasm/vite";
import type {
  DatabasePromise as Database,
  Transaction,
} from "@tursodatabase/database-common";
import {
  clampToSource,
  computeDiff,
  type DiffRow,
  findMatch,
  simulateAdd,
  simulateRemove,
} from "./diff.ts";

export const DB_PATH = "mana-vault.db";

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

type TursoConnect = (path: string) => Promise<Database>;

const FOLDER_COLUMNS = "id, name, color, sortOrder, createdAt, isDefault";
const FOLDER_VALUES =
  "(:id, :name, :color, :sortOrder, :createdAt, :isDefault)";
const CARD_COLUMNS =
  "id, folderId, scryfallId, illustrationId, oracleId, name, setCode, setName, collectorNumber, quantity, condition, notes, dateAdded, cmc, colors, rarity";
const CARD_VALUES =
  "(:id, :folderId, :scryfallId, :illustrationId, :oracleId, :name, :setCode, :setName, :collectorNumber, :quantity, :condition, :notes, :dateAdded, :cmc, :colors, :rarity)";

function folderParams(folder: Folder): Record<string, unknown> {
  return {
    id: folder.id,
    name: folder.name,
    color: folder.color,
    sortOrder: folder.sortOrder,
    createdAt: folder.createdAt,
    isDefault: folder.isDefault ? 1 : 0,
  };
}

function cardParams(card: CardEntry): Record<string, unknown> {
  return {
    id: card.id,
    folderId: card.folderId,
    scryfallId: card.scryfallId,
    illustrationId: card.illustrationId,
    oracleId: card.oracleId,
    name: card.name,
    setCode: card.setCode,
    setName: card.setName,
    collectorNumber: card.collectorNumber,
    quantity: card.quantity,
    condition: card.condition,
    notes: card.notes,
    dateAdded: card.dateAdded,
    cmc: card.cmc ?? null,
    colors: card.colors ? JSON.stringify(card.colors) : null,
    rarity: card.rarity ?? null,
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
    cmc: row.cmc == null ? undefined : row.cmc as number,
    colors: row.colors ? JSON.parse(row.colors as string) : undefined,
    rarity: row.rarity == null ? undefined : row.rarity as string,
  };
}

/**
 * Read all folders/cards out of an already-open database handle.
 * Driver-agnostic: works with any `Database`, live or scratch.
 */
async function readSnapshot(
  db: Database,
): Promise<{ folders: Folder[]; cards: CardEntry[] }> {
  const folderRows = await db.all("SELECT * FROM folders ORDER BY sortOrder");
  const cardRows = await db.all("SELECT * FROM cards");
  return {
    folders: folderRows.map(folderFromRow),
    cards: cardRows.map(cardFromRow),
  };
}

/**
 * Wipe and repopulate an already-open database handle with the given data.
 * Driver-agnostic: works with any `Database`, live or scratch.
 */
async function writeSnapshot(
  db: Database,
  data: { folders: Folder[]; cards: CardEntry[] },
): Promise<void> {
  const txn = db.transactionAsync(async (tx: Transaction) => {
    await tx.exec("DELETE FROM cards; DELETE FROM folders;");

    for (const folder of data.folders) {
      await tx.run(
        `INSERT INTO folders (${FOLDER_COLUMNS}) VALUES ${FOLDER_VALUES}`,
        folderParams(folder),
      );
    }

    for (const card of data.cards) {
      await tx.run(
        `INSERT INTO cards (${CARD_COLUMNS}) VALUES ${CARD_VALUES}`,
        cardParams(card),
      );
    }
  });
  await txn();
}

/**
 * Works around a real bug in `@tursodatabase/database-wasm`'s browser/OPFS
 * driver: `stepSync()` returns the same `STEP_IO` code both when real OPFS
 * I/O is in flight *and* when core just wants a plain re-poll with nothing
 * to wait on (a `Yield` — e.g. an internal cache/lock retry mid-transaction,
 * see core/vdbe/mod.rs's `StepResult::Yield` handling upstream). The wasm
 * driver's only reaction to `STEP_IO` is to park on a shared promise that
 * resolves when a *real* OPFS worker completion arrives — so for the
 * plain-Yield case, nothing ever wakes it, and the statement (plus
 * everything queued behind its connection's exec lock) hangs forever. The
 * Node native driver is unaffected because its `ioStep` is already a no-op,
 * so its loop always re-polls immediately.
 *
 * Confirmed upstream, still open as of database-wasm 0.7.2 / 0.8.0-pre.4:
 * https://github.com/tursodatabase/turso/issues/8171 (first report, fixed)
 * https://github.com/tursodatabase/turso/issues/8341 (Yield variant, open)
 *
 * The fix endorsed in both threads: race each `ioStep()` wait against a
 * short timer so an untracked Yield degrades to a bounded re-poll instead
 * of parking forever, while a real I/O completion still resolves
 * immediately via the driver's own notifier. `ioStep` is a plain (if
 * TS-private) field statements capture via `db.prepare()`/`db.io()` at call
 * time, so patching it right after connect — before any query runs — is
 * enough to cover every later query, transaction, and batch.
 *
 * ponytail: timer-race workaround, not a real fix for the driver's Yield
 * handling — remove once upstream ships one (tracked in #8341).
 */
function unstickIOStep(db: Database): void {
  const target = db as unknown as { ioStep?: () => Promise<void> };
  if (typeof target.ioStep !== "function") return;
  const original = target.ioStep.bind(target);
  target.ioStep = () =>
    new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      original().then(settle, settle);
      setTimeout(settle, 25);
    });
}

class CollectionStore {
  private db: Database | null = null;
  private driver: TursoConnect = connect;

  /**
   * Open the database connection. Must be called before any operations.
   *
   * @param path - Database file path (OPFS). Overridable for tests.
   * @param driver - The `connect` function used to open the database.
   *   Defaults to the Turso WASM driver; tests inject the Node native
   *   driver (`@tursodatabase/database`), which shares the same API.
   */
  async open(
    path: string = DB_PATH,
    driver: TursoConnect = connect,
  ): Promise<void> {
    this.driver = driver;
    try {
      this.db = await driver(path);
    } catch (err) {
      throw new Error(
        `Failed to open database (it may be open in another tab): ${
          (err as Error).message
        }`,
      );
    }
    unstickIOStep(this.db);
    await this.initSchema(this.db);
  }

  private async initSchema(db: Database): Promise<void> {
    await db.exec(SCHEMA);
    // Guarded migration: add columns that didn't exist in earlier schema
    // versions. Ignored if already present (SQLite errors on duplicate ADD
    // COLUMN, which is expected on every open after the first).
    for (const stmt of MIGRATIONS) {
      try {
        await db.exec(stmt);
      } catch {
        // column already exists
      }
    }
  }

  /**
   * Open a scratch database at `path` (using the same driver as the live
   * store), run `fn` against it, then close it. Used to build/read
   * standalone `.db` files for export/import without touching the live
   * database. A second, concurrent OPFS-backed connection to a *different*
   * file works fine alongside the live one (verified against the real
   * WASM/OPFS driver in a browser, not just the Node driver tests run
   * against) — the OPFS "Access Handles cannot be created if there is
   * another open Access Handle" restriction only applies to reopening the
   * *same* file twice, e.g. across a page reload (see the `pagehide`
   * handler in main.ts).
   *
   * Runs a full WAL checkpoint before closing: the OPFS VFS always uses
   * WAL journal mode (attempting `PRAGMA journal_mode=DELETE` is silently
   * ignored there), so committed rows can sit in a separate `-wal` side
   * file until checkpointed. Export/import only read/write the *main*
   * filename as raw bytes (via plain OPFS file APIs), so without this a
   * downloaded `.db` would contain just the schema and none of the actual
   * rows — this is exactly the bug that made exportAsDB()/importFromDB()
   * silently produce/read an empty collection in a real browser, even
   * though the Node driver used in unit tests doesn't hit it.
   */
  private async withSnapshot<T>(
    path: string,
    fn: (db: Database) => Promise<T>,
  ): Promise<T> {
    const db = await this.driver(path);
    unstickIOStep(db);
    try {
      await this.initSchema(db);
      const result = await fn(db);
      await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return result;
    } finally {
      await db.close();
    }
  }

  /**
   * Write the current collection into a standalone SQLite file at `path`.
   */
  async exportToScratch(path: string): Promise<void> {
    const data = await this.exportCollection();
    await this.withSnapshot(path, (db) => writeSnapshot(db, data));
  }

  /**
   * Read a standalone SQLite file at `path` and return its folders/cards
   * without touching the live collection. Used to validate an uploaded
   * file before it's swapped in as the live db (see `importFromDB` in
   * export.ts).
   */
  async readCollectionFromFile(
    path: string,
  ): Promise<{ folders: Folder[]; cards: CardEntry[] }> {
    return await this.withSnapshot(path, readSnapshot);
  }

  // ─── Folder Operations ──────────────────────────────────────────────

  /**
   * Ensure the default "Unsorted" folder exists.
   */
  async ensureDefaultFolder(): Promise<null> {
    const folders = await this.getAllFolders();
    // If any folders exist, don't need to create a default
    if (folders.length > 0) {
      return null;
    }

    const defaultFolder: Folder = {
      id: crypto.randomUUID(),
      name: "Unsorted",
      color: "#666",
      sortOrder: 0,
      createdAt: new Date().toISOString(),
      isDefault: true,
    };

    await this.putFolder(defaultFolder);
    return null;
  }

  async getAllFolders(): Promise<Folder[]> {
    const rows = await this.db!.all("SELECT * FROM folders ORDER BY sortOrder");
    return rows.map(folderFromRow);
  }

  async getFolder(id: string): Promise<Folder | undefined> {
    const row = await this.db!.get(
      "SELECT * FROM folders WHERE id = :id",
      { id },
    );
    return row ? folderFromRow(row) : undefined;
  }

  async createFolder(name: string, color = "#0f3460"): Promise<Folder> {
    const folders = await this.getAllFolders();
    const maxOrder = folders.reduce((max, f) => Math.max(max, f.sortOrder), 0);

    const folder: Folder = {
      id: crypto.randomUUID(),
      name,
      color,
      sortOrder: maxOrder + 1,
      createdAt: new Date().toISOString(),
    };

    await this.putFolder(folder);
    return folder;
  }

  async putFolder(folder: Folder): Promise<void> {
    await this.db!.run(
      `INSERT INTO folders (${FOLDER_COLUMNS})
       VALUES ${FOLDER_VALUES}
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, color = excluded.color, sortOrder = excluded.sortOrder,
         createdAt = excluded.createdAt, isDefault = excluded.isDefault`,
      folderParams(folder),
    );
  }

  async deleteFolder(id: string): Promise<void> {
    const cards = await this.getCardsByFolder(id);
    if (cards.length > 0) {
      throw new Error("Cannot delete a folder that still contains cards");
    }
    await this.db!.run("DELETE FROM folders WHERE id = :id", { id });
  }

  async renameFolder(id: string, newName: string): Promise<void> {
    const folder = await this.getFolder(id);
    if (!folder) throw new Error(`Folder not found: ${id}`);
    folder.name = newName;
    await this.putFolder(folder);
  }

  async reorderFolders(orderedIds: string[]): Promise<void> {
    const folders = await this.getAllFolders();
    const folderMap = new Map(folders.map((f) => [f.id, f]));

    for (let i = 0; i < orderedIds.length; i++) {
      const folder = folderMap.get(orderedIds[i]);
      if (folder) {
        folder.sortOrder = i;
        await this.putFolder(folder);
      }
    }
  }

  async getFolderCardCount(folderId: string): Promise<number> {
    const row = await this.db!.get(
      "SELECT COUNT(*) as count FROM cards WHERE folderId = :folderId",
      { folderId },
    );
    return (row?.count as number) ?? 0;
  }

  // ─── Card Operations ────────────────────────────────────────────────

  async getCardsByFolder(folderId: string): Promise<CardEntry[]> {
    const rows = await this.db!.all(
      "SELECT * FROM cards WHERE folderId = :folderId",
      { folderId },
    );
    return rows.map(cardFromRow);
  }

  async getCard(id: string): Promise<CardEntry | undefined> {
    const row = await this.db!.get(
      "SELECT * FROM cards WHERE id = :id",
      { id },
    );
    return row ? cardFromRow(row) : undefined;
  }

  async putCard(card: CardEntry): Promise<void> {
    await this.db!.run(
      `INSERT INTO cards (${CARD_COLUMNS})
       VALUES ${CARD_VALUES}
       ON CONFLICT(id) DO UPDATE SET
          folderId = excluded.folderId
          , scryfallId = excluded.scryfallId
          , illustrationId = excluded.illustrationId
          , oracleId = excluded.oracleId
          , name = excluded.name
          , setCode = excluded.setCode
          , setName = excluded.setName
          , collectorNumber = excluded.collectorNumber
          , quantity = excluded.quantity
          , condition = excluded.condition
          , notes = excluded.notes
          , dateAdded = excluded.dateAdded
          , cmc = excluded.cmc
          , colors = excluded.colors
          , rarity = excluded.rarity`,
      cardParams(card),
    );
  }

  async deleteCard(id: string): Promise<void> {
    await this.db!.run("DELETE FROM cards WHERE id = :id", { id });
  }

  // ─── Staging Commit ─────────────────────────────────────────────────
  //
  // Each of these fetches the affected folder(s) once, computes the
  // resulting rows in memory (no per-item SELECT), then applies every
  // INSERT/UPDATE/DELETE as a single transaction via `applyCardDiffs`.

  /**
   * Add a batch of staged items to a folder (merging quantity into any
   * matching existing printing).
   */
  async commitAdd(
    folderId: string,
    items: readonly StagingItem[],
  ): Promise<{ applied: number }> {
    const before = await this.getCardsByFolder(folderId);
    const after = simulateAdd(before, items, (item) => ({
      ...item,
      id: crypto.randomUUID(),
      folderId,
      notes: "",
      dateAdded: new Date().toISOString(),
    }));

    await this.applyCardDiffs([
      { folderId, diff: computeDiff(before, after) },
    ]);
    return { applied: items.length };
  }

  /**
   * Remove a batch of staged items' quantities from a folder. Items with no
   * matching card in the folder are skipped.
   */
  async commitRemove(
    folderId: string,
    items: readonly StagingItem[],
  ): Promise<{ applied: number; skipped: number }> {
    const before = await this.getCardsByFolder(folderId);
    const after = simulateRemove(before, items);
    const skipped = items.filter((item) => !findMatch(before, item)).length;

    await this.applyCardDiffs([
      { folderId, diff: computeDiff(before, after) },
    ]);
    return { applied: items.length - skipped, skipped };
  }

  /**
   * Move a batch of staged items' quantities from one folder to another.
   * Items with no matching card in the source folder are skipped; the
   * amount moved is capped at what the source entry actually has.
   */
  async commitMove(
    sourceFolderId: string,
    destinationFolderId: string,
    items: readonly StagingItem[],
  ): Promise<{ applied: number; skipped: number }> {
    const sourceBefore = await this.getCardsByFolder(sourceFolderId);
    const destBefore = await this.getCardsByFolder(destinationFolderId);

    // Resolve + clamp each item against what the source folder actually
    // has, using the matched entry's own fields (it may be a different
    // printing of the same illustration than what was staged).
    const clamped = clampToSource(sourceBefore, items);
    const skipped = items.length - clamped.length;

    const sourceAfter = simulateRemove(sourceBefore, clamped);
    const destAfter = simulateAdd(destBefore, clamped, (item) => ({
      ...item,
      id: crypto.randomUUID(),
      folderId: destinationFolderId,
      dateAdded: new Date().toISOString(),
    }));

    await this.applyCardDiffs([
      {
        folderId: sourceFolderId,
        diff: computeDiff(sourceBefore, sourceAfter),
      },
      {
        folderId: destinationFolderId,
        diff: computeDiff(destBefore, destAfter),
      },
    ]);
    return { applied: items.length - skipped, skipped };
  }

  /**
   * Apply precomputed before/after diffs for one or more folders as a
   * single atomic transaction: one INSERT/UPDATE/DELETE per changed row,
   * no per-row SELECT (the diff already encodes what changed).
   *
   * Deliberately simple/unbatched: a multi-row-statement version was tried
   * (grouping rows into chunked multi-row INSERT/UPDATE/DELETE statements)
   * to work around the wasm/OPFS driver hanging on large single-transaction
   * writes (see unstickIOStep's comment), but it didn't help — a spike
   * confirmed even a *single* set-based `INSERT ... SELECT` of 500 rows
   * hangs the same way. The hang is gated by total rows/pages written in
   * one transaction, not by statement count/shape, so batching only added
   * complexity without raising the safe ceiling. `unstickIOStep` is the
   * real fix for the common (smaller) case; very large single-call
   * add/move operations (400+ cards) remain a known open limitation.
   */
  async applyCardDiffs(
    diffs: { folderId: string; diff: DiffRow<CardEntry>[] }[],
  ): Promise<void> {
    const txn = this.db!.transactionAsync(async (tx: Transaction) => {
      let txnBatch: { sql: string; args: Record<string, unknown> }[] = [];
      for (const { folderId, diff } of diffs) {
        for (const row of diff) {
          if (row.kind === "unchanged") continue;
          if (row.kind === "removed") {
            txnBatch.push({
              sql: "DELETE FROM cards WHERE id = :id",
              args: { id: row.card.id },
            });
          } else if (row.kind === "added") {
            txnBatch.push({
              sql: `INSERT INTO cards (${CARD_COLUMNS}) VALUES ${CARD_VALUES}`,
              args: cardParams({
                ...row.card,
                folderId,
                quantity: row.after,
              }),
            });
          } else {
            txnBatch.push({
              sql: "UPDATE cards SET quantity = :quantity WHERE id = :id",
              args: { quantity: row.after, id: row.card.id },
            });
          }
          // flush current batch every 50 statements to avoid hitting
          // the db too hard with many single statements. Also less ops on app side code
          if (txnBatch.length >= 50) {
            await tx.batch(txnBatch);
            txnBatch = [];
          }
        }
      }
      // flush any remaining statements in the batch
      if (txnBatch.length > 0) {
        await tx.batch(txnBatch);
      }
    });
    await txn();
  }

  /**
   * Get all cards across all folders.
   */
  async getAllCards(): Promise<CardEntry[]> {
    const rows = await this.db!.all("SELECT * FROM cards");
    return rows.map(cardFromRow);
  }

  /**
   * Get total card count (sum of quantities).
   */
  async getTotalCardCount(): Promise<number> {
    const row = await this.db!.get(
      "SELECT COALESCE(SUM(quantity), 0) as total FROM cards",
    );
    return (row?.total as number) ?? 0;
  }

  // ─── Export / Import ────────────────────────────────────────────────

  /**
   * Flush the WAL into the main db file. The OPFS VFS always uses WAL
   * journal mode, so committed rows can sit in a separate `-wal` side file
   * until checkpointed — required before reading the live db file's raw
   * bytes directly (export) or closing it out from under a fresh open.
   */
  async checkpointWal(): Promise<void> {
    await this.db!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  exportCollection(): Promise<{ folders: Folder[]; cards: CardEntry[] }> {
    return readSnapshot(this.db!);
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance
export const collectionStore = new CollectionStore();
