/**
 * Card Detection Pipeline
 *
 * Pure detection functions extracted from the detection worker so they can
 * be used in both the Web Worker (browser) and Deno (tests).
 *
 * All functions that use OpenCV take `cv` as their first parameter for
 * dependency injection — this avoids coupling to a specific OpenCV loading
 * strategy.
 */

import { ART_REGIONS, type FrameType } from "./frame-classifier.ts";
import type { Cv, Mat, MatVector } from "../../vendor/opencv/mod.ts";

// --- Types ---

export interface PipelineResult {
  found: boolean;
  corners?: [number, number][];
  /**
   * All card-shaped quadrilateral candidates found this frame, regardless of
   * whether one was ultimately selected. Useful for debugging/visualising
   * what the detector considers card-like. Coordinates are in source-frame
   * pixel space, same as `corners`.
   */
  candidates?: [number, number][][];
  /** Perspective-corrected card (745×1040). Caller must call .delete(). */
  cardMat?: Mat;
}

/** Standard card output dimensions (proportional to 63 mm × 88 mm). */
const CARD_WIDTH = 745;
const CARD_HEIGHT = 1040;

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full card detection pipeline on a source image Mat.
 *
 * Accepts RGBA (from ImageData) or BGR (3-channel) input.
 * Returns the perspective-corrected card; caller is responsible for deleting it.
 * Art regions are not cropped here — identification needs several different
 * crops, which `extractCardCandidates` produces on demand.
 */
export function detectCardInMat(cv: Cv, src: Mat): PipelineResult {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();

  try {
    // Grayscale — handle both RGBA and BGR input
    if (src.channels() === 4) {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    } else if (src.channels() === 3) {
      cv.cvtColor(src, gray, cv.COLOR_BGR2GRAY);
    } else {
      src.copyTo(gray);
    }

    // Blur to reduce noise
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    // Canny edge detection
    cv.Canny(blurred, edges, 50, 150);

    // Dilate to close gaps
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    // Gather card-shaped quad candidates from two complementary sources:
    //
    //   1. Canny edges — works well for cards against contrasting backgrounds.
    //   2. Otsu threshold — segments a dark card resting on a bright surface
    //      (e.g. a card placed on a sheet of paper), which Canny can miss
    //      when the card's border blends into surrounding printed content.
    //
    // Using both lets us handle cluttered scenes where the card is nested
    // inside a larger bright quad (the paper), which we resolve below by
    // preferring the innermost card-shaped quad.
    const candidates: [number, number][][] = [];

    const edgeContours = new cv.MatVector();
    const edgeHierarchy = new cv.Mat();
    cv.findContours(
      edges,
      edgeContours,
      edgeHierarchy,
      cv.RETR_LIST,
      cv.CHAIN_APPROX_SIMPLE,
    );
    collectCardQuads(cv, edgeContours, src.cols, src.rows, candidates);
    edgeContours.delete();
    edgeHierarchy.delete();

    // Otsu segmentation pass.
    const thresh = new cv.Mat();
    cv.threshold(
      blurred,
      thresh,
      0,
      255,
      cv.THRESH_BINARY_INV + cv.THRESH_OTSU,
    );
    const closeKernel = cv.getStructuringElement(
      cv.MORPH_RECT,
      new cv.Size(7, 7),
    );
    cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, closeKernel);
    closeKernel.delete();

    const threshContours = new cv.MatVector();
    const threshHierarchy = new cv.Mat();
    cv.findContours(
      thresh,
      threshContours,
      threshHierarchy,
      cv.RETR_LIST,
      cv.CHAIN_APPROX_SIMPLE,
    );
    collectCardQuads(cv, threshContours, src.cols, src.rows, candidates);
    threshContours.delete();
    threshHierarchy.delete();
    thresh.delete();

    const corners = selectCardQuad(cv, gray, candidates);

    if (!corners) {
      return { found: false, candidates };
    }

    // Perspective correction
    const cardMat = perspectiveWarp(cv, src, corners);

    return {
      found: true,
      corners,
      candidates,
      cardMat,
    };
  } finally {
    gray.delete();
    blurred.delete();
    edges.delete();
  }
}

// ---------------------------------------------------------------------------
// Contour Analysis
// ---------------------------------------------------------------------------

/**
 * Collect all convex, card-shaped quadrilateral contours into `out`.
 *
 * Gathers every plausible card quad so the caller can decide between them —
 * e.g. to prefer a small card nested inside a larger bright quad such as a
 * sheet of paper.
 */
