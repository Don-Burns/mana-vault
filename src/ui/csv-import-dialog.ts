/**
 * CSV Import Dialog
 *
 * Small overlay offering the two ways to get CSV data in: pick a .csv file,
 * or paste the data directly into a text box. Resolves with the raw CSV
 * text once the user submits either path, or `null` if they cancel.
 */

import { selectFile } from "../collection/export.ts";

export function showCsvImportDialog(
  container: HTMLElement,
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "csv-import-overlay";
    overlay.innerHTML = `
      <div class="csv-import-dialog">
        <div class="csv-import-header">
          <h2>Import CSV</h2>
          <button class="btn-sm" id="btn-close-csv-import">Close</button>
        </div>
        <button class="btn-sm" id="btn-csv-choose-file">Choose File…</button>
        <p class="csv-import-or">or paste CSV data</p>
        <textarea id="csv-import-textarea" class="csv-import-textarea"
          placeholder="name,set,collector_number,quantity&#10;Lightning Strike,m19,2,1" rows="8"></textarea>
        <div class="csv-import-actions">
          <button class="btn-primary" id="btn-csv-import-submit">Import</button>
        </div>
      </div>
    `;
    container.appendChild(overlay);

    const settle = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };

    overlay.querySelector("#btn-close-csv-import")!.addEventListener(
      "click",
      () => settle(null),
    );
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) settle(null);
    });

    overlay.querySelector("#btn-csv-choose-file")!.addEventListener(
      "click",
      async () => {
        const file = await selectFile(".csv");
        if (!file) return;
        settle(await file.text());
      },
    );

    const textarea = overlay.querySelector<HTMLTextAreaElement>(
      "#csv-import-textarea",
    )!;
    overlay.querySelector("#btn-csv-import-submit")!.addEventListener(
      "click",
      () => {
        if (!textarea.value.trim()) return;
        settle(textarea.value);
      },
    );
  });
}
