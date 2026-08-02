export interface CameraOptions {
  facingMode?: "user" | "environment";
  width?: number;
  height?: number;
  /**
   * Maximum rate at which the frame handler is invoked. The detection pipeline
   * doesn't benefit from display-rate sampling, and running it flat out burns
   * battery, so frames are dropped to hit this cadence.
   */
  targetFps?: number;
}

/** Frame-handler cadence used when the caller doesn't specify one. */
const DEFAULT_TARGET_FPS = 20;

export class Camera {
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement;
  private animationFrameId: number | null = null;
  private onFrame: ((video: HTMLVideoElement) => void) | null = null;
  private frameIntervalMs = 1000 / DEFAULT_TARGET_FPS;
  private lastFrameTime = 0;
  /**
   * Scratch canvas reused by captureFrame/captureBlob. Allocating one per call
   * churns several MB per second at the sampling rates used here.
   */
  private captureCanvas: HTMLCanvasElement | null = null;

  constructor(videoEl: HTMLVideoElement) {
    this.videoEl = videoEl;
  }

  async start(options: CameraOptions = {}): Promise<void> {
    const {
      facingMode = "environment",
      width = 1280,
      height = 720,
      targetFps = DEFAULT_TARGET_FPS,
    } = options;

    this.frameIntervalMs = targetFps > 0 ? 1000 / targetFps : 0;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: width },
          height: { ideal: height },
        },
        audio: false,
      });

      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();

      // Start frame loop if a handler is registered
      if (this.onFrame) {
        this.startFrameLoop();
      }
    } catch (err) {
      throw new Error(`Camera access failed: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.stopFrameLoop();

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    this.videoEl.srcObject = null;
  }

  /**
   * Register a callback that fires on each animation frame with the video element.
   * Useful for continuous detection processing.
   */
  setFrameHandler(handler: ((video: HTMLVideoElement) => void) | null): void {
    this.onFrame = handler;
    if (handler && this.stream) {
      this.startFrameLoop();
    } else {
      this.stopFrameLoop();
    }
  }

  /**
   * Capture the current video frame to a canvas and return it.
   */
  captureFrame(): ImageData | null {
    const ctx = this.drawCurrentFrame();
    if (!ctx) return null;

    return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  /**
   * Capture current frame as a blob (JPEG).
   */
  async captureBlob(quality = 0.85): Promise<Blob | null> {
    const ctx = this.drawCurrentFrame();
    if (!ctx) return null;

    return new Promise((resolve) => {
      ctx.canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    });
  }

  get isActive(): boolean {
    return this.stream !== null && this.stream.active;
  }

  get videoWidth(): number {
    return this.videoEl.videoWidth;
  }

  get videoHeight(): number {
    return this.videoEl.videoHeight;
  }

  private startFrameLoop(): void {
    if (this.animationFrameId !== null) return;

    // rAF drives the loop (it self-throttles when the tab is hidden), but the
    // handler only fires once per frameIntervalMs.
    const loop = (now: number) => {
      if (
        this.onFrame && this.videoEl.readyState >= 2 &&
        now - this.lastFrameTime >= this.frameIntervalMs
      ) {
        this.lastFrameTime = now;
        this.onFrame(this.videoEl);
      }
      this.animationFrameId = requestAnimationFrame(loop);
    };

    this.animationFrameId = requestAnimationFrame(loop);
  }

  private stopFrameLoop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.lastFrameTime = 0;
  }

  /** Draw the current video frame into the reusable scratch canvas. */
  private drawCurrentFrame(): CanvasRenderingContext2D | null {
    if (!this.stream || this.videoEl.readyState < 2) {
      return null;
    }

    this.captureCanvas ??= document.createElement("canvas");
    const canvas = this.captureCanvas;
    canvas.width = this.videoEl.videoWidth;
    canvas.height = this.videoEl.videoHeight;

    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(this.videoEl, 0, 0);
    return ctx;
  }
}
