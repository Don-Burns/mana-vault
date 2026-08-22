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

/** Most recent English printing of an illustration, falling back to its first printing. */
export function defaultPrintingFor(
  illustration: CardMetadata["illustrations"][string],
) {
  return illustration.printings
    .filter((p) => p.lang === "en")
    .sort((a, b) => b.released_at.localeCompare(a.released_at))[0] ||
    illustration.printings[0];
}

/**
 * Search the local card metadata by name substring, deduped to one result
 * per unique card name (a name can span multiple illustration IDs — one per
 * reprint with new art — which would otherwise show as duplicate rows).
 */
export function groupedCardSearch(
  metadata: CardMetadata,
  query: string,
  limit = 8,
): { name: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const names = new Set<string>();
  for (const ill of Object.values(metadata.illustrations)) {
    if (ill.name.toLowerCase().includes(q)) names.add(ill.name);
  }
  return [...names].slice(0, limit).map((name) => ({ name }));
}

export interface Printing {
  id: string;
  set: string;
  set_name: string;
  collector_number: string;
  lang: string;
  released_at: string;
  rarity: string;
  illustrationId: string;
}

/**
 * All printings of a card name, across every illustration (art variant)
 * sharing that name, most recent first. Used to populate the printing
 * picker with the full set of versions a user could select.
 */
export function printingsForName(
  metadata: CardMetadata,
  name: string,
): Printing[] {
  const printings: Printing[] = [];
  for (const [illustrationId, ill] of Object.entries(metadata.illustrations)) {
    if (ill.name !== name) continue;
    for (const p of ill.printings) {
      printings.push({ ...p, illustrationId });
    }
  }
  return printings.sort((a, b) => b.released_at.localeCompare(a.released_at));
}

export function searchByForExactPrinting(
  name: string,
  set: string,
  collector_number: string,
  metadata: CardMetadata,
): Printing | null {
  for (const printing of printingsForName(metadata, name)) {
    if (
      printing.set === set && printing.collector_number === collector_number
    ) {
      return printing;
    }
  }
  return null;
}
