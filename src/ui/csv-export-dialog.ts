/**
 * CSV Export Dialog
 *
 * Lets the user pick what to export (whole collection or one folder) and
 * where it goes: a downloaded .csv file, or the clipboard.
 */

import type { Folder } from "../collection/store.ts";
import { exportCardsAsCsv } from "../collection/export.ts";
import { showToast } from "./toast.ts";

export function showCsvExportDialog(
  container: HTMLElement,
  folders: Folder[],
): void {
  const overlay = document.createElement("div");
  overlay.className = "csv-import-overlay";
  overlay.innerHTML = `
    <div class="csv-import-dialog">
      <div class="csv-import-header">
        <h2>Export CSV</h2>
        <button class="btn-sm" id="btn-close-csv-export">Close</button>
      </div>
      <select id="csv-export-scope">
        <option value="">Whole collection</option>
        ${
    folders.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`)
      .join("")
  }
      </select>
      <div class="csv-import-actions">
        <button class="btn-sm" id="btn-csv-export-clipboard">Copy to Clipboard</button>
        <button class="btn-primary" id="btn-csv-export-file">Download File</button>
      </div>
    </div>
  `;
  container.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector("#btn-close-csv-export")!.addEventListener(
    "click",
    close,
  );
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const scopeSelect = overlay.querySelector<HTMLSelectElement>(
    "#csv-export-scope",
  )!;

  async function run(destination: "file" | "clipboard") {
    try {
      await exportCardsAsCsv(scopeSelect.value || null, destination);
      showToast(
        destination === "clipboard"
          ? "Copied CSV to clipboard."
          : "CSV downloaded.",
      );
      close();
    } catch (err) {
      alert(`Export failed: ${(err as Error).message}`);
    }
  }

  overlay.querySelector("#btn-csv-export-file")!.addEventListener(
    "click",
    () => run("file"),
  );
  overlay.querySelector("#btn-csv-export-clipboard")!.addEventListener(
    "click",
    () => run("clipboard"),
  );
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
