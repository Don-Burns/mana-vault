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

import { stringify } from "@std/csv";
import { type CardEntry, collectionStore } from "./store.ts";

const DB_MIME_TYPE = "application/x-sqlite3";
const CSV_COLUMNS = [
  "quantity",
  "name",
  "set_code",
  "collector_number",
  "condition",
] as const;

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

/** Serialize cards to CSV text (same column layout the CSV importer expects). */
export function cardsToCsv(cards: CardEntry[]): string {
  const rows = cards.map((c) => ({
    quantity: String(c.quantity),
    name: c.name,
    set_code: c.setCode,
    collector_number: c.collectorNumber,
    condition: c.condition,
  }));
  return stringify(rows, { columns: CSV_COLUMNS });
}

/**
 * Export cards as CSV, either to a downloaded file or the system clipboard.
 * `folderId` of `null` exports the whole collection.
 */
export async function exportCardsAsCsv(
  folderId: string | null,
  destination: "file" | "clipboard",
): Promise<void> {
  const cards = folderId
    ? await collectionStore.getCardsByFolder(folderId)
    : await collectionStore.getAllCards();
  const csv = cardsToCsv(cards);
  if (destination === "clipboard") {
    await navigator.clipboard.writeText(csv);
  } else {
    downloadFile(csv, "mana-vault-export.csv", "text/csv");
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
