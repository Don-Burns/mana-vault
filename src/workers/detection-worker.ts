/**
 * Detection Worker
 *
 * Runs OpenCV.js in a Web Worker to keep the main thread responsive.
 * Handles: card contour detection, perspective correction, art extraction.
 */

import { classifyFrameType, ART_REGIONS } from "../detection/frame-classifier.ts";

// OpenCV.js loaded via importScripts for worker compatibility
// We'll use a dynamic approach that works with both module and classic workers

let cv: any = null;
let isReady = false;

async function initOpenCV(): Promise<void> {
  try {
    // Dynamic import for ES module worker (Vite bundles this)
    const cvModule = await import("@techstark/opencv-js");
    if (cvModule.default instanceof Promise) {
      cv = await cvModule.default;
    } else if (cvModule.default) {
      cv = cvModule.default;
      if (!cv.Mat) {
        await new Promise<void>((resolve) => {
          cv.onRuntimeInitialized = () => resolve();
        });
      }
    }
    isReady = true;
    self.postMessage({ type: "ready" });
  } catch (err) {
    self.postMessage({ type: "error", error: `OpenCV init failed: ${(err as Error).message}` });
  }
}

// Start loading immediately
initOpenCV();

// Message types
export interface DetectCardMessage {
  type: "detect";
  imageData: ImageData;
  frameId: number;
}

export interface DetectResultMessage {
  type: "detect-result";
  frameId: number;
  found: boolean;
  corners?: [number, number][]; // 4 corner points of detected card
  cardImage?: ImageData; // Perspective-corrected card image
  artRegion?: ImageData; // Extracted art region
}

self.onmessage = async (e: MessageEvent) => {
  if (!isReady) {
    self.postMessage({ type: "error", error: "OpenCV not ready" });
    return;
  }

  const msg = e.data;

  if (msg.type === "detect") {
    const result = detectCard(msg.imageData, msg.frameId);
    self.postMessage(result);
  }
};

/**
 * Main detection pipeline:
 * 1. Convert to grayscale
 * 2. Blur to reduce noise
 * 3. Canny edge detection
 * 4. Find contours
 * 5. Find largest quadrilateral
 * 6. Perspective warp
 * 7. Extract art region
 */
function detectCard(imageData: ImageData, frameId: number): DetectResultMessage {
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();

  try {
    // Step 1: Grayscale
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Step 2: Gaussian blur
    const ksize = new cv.Size(5, 5);
    cv.GaussianBlur(gray, blurred, ksize, 0);

    // Step 3: Canny edge detection
    cv.Canny(blurred, edges, 50, 150);

    // Step 4: Dilate edges to close gaps
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    // Step 5: Find contours
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // Step 6: Find the largest quadrilateral contour
    const corners = findCardContour(contours, imageData.width, imageData.height);

    contours.delete();
    hierarchy.delete();

    if (!corners) {
      return { type: "detect-result", frameId, found: false };
    }

    // Step 7: Perspective correction
    const cardImage = perspectiveWarp(src, corners);
    if (!cardImage) {
      return { type: "detect-result", frameId, found: false };
    }

    // Step 8: Extract art region
    const artRegion = extractArtRegion(cardImage);

    // Convert results to ImageData
    const cardImageData = matToImageData(cardImage);
    const artImageData = artRegion ? matToImageData(artRegion) : undefined;

    cardImage.delete();
    if (artRegion) artRegion.delete();

    return {
      type: "detect-result",
      frameId,
      found: true,
      corners,
      cardImage: cardImageData,
      artRegion: artImageData,
    };
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
  }
}

/**
 * Find the largest quadrilateral contour that could be a card.
 * MTG cards have aspect ratio ~2.5:3.5 (≈0.714)
 */
