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

type TursoConnect = (path: string) => Promise<Database>;

const FOLDER_COLUMNS = "id, name, color, sortOrder, createdAt, isDefault";
const CARD_COLUMNS =
  "id, folderId, scryfallId, illustrationId, oracleId, name, setCode, setName, collectorNumber, quantity, condition, notes, dateAdded, cmc, colors, rarity";

function folderValues(folder: Folder): unknown[] {
  return [
    folder.id,
    folder.name,
    folder.color,
    folder.sortOrder,
    folder.createdAt,
    folder.isDefault ? 1 : 0,
  ];
}

function cardValues(card: CardEntry): unknown[] {
  return [
    card.id,
    card.folderId,
    card.scryfallId,
    card.illustrationId,
    card.oracleId,
    card.name,
    card.setCode,
    card.setName,
    card.collectorNumber,
    card.quantity,
    card.condition,
    card.notes,
    card.dateAdded,
    card.cmc ?? null,
    card.colors ? JSON.stringify(card.colors) : null,
    card.rarity ?? null,
  ];
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
        `INSERT INTO folders (${FOLDER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
        ...folderValues(folder),
      );
    }

    for (const card of data.cards) {
      await tx.run(
        `INSERT INTO cards (${CARD_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...cardValues(card),
      );
    }
  });
  await txn();
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
   * Read a standalone SQLite file at `path` and import its folders/cards
   * into the live collection (replacing it).
   */
  async importFromScratch(
    path: string,
  ): Promise<{ folders: number; cards: number }> {
    const data = await this.withSnapshot(path, readSnapshot);
    await this.importCollection(data);
    return { folders: data.folders.length, cards: data.cards.length };
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
    const row = await this.db!.get("SELECT * FROM folders WHERE id = ?", id);
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
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, color = excluded.color, sortOrder = excluded.sortOrder,
         createdAt = excluded.createdAt, isDefault = excluded.isDefault`,
      ...folderValues(folder),
    );
  }

  async deleteFolder(id: string): Promise<void> {
    const cards = await this.getCardsByFolder(id);
    if (cards.length > 0) {
      throw new Error("Cannot delete a folder that still contains cards");
    }
    await this.db!.run("DELETE FROM folders WHERE id = ?", id);
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
      "SELECT COUNT(*) as count FROM cards WHERE folderId = ?",
      folderId,
    );
    return (row?.count as number) ?? 0;
  }

  // ─── Card Operations ────────────────────────────────────────────────

  async getCardsByFolder(folderId: string): Promise<CardEntry[]> {
    const rows = await this.db!.all(
      "SELECT * FROM cards WHERE folderId = ?",
      folderId,
    );
    return rows.map(cardFromRow);
  }

  async getCard(id: string): Promise<CardEntry | undefined> {
    const row = await this.db!.get("SELECT * FROM cards WHERE id = ?", id);
    return row ? cardFromRow(row) : undefined;
  }

  /**
   * Find a card in a specific folder by its Scryfall ID (exact printing match).
   */
  async findCardInFolder(
    folderId: string,
    scryfallId: string,
  ): Promise<CardEntry | undefined> {
    const row = await this.db!.get(
      "SELECT * FROM cards WHERE folderId = ? AND scryfallId = ?",
      folderId,
      scryfallId,
    );
    return row ? cardFromRow(row) : undefined;
  }

  /**
   * Find a card in a specific folder by illustration ID (any printing of the
   * same artwork). Used as a fallback when the exact printing scanned isn't
   * the one already in the folder.
   */
  async findCardInFolderByIllustration(
    folderId: string,
    illustrationId: string,
  ): Promise<CardEntry | undefined> {
    const cards = await this.getCardsByFolder(folderId);
    return cards.find((c) => c.illustrationId === illustrationId);
  }

  /**
   * Add a card to a folder. If the same printing already exists in the folder,
   * increment the quantity instead.
   */
  async addCard(card: Omit<CardEntry, "id" | "dateAdded">): Promise<CardEntry> {
    // Check if this exact printing already exists in the folder
    const existing = await this.findCardInFolder(
      card.folderId,
      card.scryfallId,
    );

    if (existing) {
      existing.quantity += card.quantity;
      await this.putCard(existing);
      return existing;
    }

    const newCard: CardEntry = {
      ...card,
      id: crypto.randomUUID(),
      dateAdded: new Date().toISOString(),
    };

    await this.putCard(newCard);
    return newCard;
  }

  async putCard(card: CardEntry): Promise<void> {
    await this.db!.run(
      `INSERT INTO cards (${CARD_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         folderId = excluded.folderId, scryfallId = excluded.scryfallId,
         illustrationId = excluded.illustrationId, oracleId = excluded.oracleId,
         name = excluded.name, setCode = excluded.setCode, setName = excluded.setName,
         collectorNumber = excluded.collectorNumber, quantity = excluded.quantity,
         condition = excluded.condition, notes = excluded.notes, dateAdded = excluded.dateAdded,
         cmc = excluded.cmc, colors = excluded.colors, rarity = excluded.rarity`,
      ...cardValues(card),
    );
  }

  async deleteCard(id: string): Promise<void> {
    await this.db!.run("DELETE FROM cards WHERE id = ?", id);
  }

  /**
   * Move a quantity of a card from one folder to another.
   * If the quantity covers the full amount, the entry is removed from source.
   * If the destination already has the same printing, quantities are merged.
   */
  async moveCard(
    cardId: string,
    destinationFolderId: string,
    quantity?: number,
  ): Promise<void> {
    const card = await this.getCard(cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);

    const moveQty = quantity ?? card.quantity;
    if (moveQty > card.quantity) {
      throw new Error(
        `Cannot move ${moveQty}, only ${card.quantity} available`,
      );
    }

    // Check if destination already has this printing
    const existing = await this.findCardInFolder(
      destinationFolderId,
      card.scryfallId,
    );

    if (existing) {
      // Merge into existing entry
      existing.quantity += moveQty;
      await this.putCard(existing);
    } else {
      // Create new entry in destination
      await this.addCard({
        folderId: destinationFolderId,
        scryfallId: card.scryfallId,
        illustrationId: card.illustrationId,
        oracleId: card.oracleId,
        name: card.name,
        setCode: card.setCode,
        setName: card.setName,
        collectorNumber: card.collectorNumber,
        quantity: moveQty,
        condition: card.condition,
        notes: card.notes,
        cmc: card.cmc,
        colors: card.colors,
        rarity: card.rarity,
      });
    }

    // Update or remove source
    if (moveQty >= card.quantity) {
      await this.deleteCard(cardId);
    } else {
      card.quantity -= moveQty;
      await this.putCard(card);
    }
  }

  /**
   * Move multiple cards to a destination folder.
   */
  async moveCards(
    cardIds: string[],
    destinationFolderId: string,
  ): Promise<void> {
    for (const id of cardIds) {
      await this.moveCard(id, destinationFolderId);
    }
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

  async exportCollection(): Promise<{ folders: Folder[]; cards: CardEntry[] }> {
    return readSnapshot(this.db!);
  }

  async importCollection(
    data: { folders: Folder[]; cards: CardEntry[] },
  ): Promise<void> {
    await writeSnapshot(this.db!, data);
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
