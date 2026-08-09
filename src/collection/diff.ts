/**
 * Row-level diff between a folder's contents before and after a pending
 * merge-viewer operation (add/remove/move), plus the shared helpers that
 * build the "after" card list an add/remove/move would produce. Used both
 * to render the merge-view preview and to drive the actual commit (see
 * `store.ts`'s `commitAdd`/`commitRemove`/`commitMove`), so the preview and
 * the real write are always the same computation. Rows are matched by
 * scryfallId, falling back to illustrationId (any printing of the same
 * artwork) when an exact printing match isn't found.
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

/** A card matchable by exact printing or, failing that, by artwork. */
export interface MatchableCard extends DiffableCard {
  illustrationId: string;
}

/**
 * Find a card in `cards` matching `item`: exact printing (scryfallId) first,
 * then any printing of the same artwork (illustrationId) as a fallback.
 */
export function findMatch<T extends MatchableCard>(
  cards: readonly T[],
  item: { scryfallId: string; illustrationId: string },
): T | undefined {
  return cards.find((c) => c.scryfallId === item.scryfallId) ??
    cards.find((c) => c.illustrationId === item.illustrationId);
}

/**
 * Simulate adding `items` to `cards`: merges quantity into a matching
 * existing printing (exact scryfallId match only — a new printing of an
 * existing illustration is still a distinct row), or appends a new row via
 * `makeNew` for anything unmatched.
 */
export function simulateAdd<T extends MatchableCard, I extends { scryfallId: string; quantity: number }>(
  cards: readonly T[],
  items: readonly I[],
  makeNew: (item: I) => T,
): T[] {
  const result = cards.map((c) => ({ ...c }));
  for (const item of items) {
    const existing = result.find((c) => c.scryfallId === item.scryfallId);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      result.push(makeNew(item));
    }
  }
  return result;
}

/**
 * Simulate removing `items`' quantities from `cards` (matched via
 * `findMatch`). Cards that would drop to 0 are dropped entirely. Items with
 * no match are silently skipped (caller is responsible for counting those).
 */
export function simulateRemove<T extends MatchableCard>(
  cards: readonly T[],
  items: readonly { scryfallId: string; illustrationId: string; quantity: number }[],
): T[] {
  const result = cards.map((c) => ({ ...c }));
  for (const item of items) {
    const entry = findMatch(result, item);
    if (!entry) continue;
    entry.quantity = Math.max(0, entry.quantity - item.quantity);
  }
  return result.filter((c) => c.quantity > 0);
}

/**
 * Resolve each item against `sourceCards` (via `findMatch`) and clamp its
 * quantity to what's actually available there — can't move/remove more
 * than exists. Items with no match are dropped (compare `.length` against
 * the input to count skips). The resulting cards use the *matched entry's*
 * fields, not the item's — the entry may be a different printing of the
 * same illustration than what was staged/selected.
 */
export function clampToSource<T extends MatchableCard>(
  sourceCards: readonly T[],
  items: readonly { scryfallId: string; illustrationId: string; quantity: number }[],
): T[] {
  const result: T[] = [];
  for (const item of items) {
    const entry = findMatch(sourceCards, item);
    if (!entry) continue;
    result.push({ ...entry, quantity: Math.min(item.quantity, entry.quantity) });
  }
  return result;
}

