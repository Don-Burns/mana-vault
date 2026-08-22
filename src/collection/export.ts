/**
 * Export/Import Module
 *
 * Handles exporting the collection as a standalone SQLite-compatible `.db`
 * file, and importing one back in (replacing the collection).
 *
 * Both directions go entirely through the store worker's byte-level
 * `exportBytes`/`importBytes` RPC calls (see store-worker.ts) — the
 * `opfs-sahpool` VFS manages its own private file mapping, not a real
 * transparent OPFS file, so there's no raw OPFS byte access to reach into
 * from the main thread the way the old Turso-backed version did. See
 * docs/turso_wasm_hang_and_alternatives.md.
 */

import { collectionStore } from "./store.ts";

const DB_MIME_TYPE = "application/x-sqlite3";

/** Export the entire collection as a downloadable SQLite `.db` file. */
export async function exportAsDB(): Promise<void> {
  const bytes = await collectionStore.exportBytes();
  downloadFile(bytes.buffer as ArrayBuffer, "mana-vault.db", DB_MIME_TYPE);
}

/**
 * Import a collection from a SQLite `.db` file (replaces the collection).
 * Prompts the user to select a file.
 */
export async function importFromDB(): Promise<{ folders: number; cards: number }> {
  const file = await selectFile(".db,.sqlite,.sqlite3");
  if (!file) throw new Error("No file selected");

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const counts = await collectionStore.importBytes(bytes);
    await collectionStore.ensureDefaultFolder();
    return counts;
  } catch {
    throw new Error("Not a valid Mana Vault collection database");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function downloadFile(
  content: BlobPart,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function selectFile(accept: string): Promise<File | null> {
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
