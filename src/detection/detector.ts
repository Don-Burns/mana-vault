/**
 * Card Detector - Main thread interface to the detection Web Worker.
 *
 * Manages communication with the OpenCV worker and provides
 * a clean async API for card detection.
 */

export interface DetectionResult {
  found: boolean;
  corners?: [number, number][];
  cardImage?: ImageData;
  artRegion?: ImageData;
}

type DetectorState = "loading" | "ready" | "error";

export class CardDetector {
  private worker: Worker;
  private state: DetectorState = "loading";
  private frameId = 0;
  private pendingResolves = new Map<number, (result: DetectionResult) => void>();
  private onReady: (() => void) | null = null;
  private onError: ((error: string) => void) | null = null;
  private readyPromise: Promise<void>;

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
              cardImage: msg.cardImage,
              artRegion: msg.artRegion,
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
   * Detect a card in the given image data.
   * Returns the detection result with perspective-corrected card and art region.
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
  }
}
