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

export type MergeCard = SortableCard & DiffableCard;

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
          ${renderPanels(options.stagingCards, options.panels, criteria)}
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

    syncPanelScroll(overlay);
  }

  function cancel() {
    options.onCancel?.();
    overlay.remove();
  }
}

/**
 * Rows share the same fixed height and slot order across every column (see
 * `buildMergeSlots`), so mirroring raw `scrollTop` between panels keeps
 * matching rows aligned as any one of them scrolls.
 */
function syncPanelScroll(overlay: HTMLElement): void {
  const panels = [...overlay.querySelectorAll<HTMLElement>(".merge-panel-rows")];
  let syncing = false;
  for (const panel of panels) {
    panel.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      for (const other of panels) {
        if (other !== panel) other.scrollTop = panel.scrollTop;
      }
      syncing = false;
    });
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

/** How many unchanged neighbor rows to keep on each side of a change in a target panel. */
export const CONTEXT_SIZE = 2;

export type MergeSlot = { type: "row"; index: number } | { type: "ellipsis" };

/**
 * Builds a single shared row order (keyed by scryfallId, sorted by
 * `criteria`) for the staging list and all target panels, so a card's row
 * lands at the same slot index in every column. A master index collapses
 * into a shared "..." slot only if no column needs it: it's absent from
 * staging, and in every panel it's either missing or unchanged and further
 * than CONTEXT_SIZE rows (within that panel's own rows) from any change.
 */
export function buildMergeSlots(
  stagingCards: MergeCard[],
  panels: MergePanel[],
  criteria: SortCriterion[],
): { slots: MergeSlot[]; masterKeys: string[]; panelRowsByKey: Map<string, DiffRow<MergeCard>>[] } {
  const stagingByKey = new Map(stagingCards.map((c) => [c.scryfallId, c]));
  const panelRows = panels.map((panel) => computeDiff(panel.before, panel.after));
  const panelRowsByKey = panelRows.map((rows) => new Map(rows.map((r) => [r.card.scryfallId, r])));

  const masterCards = new Map<string, MergeCard>();
  for (const c of stagingCards) masterCards.set(c.scryfallId, c);
  for (const rows of panelRows) for (const r of rows) {
    if (!masterCards.has(r.card.scryfallId)) masterCards.set(r.card.scryfallId, r.card);
  }
  const masterKeys = [...masterCards.values()]
    .sort(compareCards<MergeCard>(criteria))
    .map((c) => c.scryfallId);

  // For each panel, find which master indices it wants to keep: any row it
  // has that is changed, plus up to CONTEXT_SIZE neighbors it also has data
  // for (skipping over master indices this panel has no data for).
  const panelKeep = panelRowsByKey.map((byKey) => {
    const indicesWithRow = masterKeys
      .map((key, i) => ({ i, has: byKey.has(key) }))
      .filter((x) => x.has)
      .map((x) => x.i);
    const changed = indicesWithRow.filter((i) => byKey.get(masterKeys[i])!.kind !== "unchanged");
    const keep = new Set<number>();
    for (const ci of changed) {
      const pos = indicesWithRow.indexOf(ci);
      for (let d = -CONTEXT_SIZE; d <= CONTEXT_SIZE; d++) {
        const j = indicesWithRow[pos + d];
        if (j !== undefined) keep.add(j);
      }
    }
    return keep;
  });

  const sharedKeep = (i: number) =>
    stagingByKey.has(masterKeys[i]) || panelKeep.some((keep) => keep.has(i));

  const slots: MergeSlot[] = [];
  let i = 0;
  while (i < masterKeys.length) {
    if (sharedKeep(i)) {
      slots.push({ type: "row", index: i });
      i++;
      continue;
    }
    while (i < masterKeys.length && !sharedKeep(i)) i++;
    slots.push({ type: "ellipsis" });
  }

  return { slots, masterKeys, panelRowsByKey };
}

/**
 * Renders the staging column plus one column per target panel using the
 * shared slot order from `buildMergeSlots`, so matching rows line up
 * vertically and long unchanged runs collapse to a single "..." row.
 */
function renderPanels(
  stagingCards: MergeCard[],
  panels: MergePanel[],
  criteria: SortCriterion[],
): string {
  const stagingByKey = new Map(stagingCards.map((c) => [c.scryfallId, c]));
  const { slots, masterKeys, panelRowsByKey } = buildMergeSlots(stagingCards, panels, criteria);

  const stagingHtml = slots.map((slot) => {
    if (slot.type === "ellipsis") return `<div class="merge-row-spacer"></div>`;
    const card = stagingByKey.get(masterKeys[slot.index]);
    return card ? renderPlainRow(card) : `<div class="merge-row-spacer"></div>`;
  }).join("");

  const panelsHtml = panels.map((panel, p) => {
    const byKey = panelRowsByKey[p];
    const rowsHtml = slots.map((slot) => {
      if (slot.type === "ellipsis") return `<div class="merge-row-ellipsis">&hellip;</div>`;
      const row = byKey.get(masterKeys[slot.index]);
      return row ? renderDiffRow(row) : `<div class="merge-row-spacer"></div>`;
    }).join("");
    return `
      <div class="merge-panel">
        <h3>${escapeHtml(panel.title)}</h3>
        <div class="merge-panel-rows">${rowsHtml}</div>
      </div>
    `;
  }).join("");

  return `
    <div class="merge-panel">
      <h3>Staging</h3>
      <div class="merge-panel-rows">${stagingHtml}</div>
    </div>
    ${panelsHtml}
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
