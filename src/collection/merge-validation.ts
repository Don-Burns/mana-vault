/**
 * Validates folder selection before a scan-to-collection merge (add/remove/
 * move) is allowed to proceed.
 */
export type MergeMode = "add" | "remove" | "move";

export function validateMergeSelection(
  mode: MergeMode,
  destinationFolderId: string | null,
  secondaryFolderId: string | null,
): string | null {
  if (!destinationFolderId) return "Select a folder before continuing.";
  if (mode === "move") {
    if (!secondaryFolderId) return "Select a destination folder to move to.";
    if (secondaryFolderId === destinationFolderId) {
      return "Choose two different folders to move between.";
    }
  }
  return null;
}
