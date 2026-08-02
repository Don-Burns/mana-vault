/**
 * Hash Matcher
 *
 * Finds the closest matching card(s) in the hash database given
 * a query pHash and dHash. Uses Hamming distance for comparison.
 *
 * The database holds two hash pairs per illustration — one derived from the art
 * crop and one from the whole card image — and every search targets exactly one
 * of them via the `space` argument. They are not interchangeable: a query hashed
 * from an art crop must be compared against art hashes, and a query hashed from
 * an uncropped card against full-card hashes.
 */

import { HashDB } from "./hashdb.ts";

/**
 * Which hash space to search.
 *
 * - `"art"`: hashes of the art crop. Invariant to frame treatment, set symbol
 *   and language, so these match reprints whose frame differs from the one in
 *   the database.
 * - `"full"`: hashes of the whole card. Needs no art-region crop, so these are
 *   what identify showcase / borderless / extended-art layouts, where no fixed
 *   rectangle frames the art reliably.
 */
export type HashSpace = "art" | "full";

/** Resolve the (pHash, dHash) arrays backing a hash space. */
function hashArrays(
  db: HashDB,
  space: HashSpace,
): { pHashes: BigUint64Array; dHashes: BigUint64Array } {
  return space === "full"
    ? { pHashes: db.getFullPHashes(), dHashes: db.getFullDHashes() }
    : { pHashes: db.getPHashes(), dHashes: db.getDHashes() };
}

export interface MatchResult {
  illustrationId: string;
  index: number;
  pHashDistance: number;
  dHashDistance: number;
  combinedScore: number; // Lower is better (0 = perfect match)
  confidence: number; // 0-100%, higher is better
}

/**
 * Find the top-N closest matches for a given hash pair.
 *
 * @param db - The loaded hash database
 * @param queryPHash - pHash of the scanned image
 * @param queryDHash - dHash of the scanned image
 * @param topN - Number of results to return (default 5)
 * @param space - Which hash space the query was computed in (default "art")
 * @returns Array of matches sorted by combined score (best first)
 */
export function findMatches(
  db: HashDB,
  queryPHash: bigint,
  queryDHash: bigint,
  topN = 5,
  space: HashSpace = "art",
): MatchResult[] {
  if (space === "full" && !db.hasFullCardHashes) return [];

  const { pHashes, dHashes } = hashArrays(db, space);
  const size = db.size;

  // Brute-force search over all entries
  // For ~50k entries with 64-bit hashes, this takes < 5ms
  const results: MatchResult[] = [];

  for (let i = 0; i < size; i++) {
    // An all-zero pair means this illustration had no image in that space at
    // build time. Comparing against it would score any near-zero query highly.
    if (pHashes[i] === 0n && dHashes[i] === 0n) continue;

    const pDist = hammingDistance64(queryPHash, pHashes[i]);
    const dDist = hammingDistance64(queryDHash, dHashes[i]);

    // Combined score: weighted average of both distances
    // pHash is generally more reliable, so weight it higher
    const combined = pDist * 0.6 + dDist * 0.4;

    // Only keep candidates within a reasonable threshold
    // Max Hamming distance for 64-bit is 64; anything above 20 is very unlikely
    if (combined < 25) {
      results.push({
        illustrationId: db.getIllustrationId(i),
        index: i,
        pHashDistance: pDist,
        dHashDistance: dDist,
        combinedScore: combined,
        confidence: scoreToConfidence(combined),
      });
    }
  }

  // Sort by combined score (ascending = best first)
  results.sort((a, b) => a.combinedScore - b.combinedScore);

  return results.slice(0, topN);
}

/**
 * Find matches within a subset of the database (e.g., cards in a specific folder).
 * Used for scan-to-select mode.
 *
 * @param db - The loaded hash database
 * @param queryPHash - pHash of the scanned image
 * @param queryDHash - dHash of the scanned image
 * @param illustrationIds - Set of illustration IDs to search within
 * @param topN - Number of results to return
 * @param space - Which hash space the query was computed in (default "art")
 */
export function findMatchesInSubset(
  db: HashDB,
  queryPHash: bigint,
  queryDHash: bigint,
  illustrationIds: Set<string>,
  topN = 5,
  space: HashSpace = "art",
): MatchResult[] {
  if (space === "full" && !db.hasFullCardHashes) return [];

  const { pHashes, dHashes } = hashArrays(db, space);
  const size = db.size;
  const results: MatchResult[] = [];

  for (let i = 0; i < size; i++) {
    const id = db.getIllustrationId(i);
    if (!illustrationIds.has(id)) continue;
    if (pHashes[i] === 0n && dHashes[i] === 0n) continue;

    const pDist = hammingDistance64(queryPHash, pHashes[i]);
    const dDist = hammingDistance64(queryDHash, dHashes[i]);
    const combined = pDist * 0.6 + dDist * 0.4;

    results.push({
      illustrationId: id,
      index: i,
      pHashDistance: pDist,
      dHashDistance: dDist,
      combinedScore: combined,
      confidence: scoreToConfidence(combined),
    });
  }

  results.sort((a, b) => a.combinedScore - b.combinedScore);
  return results.slice(0, topN);
}

/**
 * Compute Hamming distance between two 64-bit values.
 * Returns the number of differing bits (0-64).
 */
function hammingDistance64(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;

  // Brian Kernighan's algorithm
  while (xor !== 0n) {
    xor &= xor - 1n;
    count++;
  }

  return count;
}

/**
 * Convert a combined hash distance score to a confidence percentage.
 *
 * Score 0 → 100% confidence (perfect match)
 * Score 10 → ~75% confidence (likely match)
 * Score 20 → ~25% confidence (weak match)
 * Score 25+ → 0% confidence (no match)
 */
function scoreToConfidence(score: number): number {
  if (score <= 0) return 100;
  if (score >= 25) return 0;

  // Exponential decay: confidence drops faster as score increases
  return Math.round(100 * Math.exp(-score * 0.12));
}
