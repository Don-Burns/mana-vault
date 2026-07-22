/**
 * Card Identification Orchestration
 *
 * Ties the geometric detection pipeline together with perceptual-hash matching
 * and — crucially — resolves card orientation.
 *
 * `detectCardInMat` locates a card-shaped quad and warps it upright, but has no
 * way to tell which side is the top. The card may have been photographed
 * rotated, or the source image may carry an unapplied EXIF orientation. Rather
 * than guessing, we hash the art crop for all four 90° rotations and keep
 * whichever best matches the database.
 *
 * This module deliberately keeps the OpenCV-dependent work (`identifyCardInMat`)
 * separate from the pure hash-matching work (`matchArtOrientations`): in the
 * browser, OpenCV runs in a Web Worker while the hash database lives on the main
 * thread, so the worker produces the four art crops and the main thread matches
 * them. In tests (and anywhere OpenCV and the DB coexist) `identifyCardInMat`
 * runs the whole thing in one call.
 */

import {
  detectCardInMat,
  extractArtRegionsAllOrientations,
} from "./pipeline.ts";
import { computeHashesFromImageData } from "../matching/hasher.ts";
import {
  findMatches,
  findMatchesInSubset,
  type MatchResult,
} from "../matching/matcher.ts";
import type { HashDB } from "../matching/hashdb.ts";

/** Number of clockwise 90° turns applied to the warped card (0–3). */
export type Orientation = 0 | 1 | 2 | 3;

export interface IdentifyResult {
  /** True if a card shape was detected AND matched to the database. */
  matched: boolean;
  /** True if a card *shape* was detected, regardless of whether it matched. */
  detected: boolean;
  match?: MatchResult;
  /** Which 90° rotation of the warped card produced the best match. */
  orientation?: Orientation;
  /** Card-shape candidate quads found this frame (debug/visualisation). */
  candidates?: [number, number][][];
  /** Corners of the selected card quad, if one was detected. */
  corners?: [number, number][];
}

/**
 * Given the four orientation art crops of a detected card, find the best
 * database match across all of them.
 *
 * Pure (no OpenCV): safe to run on the main thread with the loaded hash DB.
 */
export function matchArtOrientations(
  db: HashDB,
  artRegions: ImageData[],
): { match: MatchResult; orientation: Orientation } | null {
  let best: { match: MatchResult; orientation: Orientation } | null = null;

  for (let i = 0; i < artRegions.length; i++) {
    const { pHash, dHash } = computeHashesFromImageData(artRegions[i]);
    const matches = findMatches(db, pHash, dHash, 1);
    if (matches.length === 0) continue;

    // get the best match across all orientations
    for (const match of matches) {
      if (!best || match.combinedScore < best.match.combinedScore) {
        best = { match, orientation: i as Orientation };
      }
    }
  }

  return best;
}

/**
 * Like {@link matchArtOrientations}, but restricts the search to a subset of
 * illustration IDs (e.g. the cards in a specific folder for scan-to-select).
 */
export function matchArtOrientationsInSubset(
  db: HashDB,
  artRegions: ImageData[],
  illustrationIds: Set<string>,
): { match: MatchResult; orientation: Orientation } | null {
  let best: { match: MatchResult; orientation: Orientation } | null = null;

  for (let i = 0; i < artRegions.length; i++) {
    const { pHash, dHash } = computeHashesFromImageData(artRegions[i]);
    const matches = findMatchesInSubset(db, pHash, dHash, illustrationIds, 1);
    if (matches.length === 0) continue;

    // get the best match across all orientations
    for (const match of matches) {
      if (!best || match.combinedScore < best.match.combinedScore) {
        best = { match, orientation: i as Orientation };
      }
    }
  }

  return best;
}

/**
 * Full identification from a source image Mat: detect the card, try every 90°
 * orientation, and return the best database match.
 *
 * Handles cleanup of all intermediate Mats internally.
 */
export function identifyCardInMat(
  // deno-lint-ignore no-explicit-any
  cv: any,
  // deno-lint-ignore no-explicit-any
  src: any,
  db: HashDB,
): IdentifyResult {
  const detection = detectCardInMat(cv, src);

  if (!detection.found || !detection.cardMat) {
    return {
      matched: false,
      detected: false,
      candidates: detection.candidates,
    };
  }

  try {
    const artRegions = extractArtRegionsAllOrientations(cv, detection.cardMat);
    const best = matchArtOrientations(db, artRegions);

    if (!best) {
      return {
        matched: false,
        detected: true,
        candidates: detection.candidates,
        corners: detection.corners,
      };
    }

    return {
      matched: true,
      detected: true,
      match: best.match,
      orientation: best.orientation,
      candidates: detection.candidates,
      corners: detection.corners,
    };
  } finally {
    detection.cardMat.delete();
    if (detection.artMat) detection.artMat.delete();
  }
}
