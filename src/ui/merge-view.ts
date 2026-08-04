/**
 * Merge Viewer
 *
 * A diff-style preview shown before committing a staging confirm or a
 * collection move: one plain panel for the staging list plus one diffed
 * panel per real collection touched by the operation (git-diff style: red =
 * removal/decrease, green = addition/increase), all sharing a single
 * ordering control so rows line up across panels.
 */

import { type DiffableCard, computeDiff, type DiffRow } from "../collection/diff.ts";
import {
  compareCards,
  DEFAULT_SORT_CRITERIA,
  type SortableCard,
  type SortCriterion,
  type SortMethod,
} from "../collection/sort.ts";

type MergeCard = SortableCard & DiffableCard;

export interface MergePanel {
  title: string;
  /** Folder contents before the operation. */
  before: MergeCard[];
  /** Folder contents after the operation would be applied. */
  after: MergeCard[];
}

export interface MergeViewOptions {
  /** Element to mount the overlay into (typically the calling view's root). */
  container: HTMLElement;
  /** Plain (undiffed) staging list — "what you're about to apply". */
  stagingCards: MergeCard[];
  /** One panel per real collection affected (1 for add/remove, 2 for move). */
  panels: MergePanel[];
  /** Count of scanned cards that couldn't be resolved to a folder entry. */
  skippedCount?: number;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  onCancel?: () => void;
}

const SORT_FIELDS: { value: SortMethod; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "set", label: "Set + collector number" },
  { value: "quantity", label: "Quantity" },
  { value: "cmc", label: "Mana value (CMC)" },
  { value: "color", label: "Color" },
  { value: "rarity", label: "Rarity" },
];

export function openMergeView(options: MergeViewOptions): void {
  // Check order = priority order; unchecking then rechecking a field
  // re-appends it at the end rather than restoring its old position.
  let criteria: SortCriterion[] = DEFAULT_SORT_CRITERIA.map((c) => ({ ...c }));

  const overlay = document.createElement("div");
  overlay.className = "merge-view-overlay";
  render();
  options.container.appendChild(overlay);

  function render() {
    overlay.innerHTML = `
      <div class="merge-view">
        <div class="merge-view-header">
          <h2>Review Changes</h2>
          <button class="btn-sm" id="merge-cancel">Cancel</button>
        </div>
        <div class="merge-sort-controls">
          ${SORT_FIELDS.map((f) => renderSortFieldRow(f, criteria)).join("")}
        </div>
        <div class="merge-view-panels">
          <div class="merge-panel">
            <h3>Staging</h3>
            <div class="merge-panel-rows">
              ${
      [...options.stagingCards].sort(compareCards(criteria)).map(renderPlainRow).join("")
    }
            </div>
          </div>
          ${options.panels.map((panel) => renderDiffPanel(panel, criteria)).join("")}
        </div>
        ${
      options.skippedCount
        ? `<div class="merge-skipped">${options.skippedCount} card(s) skipped (not found in folder)</div>`
        : ""
    }
        <div class="merge-view-actions">
          <button class="btn-sm" id="merge-cancel-2">Cancel</button>
          <button class="btn-primary" id="merge-confirm">${options.confirmLabel}</button>
        </div>
      </div>
    `;

    overlay.querySelectorAll<HTMLInputElement>(".merge-sort-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => {
        const method = cb.dataset.method as SortMethod;
        if (cb.checked) {
          criteria = [...criteria, { method, direction: "asc" }];
        } else {
          criteria = criteria.filter((c) => c.method !== method);
        }
        render();
      });
    });
    overlay.querySelectorAll<HTMLButtonElement>(".merge-sort-direction").forEach((btn) => {
      btn.addEventListener("click", () => {
        const method = btn.dataset.method as SortMethod;
        criteria = criteria.map((c) =>
          c.method === method ? { ...c, direction: c.direction === "asc" ? "desc" : "asc" } : c
        );
        render();
      });
    });
    overlay.querySelector("#merge-cancel")!.addEventListener("click", cancel);
    overlay.querySelector("#merge-cancel-2")!.addEventListener("click", cancel);
    overlay.querySelector("#merge-confirm")!.addEventListener("click", async () => {
      await options.onConfirm();
      overlay.remove();
    });
  }

  function cancel() {
    options.onCancel?.();
    overlay.remove();
  }
}

function renderSortFieldRow(
  field: { value: SortMethod; label: string },
  criteria: SortCriterion[],
): string {
  const index = criteria.findIndex((c) => c.method === field.value);
  const active = index !== -1;
  const priorityBadge = active ? `<span class="merge-sort-priority">${index + 1}</span>` : "";
  const directionBtn = active
    ? `<button type="button" class="btn-sm merge-sort-direction" data-method="${field.value}">${
      criteria[index].direction === "asc" ? "\u2191 asc" : "\u2193 desc"
    }</button>`
    : "";
  return `
    <label class="merge-sort-field">
      <input type="checkbox" class="merge-sort-checkbox" data-method="${field.value}" ${
    active ? "checked" : ""
  }>
      ${priorityBadge}
      <span>${field.label}</span>
      ${directionBtn}
    </label>
  `;
}

function renderDiffPanel(panel: MergePanel, criteria: SortCriterion[]): string {
  const rows = computeDiff(panel.before, panel.after)
    .sort((a, b) => compareCards<MergeCard>(criteria)(a.card, b.card));
  return `
    <div class="merge-panel">
      <h3>${escapeHtml(panel.title)}</h3>
      <div class="merge-panel-rows">
        ${rows.map(renderDiffRow).join("")}
      </div>
    </div>
  `;
}

function renderPlainRow(card: MergeCard): string {
  return `
    <div class="merge-row">
      <span class="merge-row-name">${escapeHtml(card.name)}</span>
      <span class="merge-row-set">${card.setCode.toUpperCase()} #${card.collectorNumber}</span>
      <span class="merge-row-qty">&times;${card.quantity}</span>
    </div>
  `;
}

function renderDiffRow(row: DiffRow<MergeCard>): string {
  const rowClass = row.kind === "added"
    ? "diff-row-added"
    : row.kind === "removed"
    ? "diff-row-removed"
    : "";
  const qtyClass = row.kind === "increased"
    ? "diff-count-up"
    : row.kind === "decreased"
    ? "diff-count-down"
    : "";
  const qtyText = row.kind === "increased" || row.kind === "decreased"
    ? `${row.before} \u2192 <span class="${qtyClass}">${row.after}</span>`
    : `&times;${row.after || row.before}`;

  return `
    <div class="merge-row ${rowClass}">
      <span class="merge-row-name">${escapeHtml(row.card.name)}</span>
      <span class="merge-row-set">${row.card.setCode.toUpperCase()} #${row.card.collectorNumber}</span>
      <span class="merge-row-qty">${qtyText}</span>
    </div>
  `;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
