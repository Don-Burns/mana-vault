export interface CameraOptions {
  facingMode?: "user" | "environment";
  width?: number;
  height?: number;
}

export class Camera {
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement;
  private animationFrameId: number | null = null;
  private onFrame: ((video: HTMLVideoElement) => void) | null = null;

  constructor(videoEl: HTMLVideoElement) {
    this.videoEl = videoEl;
  }

  async start(options: CameraOptions = {}): Promise<void> {
    const {
      facingMode = "environment",
      width = 1280,
      height = 720,
    } = options;

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
    if (!this.stream || this.videoEl.readyState < 2) {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = this.videoEl.videoWidth;
    canvas.height = this.videoEl.videoHeight;

    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(this.videoEl, 0, 0);

    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  /**
   * Capture current frame as a blob (JPEG).
   */
  async captureBlob(quality = 0.85): Promise<Blob | null> {
    if (!this.stream || this.videoEl.readyState < 2) {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = this.videoEl.videoWidth;
    canvas.height = this.videoEl.videoHeight;

    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(this.videoEl, 0, 0);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
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

    const loop = () => {
      if (this.onFrame && this.videoEl.readyState >= 2) {
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
  }
}
