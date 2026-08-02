/**
 * Card Detector - Main thread interface to the detection Web Worker.
 *
 * Manages communication with the OpenCV worker and provides
 * a clean async API for card detection and identification.
 *
 * The worker owns OpenCV and the hash database; this class only ever exchanges
 * structured-cloneable plain data with it, so the main thread stays free of the
 * ~11 MB OpenCV bundle.
 */

import type { IdentifyResult } from "./identify.ts";

export interface DetectionResult {
  found: boolean;
  corners?: [number, number][];
  /** All card-shaped candidate quads found this frame (debug/visualisation). */
  candidates?: [number, number][][];
}

export type { IdentifyResult };

type DetectorState = "loading" | "ready" | "error";

export class CardDetector {
  private worker: Worker;
  private state: DetectorState = "loading";
  private frameId = 0;
  private pendingResolves = new Map<number, (result: DetectionResult) => void>();
  private pendingIdentifies = new Map<number, (result: IdentifyResult) => void>();
  private onReady: (() => void) | null = null;
  private onError: ((error: string) => void) | null = null;
  private readyPromise: Promise<void>;
  private _dbSize = 0;

  constructor() {
    this.worker = new Worker(
      new URL("../workers/detection-worker.ts", import.meta.url),
      { type: "module" },
    );

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.onReady = resolve;
      this.onError = (err) => reject(new Error(err));
    });

    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;

      switch (msg.type) {
        case "ready":
          this.state = "ready";
          this._dbSize = msg.dbSize ?? 0;
          if (this.onReady) this.onReady();
          break;

        case "error":
          this.state = "error";
          if (this.onError) this.onError(msg.error);
          break;

        case "detect-result": {
          const resolve = this.pendingResolves.get(msg.frameId);
          if (resolve) {
            this.pendingResolves.delete(msg.frameId);
            resolve({
              found: msg.found,
              corners: msg.corners,
              candidates: msg.candidates,
            });
          }
          break;
        }

        case "identify-result": {
          const resolve = this.pendingIdentifies.get(msg.frameId);
          if (resolve) {
            this.pendingIdentifies.delete(msg.frameId);
            resolve({
              matched: msg.matched,
              detected: msg.detected,
              match: msg.match,
              orientation: msg.orientation,
              candidates: msg.candidates,
              corners: msg.corners,
              cardImage: msg.cardImage,
            });
          }
          break;
        }
      }
    };

    this.worker.onerror = (e) => {
      this.state = "error";
      console.error("Detection worker error:", e);
    };
  }

  /**
   * Wait for OpenCV to be fully loaded and ready.
   */
  async waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Number of entries in the worker's hash database (0 if it failed to load,
   * in which case detection still works but identification won't match).
   * Only meaningful after {@link waitUntilReady} resolves.
   */
  get dbSize(): number {
    return this._dbSize;
  }

  /**
   * Locate a card in the given frame. Geometry only — cheap enough to run on
   * every sampled frame to drive the viewfinder overlay.
   */
  async detect(imageData: ImageData): Promise<DetectionResult> {
    if (this.state !== "ready") {
      return { found: false };
    }

    const frameId = ++this.frameId;

    return new Promise<DetectionResult>((resolve) => {
      this.pendingResolves.set(frameId, resolve);
      this.worker.postMessage({
        type: "detect",
        imageData,
        frameId,
      });
    });
  }

  /**
   * Identify the card in the given frame against the hash database. Much more
   * expensive than {@link detect}, so call it only once a card has been
   * detected and held steady.
   *
   * @param illustrationIds - Restrict matching to these illustrations
   *   (scan-to-select within a folder).
   */
  async identify(
    imageData: ImageData,
    illustrationIds?: Set<string>,
  ): Promise<IdentifyResult> {
    if (this.state !== "ready") {
      return { matched: false, detected: false };
    }

    const frameId = ++this.frameId;

    return new Promise<IdentifyResult>((resolve) => {
      this.pendingIdentifies.set(frameId, resolve);
      this.worker.postMessage({
        type: "identify",
        imageData,
        frameId,
        illustrationIds,
      });
    });
  }

  /**
   * Whether the detector is ready to process frames.
   */
  get isReady(): boolean {
    return this.state === "ready";
  }

  /**
   * Terminate the worker and clean up.
   */
  destroy(): void {
    this.worker.terminate();
    this.pendingResolves.clear();
    this.pendingIdentifies.clear();
  }
}
