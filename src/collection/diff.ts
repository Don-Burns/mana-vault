/**
 * Row-level diff between a folder's contents before and after a pending
 * merge-viewer operation (add/remove/move). Rows are matched by scryfallId.
 */

export interface DiffableCard {
  scryfallId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  quantity: number;
}

export type DiffKind = "added" | "removed" | "increased" | "decreased" | "unchanged";

export interface DiffRow<T extends DiffableCard> {
  card: T;
  before: number;
  after: number;
  kind: DiffKind;
}

function kindFor(before: number, after: number): DiffKind {
  if (before === 0) return "added";
  if (after === 0) return "removed";
  if (after > before) return "increased";
  if (after < before) return "decreased";
  return "unchanged";
}

/**
 * Compute a diff between two card lists (same folder, before vs. after a
 * pending operation). Cards are matched by `scryfallId`. A card present in
 * only one list is a full add/remove; present in both with a different
 * quantity is an increase/decrease.
 */
export function computeDiff<T extends DiffableCard>(
  before: T[],
  after: T[],
): DiffRow<T>[] {
  const beforeByCard = new Map(before.map((c) => [c.scryfallId, c]));
  const afterByCard = new Map(after.map((c) => [c.scryfallId, c]));
  const ids = new Set([...beforeByCard.keys(), ...afterByCard.keys()]);

  const rows: DiffRow<T>[] = [];
  for (const id of ids) {
    const beforeCard = beforeByCard.get(id);
    const afterCard = afterByCard.get(id);
    const beforeQty = beforeCard?.quantity ?? 0;
    const afterQty = afterCard?.quantity ?? 0;
    rows.push({
      card: (afterCard ?? beforeCard)!,
      before: beforeQty,
      after: afterQty,
      kind: kindFor(beforeQty, afterQty),
    });
  }
  return rows;
}
