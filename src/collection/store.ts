/**
 * Collection Store
 *
 * IndexedDB-based storage for the card collection with folder support.
 * Provides CRUD operations for folders and card entries.
 */

const DB_NAME = "mtg-scanner";
const DB_VERSION = 1;

// Store names
const FOLDERS_STORE = "folders";
const CARDS_STORE = "cards";

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
}

class CollectionStore {
  private db: IDBDatabase | null = null;

  /**
   * Open the database connection. Must be called before any operations.
   */
  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        this.createSchema(db);
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`Failed to open database: ${request.error?.message}`));
      };
    });
  }

  private createSchema(db: IDBDatabase): void {
    // Folders store
    if (!db.objectStoreNames.contains(FOLDERS_STORE)) {
      const folderStore = db.createObjectStore(FOLDERS_STORE, { keyPath: "id" });
      folderStore.createIndex("sortOrder", "sortOrder", { unique: false });
      folderStore.createIndex("name", "name", { unique: false });
    }

    // Cards store
    if (!db.objectStoreNames.contains(CARDS_STORE)) {
      const cardStore = db.createObjectStore(CARDS_STORE, { keyPath: "id" });
      cardStore.createIndex("folderId", "folderId", { unique: false });
      cardStore.createIndex("scryfallId", "scryfallId", { unique: false });
      cardStore.createIndex("illustrationId", "illustrationId", { unique: false });
      cardStore.createIndex("oracleId", "oracleId", { unique: false });
      cardStore.createIndex("name", "name", { unique: false });
      cardStore.createIndex("folderId_scryfallId", ["folderId", "scryfallId"], { unique: false });
    }
  }

  // ─── Folder Operations ──────────────────────────────────────────────

  /**
   * Ensure the default "Unsorted" folder exists.
   */
  async ensureDefaultFolder(): Promise<Folder> {
    const folders = await this.getAllFolders();
    const existing = folders.find((f) => f.isDefault);
    if (existing) return existing;

    const defaultFolder: Folder = {
      id: crypto.randomUUID(),
      name: "Unsorted",
      color: "#666",
      sortOrder: 0,
      createdAt: new Date().toISOString(),
      isDefault: true,
    };

    await this.putFolder(defaultFolder);
    return defaultFolder;
  }

  async getAllFolders(): Promise<Folder[]> {
    const store = this.getStore(FOLDERS_STORE, "readonly");
    return new Promise((resolve, reject) => {
      const request = store.index("sortOrder").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getFolder(id: string): Promise<Folder | undefined> {
    const store = this.getStore(FOLDERS_STORE, "readonly");
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
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
    const store = this.getStore(FOLDERS_STORE, "readwrite");
    return new Promise((resolve, reject) => {
      const request = store.put(folder);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deleteFolder(id: string): Promise<void> {
    // Don't allow deleting the default folder
    const folder = await this.getFolder(id);
    if (folder?.isDefault) {
      throw new Error("Cannot delete the default folder");
    }

    // Move all cards in this folder to the default folder
    const defaultFolder = await this.ensureDefaultFolder();
    const cards = await this.getCardsByFolder(id);
    for (const card of cards) {
      card.folderId = defaultFolder.id;
      await this.putCard(card);
    }

    const store = this.getStore(FOLDERS_STORE, "readwrite");
    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
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
    const store = this.getStore(CARDS_STORE, "readonly");
    return new Promise((resolve, reject) => {
      const index = store.index("folderId");
      const request = index.count(IDBKeyRange.only(folderId));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ─── Card Operations ────────────────────────────────────────────────

  async getCardsByFolder(folderId: string): Promise<CardEntry[]> {
    const store = this.getStore(CARDS_STORE, "readonly");
    return new Promise((resolve, reject) => {
      const index = store.index("folderId");
      const request = index.getAll(IDBKeyRange.only(folderId));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getCard(id: string): Promise<CardEntry | undefined> {
    const store = this.getStore(CARDS_STORE, "readonly");
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Find a card in a specific folder by its Scryfall ID (exact printing match).
   */
  async findCardInFolder(folderId: string, scryfallId: string): Promise<CardEntry | undefined> {
    const store = this.getStore(CARDS_STORE, "readonly");
    return new Promise((resolve, reject) => {
      const index = store.index("folderId_scryfallId");
      const request = index.get([folderId, scryfallId]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Add a card to a folder. If the same printing already exists in the folder,
   * increment the quantity instead.
   */
  async addCard(card: Omit<CardEntry, "id" | "dateAdded">): Promise<CardEntry> {
    // Check if this exact printing already exists in the folder
    const existing = await this.findCardInFolder(card.folderId, card.scryfallId);

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
    const store = this.getStore(CARDS_STORE, "readwrite");
    return new Promise((resolve, reject) => {
      const request = store.put(card);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deleteCard(id: string): Promise<void> {
    const store = this.getStore(CARDS_STORE, "readwrite");
    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
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
      throw new Error(`Cannot move ${moveQty}, only ${card.quantity} available`);
    }

    // Check if destination already has this printing
    const existing = await this.findCardInFolder(destinationFolderId, card.scryfallId);

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
   * Get all unique illustration IDs in a folder (for scan-to-select matching).
   */
  async getIllustrationIdsInFolder(folderId: string): Promise<Set<string>> {
    const cards = await this.getCardsByFolder(folderId);
    return new Set(cards.map((c) => c.illustrationId));
  }

  /**
   * Get all cards across all folders.
   */
  async getAllCards(): Promise<CardEntry[]> {
    const store = this.getStore(CARDS_STORE, "readonly");
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get total card count (sum of quantities).
   */
  async getTotalCardCount(): Promise<number> {
    const cards = await this.getAllCards();
    return cards.reduce((sum, c) => sum + c.quantity, 0);
  }

  // ─── Export / Import ────────────────────────────────────────────────

  async exportCollection(): Promise<{ folders: Folder[]; cards: CardEntry[] }> {
    const folders = await this.getAllFolders();
    const cards = await this.getAllCards();
    return { folders, cards };
  }

  async importCollection(data: { folders: Folder[]; cards: CardEntry[] }): Promise<void> {
    // Clear existing data
    await this.clearAll();

    // Import folders
    for (const folder of data.folders) {
      await this.putFolder(folder);
    }

    // Import cards
    for (const card of data.cards) {
      await this.putCard(card);
    }
  }

  private async clearAll(): Promise<void> {
    const tx = this.db!.transaction([FOLDERS_STORE, CARDS_STORE], "readwrite");
    tx.objectStore(FOLDERS_STORE).clear();
    tx.objectStore(CARDS_STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private getStore(name: string, mode: IDBTransactionMode): IDBObjectStore {
    if (!this.db) throw new Error("Database not open");
    return this.db.transaction(name, mode).objectStore(name);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance
export const collectionStore = new CollectionStore();
