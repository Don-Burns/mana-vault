/**
 * Detection Worker
 *
 * Runs OpenCV.js in a Web Worker to keep the main thread responsive.
 * Delegates the actual detection pipeline to ../detection/pipeline.ts.
 */

import {
  detectCardInMat,
  extractArtRegionsAllOrientations,
  matToImageData,
} from "../detection/pipeline.ts";
import type { Cv } from "../../vendor/opencv/mod.ts";

let cv: Cv | null = null;
let isReady = false;

async function initOpenCV(): Promise<void> {
  try {
    // Vendored OpenCV.js — mod.ts awaits WASM init via top-level await
    const cvModule = await import("../../vendor/opencv/mod.ts");
    cv = cvModule.default;
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
  corners?: [number, number][];
  /** All card-shaped candidate quads found this frame (debug/visualisation). */
  candidates?: [number, number][][];
  cardImage?: ImageData;
  /**
   * Art-region crops for all four 90° orientations of the detected card,
   * indexed by clockwise quarter-turns: [0°, 90°, 180°, 270°]. The main thread
   * hashes each and keeps whichever best matches the database — this resolves
   * card/photo orientation without the pipeline having to guess "up".
   */
  artRegions?: ImageData[];
}

self.onmessage = (e: MessageEvent) => {
  if (!isReady || !cv) {
    self.postMessage({ type: "error", error: "OpenCV not ready" });
    return;
  }

  const msg = e.data;

  if (msg.type === "detect") {
    const result = detectCard(cv, msg.imageData, msg.frameId);
    self.postMessage(result);
  }
};

/**
 * Convert ImageData to Mat, run the detection pipeline, convert results
 * back to ImageData for transfer to the main thread.
 */
function detectCard(
  cv: Cv,
  imageData: ImageData,
  frameId: number,
): DetectResultMessage {
  const src = cv.matFromImageData(imageData);

  try {
    const result = detectCardInMat(cv, src);

    if (!result.found || !result.cardMat) {
      return {
        type: "detect-result",
        frameId,
        found: false,
        candidates: result.candidates,
      };
    }

    const cardImageData = matToImageData(cv, result.cardMat);
    const artRegions = extractArtRegionsAllOrientations(cv, result.cardMat);

    result.cardMat.delete();
    if (result.artMat) result.artMat.delete();

    return {
      type: "detect-result",
      frameId,
      found: true,
      corners: result.corners,
      candidates: result.candidates,
      cardImage: cardImageData,
      artRegions,
    };
  } finally {
    src.delete();
  }
}
