/**
 * Card Identification Orchestration
 *
 * Ties the geometric detection pipeline together with perceptual-hash matching
 * and — crucially — resolves the two things the detector cannot determine on
 * its own: which way up the card is, and where its art sits.
 *
 * `detectCardInMat` locates a card-shaped quad and warps it to an upright
 * portrait rectangle, but cannot tell the top edge from the bottom — the card
 * may have been photographed rotated, or the source image may carry an
 * unapplied EXIF orientation. Nor can any fixed rectangle frame the art of a
 * showcase or borderless card. Both questions are answered by search rather
 * than by heuristic: `extractCardCandidates` emits 8 views of the card (2
 * orientations x {uncropped card, 3 art-region layouts}), each is hashed
 * against its corresponding hash space, and the best database score wins.
 *
 * This module deliberately keeps the OpenCV-dependent work (`identifyCardInMat`)
 * separate from the pure hash-matching work (`matchCardCandidates`), but in the
 * browser both run together inside the detection Web Worker: the worker owns
 * OpenCV *and* the hash database, so `identifyCardInMat` is the single entry
 * point for turning a camera frame into a card match. The main thread only ever
 * receives the plain-data result. Per-frame preview geometry (the overlay and
 * stability tracking) uses `detectCardInMat` directly and skips matching
 * entirely; identification runs only once a card is detected and stable.
 */

import {
  type CandidateSource,
  type CardCandidate,
  detectCardInMat,
  extractCardCandidates,
  matToImageData,
} from "./pipeline.ts";
import { computeHashesFromImageData } from "../matching/hasher.ts";
import {
  findMatches,
  findMatchesInSubset,
  type HashSpace,
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

/** The winning candidate of a card-candidate search. */
export interface CandidateMatch {
  match: MatchResult;
  orientation: Orientation;
  /** Which view of the card produced this match (debug/diagnostics). */
  source: CandidateSource;
}

/**
 * Search every candidate view of a detected card and return the single best
 * database match across all of them.
 *
 * Each candidate is hashed and compared against the hash space it belongs to:
 * the uncropped card against the full-card hashes, art crops against the art
 * hashes. Scores from the two spaces are directly comparable — both are
 * Hamming distances over 64-bit hashes of a 32x32 grayscale image — so the
 * global minimum wins regardless of which space it came from.
 *
 * Pure (no OpenCV): safe to run on the main thread with the loaded hash DB.
 */
export function matchCardCandidates(
  db: HashDB,
  candidates: CardCandidate[],
): CandidateMatch | null {
  return searchCandidates(
    candidates,
    (pHash, dHash, space) => findMatches(db, pHash, dHash, 1, space),
  );
}

/**
 * Like {@link matchCardCandidates}, but restricts the search to a subset of
 * illustration IDs (e.g. the cards in a specific folder for scan-to-select).
 */
export function matchCardCandidatesInSubset(
  db: HashDB,
  candidates: CardCandidate[],
  illustrationIds: Set<string>,
): CandidateMatch | null {
  return searchCandidates(
    candidates,
    (pHash, dHash, space) =>
      findMatchesInSubset(db, pHash, dHash, illustrationIds, 1, space),
  );
}

/** Shared candidate sweep; `search` supplies the database lookup. */
function searchCandidates(
  candidates: CardCandidate[],
  search: (
    pHash: bigint,
    dHash: bigint,
    space: HashSpace,
  ) => MatchResult[],
): CandidateMatch | null {
  let best: CandidateMatch | null = null;

  for (const candidate of candidates) {
    const space: HashSpace = candidate.source === "full" ? "full" : "art";
    const { pHash, dHash } = computeHashesFromImageData(candidate.imageData);

    for (const match of search(pHash, dHash, space)) {
      if (!best || match.combinedScore < best.match.combinedScore) {
        best = {
          match,
          orientation: candidate.orientation,
          source: candidate.source,
        };
      }
    }
  }

  return best;
}

/**
 * Full identification from a source image Mat: detect the card, hash every
 * candidate view of it, and return the best database match.
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
    const candidates = extractCardCandidates(cv, detection.cardMat);
    const best = illustrationIds
      ? matchCardCandidatesInSubset(db, candidates, illustrationIds)
      : matchCardCandidates(db, candidates);

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
