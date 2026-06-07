/**
 * Detection Worker
 *
 * Runs OpenCV.js in a Web Worker to keep the main thread responsive.
 * Delegates the actual detection pipeline to ../detection/pipeline.ts.
 */

import { detectCardInMat, matToImageData } from "../detection/pipeline.ts";

// deno-lint-ignore no-explicit-any
let cv: any = null;
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
  cardImage?: ImageData;
  artRegion?: ImageData;
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
 * Convert ImageData to Mat, run the detection pipeline, convert results
 * back to ImageData for transfer to the main thread.
 */
function detectCard(imageData: ImageData, frameId: number): DetectResultMessage {
  const src = cv.matFromImageData(imageData);

  try {
    const result = detectCardInMat(cv, src);

    if (!result.found || !result.cardMat) {
      return { type: "detect-result", frameId, found: false };
    }

    const cardImageData = matToImageData(cv, result.cardMat);
    const artImageData = result.artMat
      ? matToImageData(cv, result.artMat)
      : undefined;

    result.cardMat.delete();
    if (result.artMat) result.artMat.delete();

    return {
      type: "detect-result",
      frameId,
      found: true,
      corners: result.corners,
      cardImage: cardImageData,
      artRegion: artImageData,
    };
  } finally {
    src.delete();
  }
}
