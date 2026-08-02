/**
 * Card Identification Orchestration
 *
 * Ties the geometric detection pipeline together with perceptual-hash matching
 * and — crucially — resolves card orientation.
 *
 * `detectCardInMat` locates a card-shaped quad and warps it upright, but has no
 * way to tell which side is the top. The card may have been photographed
 * rotated, or the source image may carry an unapplied EXIF orientation. The
 * warp resolves in-plane orientation geometrically, so the card is always
 * portrait; rather than guessing which end is up, we hash the art crop for both
 * 180° flips and keep whichever best matches the database.
 *
 * This module deliberately keeps the OpenCV-dependent work (`identifyCardInMat`)
 * separate from the pure hash-matching work (`matchArtOrientations`), but in the
 * browser both run together inside the detection Web Worker: the worker owns
 * OpenCV *and* the hash database, so `identifyCardInMat` is the single entry
 * point for turning a camera frame into a card match. The main thread only ever
 * receives the plain-data result. Per-frame preview geometry (the overlay and
 * stability tracking) uses `detectCardInMat` directly and skips matching
 * entirely; identification runs only once a card is detected and stable.
 */

import {
  detectCardInMat,
  extractArtRegionsAllOrientations,
  matToImageData,
} from "./pipeline.ts";
import { computeHashesFromImageData } from "../matching/hasher.ts";
import {
  findMatches,
  findMatchesInSubset,
  type MatchResult,
} from "../matching/matcher.ts";
import type { HashDB } from "../matching/hashdb.ts";
import type { Cv, Mat } from "../../vendor/opencv/mod.ts";

/** Number of 180° half-turns applied to the warped card (0 or 1). */
export type Orientation = 0 | 1;

export interface IdentifyResult {
  /** True if a card shape was detected AND matched to the database. */
  matched: boolean;
  /** True if a card *shape* was detected, regardless of whether it matched. */
  detected: boolean;
  match?: MatchResult;
  /** Which 180° rotation of the warped card produced the best match. */
  orientation?: Orientation;
  /** Card-shape candidate quads found this frame (debug/visualisation). */
  candidates?: [number, number][][];
  /** Corners of the selected card quad, if one was detected. */
  corners?: [number, number][];
  /**
   * The perspective-corrected card image, present whenever a card shape was
   * detected. Structured-cloneable, so the worker can hand it to the UI for a
   * thumbnail of what was actually scanned.
   */
  cardImage?: ImageData;
}

/**
 * Given the orientation art crops of a detected card, find the best database
 * match across all of them.
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
 * Full identification from a source image Mat: detect the card, try both
 * upright orientations, and return the best database match.
 *
 * When `illustrationIds` is supplied the search is restricted to those
 * illustrations (scan-to-select within a folder); otherwise the whole database
 * is searched.
 *
 * Handles cleanup of all intermediate Mats internally.
 */
export function identifyCardInMat(
  cv: Cv,
  src: Mat,
  db: HashDB,
  illustrationIds?: Set<string>,
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
    const best = illustrationIds
      ? matchArtOrientationsInSubset(db, artRegions, illustrationIds)
      : matchArtOrientations(db, artRegions);

    if (!best) {
      return {
        matched: false,
        detected: true,
        candidates: detection.candidates,
        corners: detection.corners,
        cardImage: matToImageData(cv, detection.cardMat),
      };
    }

    return {
      matched: true,
      detected: true,
      match: best.match,
      orientation: best.orientation,
      candidates: detection.candidates,
      corners: detection.corners,
      // Present the card the right way up, using the orientation that matched.
      cardImage: cardImageUpright(cv, detection.cardMat, best.orientation),
    };
  } finally {
    detection.cardMat.delete();
    if (detection.artMat) detection.artMat.delete();
  }
}

/**
 * Render the warped card as an ImageData, rotated by the given number of
 * clockwise quarter-turns so it appears upright to the user.
 */
function cardImageUpright(
  cv: Cv,
  cardMat: Mat,
  orientation: Orientation,
): ImageData {
  if (orientation === 0) return matToImageData(cv, cardMat);

  const rotateCodes = [null, cv.ROTATE_180];

  const rotated = new cv.Mat();
  try {
    cv.rotate(cardMat, rotated, rotateCodes[orientation]!);
    return matToImageData(cv, rotated);
  } finally {
    rotated.delete();
  }
}
