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

import { ART_REGIONS, classifyFrameType } from "./frame-classifier.ts";

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
  // deno-lint-ignore no-explicit-any
  cardMat?: any;
  /** Extracted art region. Caller must call .delete(). */
  // deno-lint-ignore no-explicit-any
  artMat?: any;
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
 * Returns perspective-corrected card and extracted art region as Mats.
 * Caller is responsible for deleting returned cardMat and artMat.
 */
// deno-lint-ignore no-explicit-any
export function detectCardInMat(cv: any, src: any): PipelineResult {
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

    // Extract art region
    const artMat = extractArtRegion(cv, cardMat);

    return {
      found: true,
      corners,
      candidates,
      cardMat,
      artMat: artMat ?? undefined,
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
 * Unlike {@link findCardContour} (which returns only the single largest
 * match), this gathers every plausible card quad so the caller can decide
 * between them — e.g. to prefer a small card nested inside a larger bright
 * quad such as a sheet of paper.
 */
// deno-lint-ignore no-explicit-any
// deno-lint-ignore no-explicit-any
export function collectCardQuads(
  cv: any,
  contours: any,
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
// deno-lint-ignore no-explicit-any
function meanIntensity(cv: any, gray: any, points: [number, number][]): number {
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
// deno-lint-ignore no-explicit-any
export function selectCardQuad(
  cv: any,
  // deno-lint-ignore no-explicit-any
  gray: any,
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

/**
 * Find the largest quadrilateral contour that could be a card.
 * MTG cards have aspect ratio ~2.5:3.5 (≈ 0.714).
 *
 * @deprecated Prefer {@link collectCardQuads} + {@link selectCardQuad}, which
 * also handle cards nested inside a larger bright quad. Retained for callers
 * that only need the single largest match.
 */
// deno-lint-ignore no-explicit-any
export function findCardContour(
  cv: any,
  contours: any,
  frameWidth: number,
  frameHeight: number,
): [number, number][] | null {
  const frameArea = frameWidth * frameHeight;
  const minCardArea = frameArea * 0.05;
  const maxCardArea = frameArea * 0.95;

  let bestContour: [number, number][] | null = null;
  let bestArea = 0;

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

    if (approx.rows === 4) {
      const isConvex = cv.isContourConvex(approx);
      if (isConvex && area > bestArea) {
        const points = matToPoints(approx);
        if (isCardShaped(points)) {
          bestArea = area;
          bestContour = points;
        }
      }
    }

    approx.delete();
    contour.delete();
  }

  return bestContour;
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

/** Order 4 points as: top-left, top-right, bottom-right, bottom-left. */
export function orderPoints(
  points: [number, number][],
): [number, number][] {
  const sorted = [...points].sort(
    (a, b) => a[0] + a[1] - (b[0] + b[1]),
  );
  const tl = sorted[0];
  const br = sorted[3];

  const sortedDiff = [...points].sort(
    (a, b) => a[0] - a[1] - (b[0] - b[1]),
  );
  const bl = sortedDiff[0];
  const tr = sortedDiff[3];

  return [tl, tr, br, bl];
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
// deno-lint-ignore no-explicit-any
export function perspectiveWarp(
  cv: any,
  src: any,
  corners: [number, number][],
): any {
  const ordered = orderPoints(corners);

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
 * Extract the art region from a perspective-corrected card Mat.
 * Uses frame classification to determine crop bounds.
 */
// deno-lint-ignore no-explicit-any
export function extractArtRegion(cv: any, cardMat: any): any | null {
  const width = cardMat.cols;
  const height = cardMat.rows;

  const cardImageData = matToImageData(cv, cardMat);
  const frameType = classifyFrameType(cardImageData);

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
 * Extract the art region for all four 90° orientations of a card.
 *
 * A detected card quad is warped to an upright rectangle, but the pipeline has
 * no way to know which of the four sides is the top — the card may have been
 * photographed rotated (or the source image itself may carry an unapplied EXIF
 * orientation). Rather than guessing, we return the art crop for every 90°
 * rotation so the caller can hash each and pick whichever best matches the
 * database. This makes recognition robust to card/photo orientation.
 *
 * Returns art-region ImageDatas indexed by clockwise quarter-turns applied to
 * the card: [0°, 90°, 180°, 270°]. The caller owns nothing to delete (all
 * intermediate Mats are freed here).
 */
// deno-lint-ignore no-explicit-any
export function extractArtRegionsAllOrientations(
  cv: any,
  // deno-lint-ignore no-explicit-any
  cardMat: any,
): ImageData[] {
  const results: ImageData[] = [];
  const rotateCodes = [
    null,
    cv.ROTATE_90_CLOCKWISE,
    cv.ROTATE_180,
    cv.ROTATE_90_COUNTERCLOCKWISE,
  ];

  for (const code of rotateCodes) {
    // deno-lint-ignore no-explicit-any
    let rotated: any;
    if (code === null) {
      rotated = cardMat;
    } else {
      rotated = new cv.Mat();
      cv.rotate(cardMat, rotated, code);
    }

    const art = extractArtRegion(cv, rotated);
    results.push(matToImageData(cv, art));
    art.delete();
    if (rotated !== cardMat) rotated.delete();
  }

  return results;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export function matToPoints(mat: any): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < mat.rows; i++) {
    points.push([mat.intAt(i, 0), mat.intAt(i, 1)]);
  }
  return points;
}

// deno-lint-ignore no-explicit-any
export function matToImageData(cv: any, mat: any): ImageData {
  // Ensure contiguous memory — ROI mats (and clone() of ROIs in OpenCV.js)
  // have a stride wider than cols*elemSize, which makes mat.data garbled.
  // deno-lint-ignore no-explicit-any
  let src: any = mat;
  let srcOwned = false;
  if (!mat.isContinuous()) {
    src = new cv.Mat();
    mat.copyTo(src);
    srcOwned = true;
  }

  // deno-lint-ignore no-explicit-any
  let rgba: any;
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