function findCardContour(
  contours: any,
  frameWidth: number,
  frameHeight: number,
): [number, number][] | null {
  const frameArea = frameWidth * frameHeight;
  const minCardArea = frameArea * 0.05; // Card must be at least 5% of frame
  const maxCardArea = frameArea * 0.95; // Card must be less than 95% of frame

  let bestContour: [number, number][] | null = null;
  let bestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);

    if (area < minCardArea || area > maxCardArea) {
      contour.delete();
      continue;
    }

    // Approximate the contour to a polygon
    const peri = cv.arcLength(contour, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, 0.02 * peri, true);

    // Must be a quadrilateral (4 vertices)
    if (approx.rows === 4) {
      // Check if it's convex
      const isConvex = cv.isContourConvex(approx);
      if (isConvex && area > bestArea) {
        // Check aspect ratio is approximately card-shaped
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

/**
 * Check if four points form a rectangle with roughly card-like aspect ratio.
 * Card aspect ratio: 63mm × 88mm ≈ 0.716
 */
function isCardShaped(points: [number, number][]): boolean {
  // Order points: top-left, top-right, bottom-right, bottom-left
  const ordered = orderPoints(points);

  // Calculate widths and heights
  const widthTop = distance(ordered[0], ordered[1]);
  const widthBottom = distance(ordered[3], ordered[2]);
  const heightLeft = distance(ordered[0], ordered[3]);
  const heightRight = distance(ordered[1], ordered[2]);

  const avgWidth = (widthTop + widthBottom) / 2;
  const avgHeight = (heightLeft + heightRight) / 2;

  // Aspect ratio check (card is 63:88, so width/height ≈ 0.716)
  // Allow for cards held in landscape too
  const ratio = Math.min(avgWidth, avgHeight) / Math.max(avgWidth, avgHeight);

  // Accept ratios between 0.6 and 0.8 (generous to account for perspective distortion)
  return ratio > 0.55 && ratio < 0.85;
}

/**
 * Order 4 points as: top-left, top-right, bottom-right, bottom-left
 */
function orderPoints(points: [number, number][]): [number, number][] {
  // Sort by sum (x+y): smallest = top-left, largest = bottom-right
  const sorted = [...points].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const tl = sorted[0];
  const br = sorted[3];

  // Sort by difference (x-y): smallest = bottom-left, largest = top-right
  const sortedDiff = [...points].sort((a, b) => (a[0] - a[1]) - (b[0] - b[1]));
  const bl = sortedDiff[0];
  const tr = sortedDiff[3];

  return [tl, tr, br, bl];
}

/**
 * Warp the detected card region to a flat rectangle.
 * Standard card: 745 × 1040 pixels (proportional to 63 × 88 mm)
 */
function perspectiveWarp(src: any, corners: [number, number][]): any | null {
  const ordered = orderPoints(corners);

  // Determine output dimensions maintaining card aspect ratio
  const cardWidth = 745;
  const cardHeight = 1040;

  // Source points
  const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    ordered[0][0], ordered[0][1],
    ordered[1][0], ordered[1][1],
    ordered[2][0], ordered[2][1],
    ordered[3][0], ordered[3][1],
  ]);

  // Destination points
  const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    cardWidth, 0,
    cardWidth, cardHeight,
    0, cardHeight,
  ]);

  const M = cv.getPerspectiveTransform(srcPoints, dstPoints);
  const dst = new cv.Mat();
  const dsize = new cv.Size(cardWidth, cardHeight);
  cv.warpPerspective(src, dst, M, dsize);

  srcPoints.delete();
  dstPoints.delete();
  M.delete();

  return dst;
}

/**
 * Extract the art region from a perspective-corrected card.
 * Uses the frame classifier to determine art position based on card type.
 */
function extractArtRegion(cardMat: any): any | null {
  const width = cardMat.cols;
  const height = cardMat.rows;

  // Get card image as ImageData for frame classification
  const cardImageData = matToImageData(cardMat);
  const frameType = classifyFrameType(cardImageData);

  // Get art region bounds for this frame type
  const [leftPct, topPct, rightPct, bottomPct] = ART_REGIONS[frameType];

  const artLeft = Math.round(width * leftPct);
  const artTop = Math.round(height * topPct);
  const artRight = Math.round(width * rightPct);
  const artBottom = Math.round(height * bottomPct);

  // Create ROI (Region of Interest)
  const rect = new cv.Rect(artLeft, artTop, artRight - artLeft, artBottom - artTop);
  const artRegion = cardMat.roi(rect);

  // Clone so we don't depend on the parent mat
  const result = artRegion.clone();
  artRegion.delete();

  return result;
}

// Utility functions
function matToPoints(mat: any): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < mat.rows; i++) {
    points.push([mat.intAt(i, 0), mat.intAt(i, 1)]);
  }
  return points;
}

function matToImageData(mat: any): ImageData {
  // Convert to RGBA if needed
  let rgba: any;
  if (mat.channels() === 4) {
    rgba = mat;
  } else if (mat.channels() === 3) {
    rgba = new cv.Mat();
    cv.cvtColor(mat, rgba, cv.COLOR_BGR2RGBA);
  } else if (mat.channels() === 1) {
    rgba = new cv.Mat();
    cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
  } else {
    rgba = mat;
  }

  const imageData = new ImageData(
    new Uint8ClampedArray(rgba.data),
    rgba.cols,
    rgba.rows,
  );

  if (rgba !== mat) {
    rgba.delete();
  }

  return imageData;
}

function distance(p1: [number, number], p2: [number, number]): number {
  const dx = p1[0] - p2[0];
  const dy = p1[1] - p2[1];
  return Math.sqrt(dx * dx + dy * dy);
}
