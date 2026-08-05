/**
 * Card name search over the local card metadata (public/db/metadata.json).
 * Pure lookup, no network/API calls — reuses data already bundled offline.
 */

export interface CardMetadata {
  illustrations: Record<string, {
    oracle_id: string;
    name: string;
    cmc: number;
    colors: string[];
    printings: {
      id: string;
      set: string;
      set_name: string;
      collector_number: string;
      lang: string;
      released_at: string;
      rarity: string;
    }[];
  }>;
}

/**
 * Search the local card metadata by name substring (case-insensitive).
 * Used to populate the manual "Add Card" autocomplete in staging review.
 */
export function searchCards(
  metadata: CardMetadata,
  query: string,
  limit = 8,
) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return Object.entries(metadata.illustrations)
    .filter(([, ill]) => ill.name.toLowerCase().includes(q))
    .slice(0, limit)
    .map(([illustrationId, ill]) => ({ illustrationId, ...ill }));
}

/** Most recent English printing of an illustration, falling back to its first printing. */
export function defaultPrintingFor(
  illustration: CardMetadata["illustrations"][string],
) {
  return illustration.printings
    .filter((p) => p.lang === "en")
    .sort((a, b) => b.released_at.localeCompare(a.released_at))[0] ||
    illustration.printings[0];
}
