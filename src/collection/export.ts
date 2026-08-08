/**
 * Export/Import Module
 *
 * Handles exporting the collection as a standalone SQLite-compatible `.db`
 * file, and importing one back in (replacing the collection). The file is
 * built/read via a scratch Turso connection (see `collectionStore.exportToScratch`
 * / `importFromScratch`) and moved in/out of OPFS as raw bytes here.
 */

import { collectionStore } from "./store.ts";

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
 */
export async function importFromDB(): Promise<{ folders: number; cards: number }> {
  const file = await selectFile(".db,.sqlite,.sqlite3");
  if (!file) throw new Error("No file selected");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const scratchName = `import-${crypto.randomUUID()}.db`;
  const root = await navigator.storage.getDirectory();

  const handle = await root.getFileHandle(scratchName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();

  try {
    return await collectionStore.importFromScratch(scratchName);
  } catch {
    throw new Error("Not a valid Mana Vault collection database");
  } finally {
    await root.removeEntry(scratchName);
  }
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
