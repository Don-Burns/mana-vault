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

import { classifyFrameType, ART_REGIONS } from "./frame-classifier.ts";

// --- Types ---

export interface PipelineResult {
  found: boolean;
  corners?: [number, number][];
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

    // Find contours
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(
      edges,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );

    const corners = findCardContour(cv, contours, src.cols, src.rows);

    contours.delete();
    hierarchy.delete();

    if (!corners) {
      return { found: false };
    }

    // Perspective correction
    const cardMat = perspectiveWarp(cv, src, corners);

    // Extract art region
    const artMat = extractArtRegion(cv, cardMat);

    return {
      found: true,
      corners,
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
 * Find the largest quadrilateral contour that could be a card.
 * MTG cards have aspect ratio ~2.5:3.5 (≈ 0.714).
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
    ordered[0][0], ordered[0][1],
    ordered[1][0], ordered[1][1],
    ordered[2][0], ordered[2][1],
    ordered[3][0], ordered[3][1],
  ]);

  const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    CARD_WIDTH, 0,
    CARD_WIDTH, CARD_HEIGHT,
    0, CARD_HEIGHT,
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
