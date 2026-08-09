/**
 * Export/Import Module
 *
 * Handles exporting the collection as a standalone SQLite-compatible `.db`
 * file, and importing one back in (replacing the collection). Export is
 * built via a scratch Turso connection (see `collectionStore.exportToScratch`)
 * and moved out of OPFS as raw bytes here. Import validates the uploaded
 * bytes via `collectionStore.readCollectionFromFile` on a scratch
 * connection, then swaps them in as the live db file directly.
 */

import { collectionStore, DB_PATH } from "./store.ts";

const DB_MIME_TYPE = "application/x-sqlite3";

/**
 * Export the entire collection as a downloadable SQLite `.db` file.
 */
export async function exportAsDB(): Promise<void> {
  const scratchName = `export-${crypto.randomUUID()}.db`;
  const root = await navigator.storage.getDirectory();

  await collectionStore.exportToScratch(scratchName);
  try {
    const handle = await root.getFileHandle(scratchName);
    const bytes = await (await handle.getFile()).arrayBuffer();
    downloadFile(bytes, "mana-vault.db", DB_MIME_TYPE);
  } finally {
    await root.removeEntry(scratchName);
  }
}

/**
 * Import a collection from a SQLite `.db` file (replaces the collection).
 * Prompts the user to select a file.
 *
 * Validates the upload on a throwaway scratch connection first (the live
 * db is untouched if it's not a valid Mana Vault database), then closes
 * the live connection, overwrites the live OPFS file with the (now
 * schema-migrated) upload, and reopens — the live and scratch connections
 * are never open at the same time.
 */
export async function importFromDB(): Promise<{ folders: number; cards: number }> {
  const file = await selectFile(".db,.sqlite,.sqlite3");
  if (!file) throw new Error("No file selected");

  const root = await navigator.storage.getDirectory();
  const scratchName = `import-${crypto.randomUUID()}.db`;
  const scratchHandle = await root.getFileHandle(scratchName, { create: true });

  let data: { folders: unknown[]; cards: unknown[] };
  let migratedBytes: ArrayBuffer;
  try {
    const writable = await scratchHandle.createWritable();
    await writable.write(await file.arrayBuffer());
    await writable.close();

    data = await collectionStore.readCollectionFromFile(scratchName);
    migratedBytes = await (await scratchHandle.getFile()).arrayBuffer();
  } catch {
    throw new Error("Not a valid Mana Vault collection database");
  } finally {
    await root.removeEntry(scratchName);
  }

  await collectionStore.close();
  const dbHandle = await root.getFileHandle(DB_PATH, { create: true });
  const writable = await dbHandle.createWritable();
  await writable.write(migratedBytes);
  await writable.close();
  // Discard any leftover WAL from the previous live db — its frames apply
  // to the old file's pages, not the one we just wrote.
  await root.removeEntry(`${DB_PATH}-wal`).catch(() => {});

  await collectionStore.open();
  await collectionStore.ensureDefaultFolder();
  return { folders: data.folders.length, cards: data.cards.length };
}

// ─── Helpers ────────────────────────────────────────────────────────

function downloadFile(content: BlobPart, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function selectFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      resolve(input.files?.[0] || null);
    };
    input.click();
  });
}
