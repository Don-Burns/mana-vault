/**
 * Export/Import Module
 *
 * Handles exporting the collection to JSON/CSV and importing from JSON.
 * Preserves folder structure during export/import.
 */

import { collectionStore, type Folder, type CardEntry } from "./store.ts";

export interface ExportData {
  version: 1;
  exportedAt: string;
  folders: Folder[];
  cards: CardEntry[];
}

/**
 * Export the entire collection as a JSON file.
 */
export async function exportAsJSON(): Promise<void> {
  const { folders, cards } = await collectionStore.exportCollection();

  const data: ExportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    folders,
    cards,
  };

  const json = JSON.stringify(data, null, 2);
  downloadFile(json, "mtg-collection.json", "application/json");
}

/**
 * Export the collection as a CSV file.
 * Flattens folder structure into a column.
 */
export async function exportAsCSV(): Promise<void> {
  const { folders, cards } = await collectionStore.exportCollection();
  const folderMap = new Map(folders.map((f) => [f.id, f.name]));

  const headers = [
    "Folder",
    "Name",
    "Set",
    "Collector Number",
    "Quantity",
    "Condition",
    "Notes",
    "Scryfall ID",
    "Date Added",
  ];

  const rows = cards.map((card) => [
    folderMap.get(card.folderId) || "Unknown",
    card.name,
    card.setCode.toUpperCase(),
    card.collectorNumber,
    card.quantity.toString(),
    card.condition,
    card.notes,
    card.scryfallId,
    card.dateAdded,
  ]);

  const csv = [
    headers.join(","),
    ...rows.map((row) => row.map(escapeCSV).join(",")),
  ].join("\n");

  downloadFile(csv, "mtg-collection.csv", "text/csv");
}

/**
 * Import a collection from a JSON file.
 * Prompts the user to select a file.
 */
export async function importFromJSON(): Promise<{ folders: number; cards: number }> {
  const file = await selectFile(".json");
  if (!file) throw new Error("No file selected");

  const text = await file.text();
  const data: ExportData = JSON.parse(text);

  if (data.version !== 1) {
    throw new Error(`Unsupported export version: ${data.version}`);
  }

  await collectionStore.importCollection({
    folders: data.folders,
    cards: data.cards,
  });

  return {
    folders: data.folders.length,
    cards: data.cards.length,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function downloadFile(content: string, filename: string, mimeType: string): void {
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

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