export function collectCardQuads(
  cv: Cv,
  contours: MatVector,
  frameWidth: number,
  frameHeight: number,
  out: [number, number][][],
): void {
  const frameArea = frameWidth * frameHeight;
  const minCardArea = frameArea * 0.02;
  const maxCardArea = frameArea * 0.95;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);

    if (area < minCardArea || area > maxCardArea) {
      contour.delete();
      continue;
    }

    const peri = cv.arcLength(contour, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, 0.02 * peri, true);

    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const points = matToPoints(approx);
      if (isCardShaped(points)) {
        out.push(points);
      }
    }

    approx.delete();
    contour.delete();
  }
}

/** Compute the area of a quadrilateral via the shoelace formula. */
function quadArea(points: [number, number][]): number {
  const ordered = orderPoints(points);
  let sum = 0;
  for (let i = 0; i < ordered.length; i++) {
    const [x1, y1] = ordered[i];
    const [x2, y2] = ordered[(i + 1) % ordered.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Return the centroid of a quadrilateral. */
function quadCenter(points: [number, number][]): [number, number] {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  return [cx / points.length, cy / points.length];
}

/** True if the centre of `inner` lies inside the axis-aligned bounds of `outer`. */
function isNestedInside(
  inner: [number, number][],
  outer: [number, number][],
): boolean {
  const [cx, cy] = quadCenter(inner);
  const xs = outer.map((p) => p[0]);
  const ys = outer.map((p) => p[1]);
  return (
    cx >= Math.min(...xs) &&
    cx <= Math.max(...xs) &&
    cy >= Math.min(...ys) &&
    cy <= Math.max(...ys)
  );
}

/** Mean grayscale intensity within the axis-aligned bounds of a quad. */
function meanIntensity(cv: Cv, gray: Mat, points: [number, number][]): number {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.max(0, Math.floor(Math.min(...xs)));
  const y = Math.max(0, Math.floor(Math.min(...ys)));
  const w = Math.min(gray.cols - x, Math.ceil(Math.max(...xs)) - x);
  const h = Math.min(gray.rows - y, Math.ceil(Math.max(...ys)) - y);
  if (w <= 0 || h <= 0) return 0;
  const roi = gray.roi(new cv.Rect(x, y, w, h));
  const mean = cv.mean(roi)[0];
  roi.delete();
  return mean;
}

/**
 * Choose the best card quad from a set of candidates.
 *
 * Cards are frequently photographed resting on a larger bright surface (a
 * desk, a sheet of paper) whose border is itself detected as a card-shaped
 * quad. When a smaller card-shaped quad is nested inside a larger, markedly
 * brighter quad, the smaller quad is the real card sitting on a pale backing,
 * so we prefer it.
 *
 * The brightness test is important: a card photographed alone also yields
 * nested quads (its art box, text box, etc. approximate to card-shaped
 * rectangles), but those inner regions are *not* brighter than the card as a
 * whole, so we must not treat them as the card. Only when the surrounding
 * quad is substantially brighter — as a blank sheet of paper is — do we drill
 * inward. Otherwise we fall back to the largest quad (the original behaviour
 * for clean single-card photos).
 */
export function selectCardQuad(
  cv: Cv,
  gray: Mat,
  candidates: [number, number][][],
): [number, number][] | null {
  if (candidates.length === 0) return null;

  const withArea = candidates.map((points) => ({
    points,
    area: quadArea(points),
    mean: meanIntensity(cv, gray, points),
  }));

  // How much brighter an enclosing quad must be to be considered a pale
  // backing (paper/desk) rather than the card itself.
  const BACKING_BRIGHTNESS_MARGIN = 25;

  // Prefer the smallest quad nested inside a meaningfully larger, brighter one.
  const nested = withArea
    .filter((c) =>
      withArea.some(
        (other) =>
          other !== c &&
          other.area > c.area * 1.5 &&
          other.mean - c.mean > BACKING_BRIGHTNESS_MARGIN &&
          isNestedInside(c.points, other.points),
      )
    )
    .sort((a, b) => a.area - b.area);

  if (nested.length > 0) {
    return nested[0].points;
  }

  // Otherwise fall back to the largest card-shaped quad.
  withArea.sort((a, b) => b.area - a.area);
  return withArea[0].points;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Check if four points form a rectangle with roughly card-like aspect ratio.
 * Card aspect ratio: 63 mm × 88 mm ≈ 0.716
 */
export function isCardShaped(points: [number, number][]): boolean {
  const ordered = orderPoints(points);

  const widthTop = distance(ordered[0], ordered[1]);
  const widthBottom = distance(ordered[3], ordered[2]);
  const heightLeft = distance(ordered[0], ordered[3]);
  const heightRight = distance(ordered[1], ordered[2]);

  const avgWidth = (widthTop + widthBottom) / 2;
  const avgHeight = (heightLeft + heightRight) / 2;

  const ratio = Math.min(avgWidth, avgHeight) / Math.max(avgWidth, avgHeight);

  // Accept 0.55–0.85 to account for perspective distortion
  return ratio > 0.55 && ratio < 0.85;
}

/**
 * Order 4 points as: top-left, top-right, bottom-right, bottom-left
 * (clockwise on screen, where y grows downwards).
 *
 * Sorting by x+y / x-y extremes is only valid for near-axis-aligned quads:
 * around 45° of rotation the sums tie and the same corner can win two slots,
 * yielding a self-intersecting "bow-tie" that getPerspectiveTransform will
 * happily warp into garbage. Instead we sort by angle about the centroid,
 * which always produces a simple (non-self-intersecting) cycle for a convex
 * quad, then rotate that cycle to start at the top-left-most corner.
 */
export function orderPoints(
  points: [number, number][],
): [number, number][] {
  const cx = (points[0][0] + points[1][0] + points[2][0] + points[3][0]) / 4;
  const cy = (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4;

  // atan2 with y down: increasing angle sweeps clockwise on screen.
  const cycle = [...points].sort(
    (a, b) =>
      Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  );

  // Rotate so index 0 is the corner nearest the image origin.
  let start = 0;
  let bestSum = Infinity;
  for (let i = 0; i < 4; i++) {
    const sum = cycle[i][0] + cycle[i][1];
    if (sum < bestSum) {
      bestSum = sum;
      start = i;
    }
  }

  return [
    cycle[start],
    cycle[(start + 1) % 4],
    cycle[(start + 2) % 4],
    cycle[(start + 3) % 4],
  ];
}

/**
 * Given corners already in TL/TR/BR/BL order, rotate the cycle so that the
 * quad's long axis runs top-to-bottom — i.e. so it maps onto an upright
 * portrait destination rectangle.
 *
 * A Magic card is always taller than it is wide, so if the detected quad is
 * wider than it is tall the card was lying sideways in the frame. Rotating the
 * corner cycle by one step (rather than warping to a landscape destination)
 * keeps the warp output at a constant CARD_WIDTH x CARD_HEIGHT and removes two
 * of the four possible orientations from the downstream search.
 *
 * Opposite edges are averaged so that perspective foreshortening on one side
 * cannot flip the decision.
 */
export function orientQuadPortrait(
  ordered: [number, number][],
): [number, number][] {
  const avgWidth = (distance(ordered[0], ordered[1]) +
    distance(ordered[3], ordered[2])) / 2;
  const avgHeight = (distance(ordered[0], ordered[3]) +
    distance(ordered[1], ordered[2])) / 2;

  if (avgWidth <= avgHeight) return ordered;

  return [ordered[3], ordered[0], ordered[1], ordered[2]];
}

export function distance(
  p1: [number, number],
  p2: [number, number],
): number {
  const dx = p1[0] - p2[0];
  const dy = p1[1] - p2[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------
// Perspective Correction
// ---------------------------------------------------------------------------

/** Warp the detected card region to a flat 745×1040 rectangle. */
export function perspectiveWarp(
  cv: Cv,
  src: Mat,
  corners: [number, number][],
): Mat {
  // Resolve in-plane orientation geometrically so the warp output is always
  // upright portrait, even when the card was lying sideways in the frame.
  const ordered = orientQuadPortrait(orderPoints(corners));

  const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    ordered[0][0],
    ordered[0][1],
    ordered[1][0],
    ordered[1][1],
    ordered[2][0],
    ordered[2][1],
    ordered[3][0],
    ordered[3][1],
  ]);

  const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0,
    0,
    CARD_WIDTH,
    0,
    CARD_WIDTH,
    CARD_HEIGHT,
    0,
    CARD_HEIGHT,
  ]);

  const M = cv.getPerspectiveTransform(srcPoints, dstPoints);
  const dst = new cv.Mat();
  cv.warpPerspective(
    src,
    dst,
    M,
    new cv.Size(CARD_WIDTH, CARD_HEIGHT),
  );

  srcPoints.delete();
  dstPoints.delete();
  M.delete();

  return dst;
}

// ---------------------------------------------------------------------------
// Art Extraction
// ---------------------------------------------------------------------------

/**
 * Extract the art region for a given frame layout from a perspective-corrected
 * card Mat.
 *
 * The frame type is supplied by the caller rather than inferred. Measuring it
 * from the image proved unreliable — a card that fills only a small part of the
 * frame is upscaled several times over by the warp, which smears the border
 * into a gradient and makes any border-thickness heuristic read near zero. The
 * pipeline now crops every layout and lets the hash matcher decide.
 */
export function extractArtRegion(
  cv: Cv,
  cardMat: Mat,
  frameType: FrameType,
): Mat | null {
  const width = cardMat.cols;
  const height = cardMat.rows;

  const [leftPct, topPct, rightPct, bottomPct] = ART_REGIONS[frameType];

  const artLeft = Math.round(width * leftPct);
  const artTop = Math.round(height * topPct);
  const artRight = Math.round(width * rightPct);
  const artBottom = Math.round(height * bottomPct);

  const rect = new cv.Rect(
    artLeft,
    artTop,
    artRight - artLeft,
    artBottom - artTop,
  );
  const artRegion = cardMat.roi(rect);

  // copyTo (not clone!) to get a contiguous Mat — clone preserves the
  // parent's row stride in OpenCV.js, which corrupts matToImageData.
  const result = new cv.Mat();
  artRegion.copyTo(result);
  artRegion.delete();

  return result;
}

/**
 * Which image a hash candidate was cropped from.
 *
 * `"full"` is the whole perspective-corrected card with no crop at all; the
 * others are the {@link ART_REGIONS} rectangles for each frame layout.
 */
export type CandidateSource = "full" | FrameType;

/** One hashable view of a detected card. */
export interface CardCandidate {
  imageData: ImageData;
  /** 180° half-turns applied to the warped card: 0 = as warped, 1 = flipped. */
  orientation: 0 | 1;
  source: CandidateSource;
}

/** Sources emitted per orientation, in the order they are produced. */
const CANDIDATE_SOURCES: CandidateSource[] = [
  "full",
  "modern",
  "old",
  "borderless",
];

/**
 * Build every hashable view of a detected card: 2 orientations x 4 sources.
 *
 * Two problems are resolved here by search rather than by guessing, because
 * both heuristics proved unreliable on real captures:
 *
 *  1. Which way up is the card? `perspectiveWarp` resolves the sideways case
 *     geometrically (see `orientQuadPortrait`), so the warp is always portrait,
 *     but it cannot tell the top edge from the bottom — the card may have been
 *     photographed rotated, or the source image may carry an unapplied EXIF
 *     orientation. Both 180° flips are therefore emitted.
 *
 *  2. Where is the art? A fixed percentage rectangle only works for a known
 *     frame layout, and no rectangle frames showcase / borderless / extended-art
 *     cards reliably. So all three {@link ART_REGIONS} are emitted, alongside the
 *     uncropped card, which needs no art region at all and is what actually
 *     identifies those irregular layouts.
 *
 * The caller hashes each candidate against the matching hash space (`"full"`
 * against the full-card hashes, the rest against the art hashes) and keeps the
 * best score. All intermediate Mats are freed here; the caller owns nothing.
 */
export function extractCardCandidates(
  cv: Cv,
  cardMat: Mat,
): CardCandidate[] {
  const results: CardCandidate[] = [];
  const rotateCodes = [null, cv.ROTATE_180];

  for (let orientation = 0; orientation < rotateCodes.length; orientation++) {
    const code = rotateCodes[orientation];

    let rotated: Mat;
    if (code === null) {
      rotated = cardMat;
    } else {
      rotated = new cv.Mat();
      cv.rotate(cardMat, rotated, code);
    }

    try {
      for (const source of CANDIDATE_SOURCES) {
        if (source === "full") {
          results.push({
            imageData: matToImageData(cv, rotated),
            orientation: orientation as 0 | 1,
            source,
          });
          continue;
        }

        const art = extractArtRegion(cv, rotated, source);
        if (!art) continue;

        results.push({
          imageData: matToImageData(cv, art),
          orientation: orientation as 0 | 1,
          source,
        });
        art.delete();
      }
    } finally {
      if (rotated !== cardMat) rotated.delete();
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function matToPoints(mat: Mat): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < mat.rows; i++) {
    points.push([mat.intAt(i, 0), mat.intAt(i, 1)]);
  }
  return points;
}

export function matToImageData(cv: Cv, mat: Mat): ImageData {
  // Ensure contiguous memory — ROI mats (and clone() of ROIs in OpenCV.js)
  // have a stride wider than cols*elemSize, which makes mat.data garbled.
  let src: Mat = mat;
  let srcOwned = false;
  if (!mat.isContinuous()) {
    src = new cv.Mat();
    mat.copyTo(src);
    srcOwned = true;
  }

  let rgba: Mat;
  if (src.channels() === 4) {
    rgba = src;
  } else if (src.channels() === 3) {
    rgba = new cv.Mat();
    cv.cvtColor(src, rgba, cv.COLOR_BGR2RGBA);
  } else if (src.channels() === 1) {
    rgba = new cv.Mat();
    cv.cvtColor(src, rgba, cv.COLOR_GRAY2RGBA);
  } else {
    rgba = src;
  }

  const imageData = new ImageData(
    new Uint8ClampedArray(rgba.data),
    rgba.cols,
    rgba.rows,
  );

  if (rgba !== src) {
    rgba.delete();
  }
  if (srcOwned) {
    src.delete();
  }

  return imageData;
}
