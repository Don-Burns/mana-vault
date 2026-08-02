/**
 * Detection Worker
 *
 * Runs OpenCV.js in a Web Worker to keep the main thread responsive. The worker
 * owns both OpenCV *and* the perceptual-hash database, so it can answer two
 * kinds of question:
 *
 *   - "detect": where is the card in this frame? Geometry only, cheap enough to
 *     run on every sampled frame to drive the viewfinder overlay.
 *   - "identify": which card is this? Runs the full `identifyCardInMat`
 *     pipeline (detect → warp → 8 candidate views → hash → match). The main
 *     thread only asks this once a card has been detected and held steady.
 *
 * Keeping the database here means the main thread never needs OpenCV, and the
 * per-frame message payload stays small (corners, not pixels).
 */

import { detectCardInMat } from "../detection/pipeline.ts";
import {
  identifyCardInMat,
  type IdentifyResult,
} from "../detection/identify.ts";
import { HashDB } from "../matching/hashdb.ts";
import type { Cv } from "../../vendor/opencv/mod.ts";

let cv: Cv | null = null;
let db: HashDB | null = null;
let isReady = false;

async function init(): Promise<void> {
  try {
    // Vendored OpenCV.js — mod.ts awaits WASM init via top-level await.
    // Load the hash DB (~1.6 MB) in parallel; it's needed for "identify".
    const [cvModule, loadedDb] = await Promise.all([
      import("../../vendor/opencv/mod.ts"),
      HashDB.load("/db/hash-db.bin").catch(() => null),
    ]);
    cv = cvModule.default;
    db = loadedDb;
    isReady = true;
    // dbSize is 0 when the database is missing — detection still works, so the
    // UI degrades to "detection only" rather than failing outright.
    self.postMessage({ type: "ready", dbSize: db?.size ?? 0 });
  } catch (err) {
    self.postMessage({
      type: "error",
      error: `OpenCV init failed: ${(err as Error).message}`,
    });
  }
}

// Start loading immediately
init();

// Message types
export interface DetectCardMessage {
  type: "detect";
  imageData: ImageData;
  frameId: number;
}

export interface IdentifyCardMessage {
  type: "identify";
  imageData: ImageData;
  frameId: number;
  /** Restrict matching to these illustrations (scan-to-select within a folder). */
  illustrationIds?: Set<string>;
}

export interface DetectResultMessage {
  type: "detect-result";
  frameId: number;
  found: boolean;
  corners?: [number, number][];
  /** All card-shaped candidate quads found this frame (debug/visualisation). */
  candidates?: [number, number][][];
}

export interface IdentifyResultMessage extends IdentifyResult {
  type: "identify-result";
  frameId: number;
}

self.onmessage = (e: MessageEvent) => {
  if (!isReady || !cv) {
    self.postMessage({ type: "error", error: "OpenCV not ready" });
    return;
  }

  const msg = e.data;

  if (msg.type === "detect") {
    self.postMessage(detectCard(cv, msg.imageData, msg.frameId));
  } else if (msg.type === "identify") {
    self.postMessage(
      identifyCard(cv, msg.imageData, msg.frameId, msg.illustrationIds),
    );
  }
};

/**
 * Locate the card in a frame. Geometry only — no hashing, no database access,
 * and no pixel data in the reply.
 */
function detectCard(
  cv: Cv,
  imageData: ImageData,
  frameId: number,
): DetectResultMessage {
  const src = cv.matFromImageData(imageData);

  try {
    const result = detectCardInMat(cv, src);

    if (result.cardMat) result.cardMat.delete();

    return {
      type: "detect-result",
      frameId,
      found: result.found,
      corners: result.found ? result.corners : undefined,
      candidates: result.candidates,
    };
  } finally {
    src.delete();
  }
}

/**
 * Full identification: detect, warp, hash every candidate view and match
 * against the database.
 */
function identifyCard(
  cv: Cv,
  imageData: ImageData,
  frameId: number,
  illustrationIds?: Set<string>,
): IdentifyResultMessage {
  if (!db) {
    return {
      type: "identify-result",
      frameId,
      matched: false,
      detected: false,
    };
  }

  const src = cv.matFromImageData(imageData);

  try {
    return {
      type: "identify-result",
      frameId,
      ...identifyCardInMat(cv, src, db, illustrationIds),
    };
  } finally {
    src.delete();
  }
}
