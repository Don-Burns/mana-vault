/**
 * Card list ordering, shared by the merge viewer (and usable elsewhere) so
 * every panel in a comparison lines up under the same ordering criteria.
 */

export type SortMethod = "name" | "set" | "quantity" | "cmc" | "color" | "rarity";

export interface SortCriterion {
  method: SortMethod;
  direction: "asc" | "desc";
}

/** Default criteria when the merge viewer opens: color, then CMC, then name. */
export const DEFAULT_SORT_CRITERIA: SortCriterion[] = [
  { method: "color", direction: "asc" },
  { method: "cmc", direction: "asc" },
  { method: "name", direction: "asc" },
];

/** Minimal shape sortCards needs — satisfied by both CardEntry and StagedCard. */
export interface SortableCard {
  name: string;
  setCode: string;
  collectorNumber: string;
  quantity: number;
  cmc?: number;
  colors?: string[];
  rarity?: string;
}

const RARITY_ORDER: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  mythic: 3,
};

// WUBRG order, colorless last-but-one, multicolor last.
const COLOR_ORDER = ["W", "U", "B", "R", "G"];

function colorRank(colors: string[] | undefined): number {
  if (!colors || colors.length === 0) return COLOR_ORDER.length; // colorless
  if (colors.length > 1) return COLOR_ORDER.length + 1; // multicolor
  const i = COLOR_ORDER.indexOf(colors[0]);
  return i === -1 ? COLOR_ORDER.length : i;
}

/**
 * Sort key extractor for a single field. Returns `undefined` when the card
 * has no value for that field — such cards always sort last regardless of
 * direction; direction only reorders cards that do have a value.
 */
function keyFor<T extends SortableCard>(method: SortMethod): (card: T) => string | number | undefined {
  switch (method) {
    case "quantity":
      return (c) => c.quantity;
    case "cmc":
      return (c) => c.cmc;
    case "color":
      return (c) => colorRank(c.colors);
    case "rarity":
      return (c) => c.rarity == null ? undefined : RARITY_ORDER[c.rarity];
    case "name":
      return (c) => c.name;
    case "set":
    default:
      return () => undefined; // handled specially in compareCards below
  }
}

/**
 * Chain criteria in priority order; each is flipped for "desc" (missing
 * values always sort last, unaffected by direction). A stable name (asc)
 * tiebreak is always appended last so ties don't jitter.
 */
export function compareCards<T extends SortableCard>(
  criteria: SortCriterion[],
): (a: T, b: T) => number {
  return (a, b) => {
    for (const { method, direction } of criteria) {
      const sign = direction === "desc" ? -1 : 1;

      if (method === "set") {
        const cmp = a.setCode.localeCompare(b.setCode) ||
          a.collectorNumber.localeCompare(b.collectorNumber, undefined, { numeric: true });
        if (cmp !== 0) return sign * cmp;
        continue;
      }

      const key = keyFor<T>(method);
      const ka = key(a);
      const kb = key(b);
      if (ka == null && kb == null) continue;
      if (ka == null) return 1;
      if (kb == null) return -1;
      const cmp = typeof ka === "number" ? ka - (kb as number) : ka.localeCompare(kb as string);
      if (cmp !== 0) return sign * cmp;
    }
    return a.name.localeCompare(b.name);
  };
}

/** Returns a new sorted array; does not mutate the input. */
export function sortCards<T extends SortableCard>(cards: T[], criteria: SortCriterion[]): T[] {
  return [...cards].sort(compareCards<T>(criteria));
}
