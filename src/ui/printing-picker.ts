/**
 * Printing Picker
 *
 * Reusable overlay showing every printing of a card (image + set + collector
 * number + rarity) so the user can pick the exact version. Used for manual
 * "Add Card" in staging (search returns unique names; this picks the
 * printing), and for changing the printing of an existing staged/collection
 * entry.
 */

import { getCardImageUrl } from "../collection/card-image.ts";

export interface PickablePrinting {
  id: string;
  set: string;
  set_name: string;
  collector_number: string;
  lang: string;
  rarity: string;
}

export interface PrintingPickerOptions<T extends PickablePrinting> {
  /** Element to mount the overlay into. */
  container: HTMLElement;
  cardName: string;
  printings: T[];
  /** Highlights the currently-selected printing, if any. */
  currentScryfallId?: string;
  onSelect: (printing: T) => void;
  onCancel?: () => void;
}

export async function showPrintingPicker<T extends PickablePrinting>(
  options: PrintingPickerOptions<T>,
): Promise<void> {
  const { container, cardName, printings, currentScryfallId, onSelect } =
    options;

  const overlay = document.createElement("div");
  overlay.className = "printing-picker-overlay";
  overlay.innerHTML = `
    <div class="printing-picker">
      <div class="printing-picker-header">
        <h2>Choose Printing — ${escapeHtml(cardName)}</h2>
        <button class="btn-sm" id="btn-close-printing-picker">Close</button>
      </div>
      <div class="printing-picker-grid" id="printing-picker-grid">
        <p class="printing-picker-loading">Loading printings…</p>
      </div>
    </div>
  `;
  container.appendChild(overlay);

  const close = () => {
    overlay.remove();
    options.onCancel?.();
  };
  overlay.querySelector("#btn-close-printing-picker")!.addEventListener(
    "click",
    close,
  );
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const grid = overlay.querySelector<HTMLElement>("#printing-picker-grid")!;
  const cards = await Promise.all(
    printings.map((p, i) => renderPrintingOption(p, i, currentScryfallId)),
  );
  grid.innerHTML = cards.join("");

  grid.querySelectorAll<HTMLElement>(".printing-option").forEach((card) => {
    card.addEventListener("click", () => {
      const index = Number(card.dataset.index);
      overlay.remove();
      onSelect(printings[index]);
    });
  });
}

async function renderPrintingOption(
  printing: PickablePrinting,
  index: number,
  currentScryfallId: string | undefined,
): Promise<string> {
  const isCurrent = printing.id === currentScryfallId;
  return `
    <div class="printing-option ${isCurrent ? "printing-option-current" : ""}"
      data-index="${index}">
      <img class="printing-option-thumb" crossorigin="anonymous"
        src="${await getCardImageUrl(printing.id)}" alt="" loading="lazy"
        onerror="this.classList.add('card-thumb-blank');this.removeAttribute('src')" />
      <div class="printing-option-info">
        <span class="printing-option-set">${printing.set_name}</span>
        <span class="printing-option-meta">${printing.set.toUpperCase()} #${printing.collector_number} · ${printing.rarity}</span>
      </div>
    </div>
  `;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
