/**
 * OpenCV.js ES Module Wrapper
 *
 * Re-exports the vendored OpenCV.js build as an ES module default export.
 * The underlying opencv.mjs is a patched UMD build wrapped as an ES module by
 * tools/download-opencv.ts.
 *
 * The Emscripten module compiles WASM asynchronously. We await its
 * onRuntimeInitialized callback at the top level so consumers get a
 * ready-to-use cv object when they import this module.
 *
 * Usage:
 *   import cv, { type Cv, type Mat } from "../../vendor/opencv/mod.ts";
 *
 * In both the browser (via Vite) and Deno (tests), the vendored file is loaded
 * as a native ES module.
 *
 * ── Types ──────────────────────────────────────────────────────────
 * OpenCV.js ships no type declarations. We intentionally keep a local,
 * focused type surface here (`Cv`, `Mat`, `MatVector`, `Rect`, `Size`) that
 * describes exactly the OpenCV.js runtime API this project uses, including
 * JS/WASM-specific behavior (`.delete()`, `.intAt()`, typed-array `.data`,
 * constructable `cv.Mat`/`cv.Size`/`cv.Rect`, integer enum constants, etc.).
 *
 * This keeps OpenCV-facing code strongly typed without depending on a
 * third-party binding/type package whose API model may drift from OpenCV.js.
 */

// @ts-ignore — opencv.js has no type declarations of its own.
import cv from "./opencv.mjs";

/**
 * A perceptual view of an OpenCV.js `cv.Mat`. Only the members used across the
 * codebase are declared; add more here as needed.
 */
export interface Mat {
  readonly rows: number;
  readonly cols: number;
  /** Raw pixel buffer (interpretation depends on the Mat's depth/channels). */
  readonly data: Uint8Array;
  channels(): number;
  isContinuous(): boolean;
  /** Copy into `dst` (allocating/resizing it as needed). */
  copyTo(dst: Mat): void;
  clone(): Mat;
  /** Sub-region view sharing the parent's memory. */
  roi(rect: Rect): Mat;
  /** Read an integer channel value at (row, col-channel). */
  intAt(i: number, j: number): number;
  /** Read a double channel value at (row, col-channel). */
  doubleAt(i: number, j: number): number;
  /** Free the underlying WASM heap memory. Must be called to avoid leaks. */
  delete(): void;
}

/** OpenCV.js `cv.MatVector` — a growable list of Mats (e.g. contour output). */
export interface MatVector {
  size(): number;
  get(index: number): Mat;
  delete(): void;
}

/** OpenCV.js `cv.Rect`. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** OpenCV.js `cv.Size`. */
export interface Size {
  width: number;
  height: number;
}

/** OpenCV.js integer enum constant (colour codes, rotate codes, flags…). */
type CvEnum = number;

/**
 * The OpenCV.js namespace object, typed for the subset of the API this project
 * uses. Constructors (`Mat`, `Size`, `Rect`, `MatVector`) are `new`-able; the
 * rest are free functions and integer enum constants.
 */
export interface Cv {
  // ── Constructors ──
  Mat: { new (): Mat; new (rows: number, cols: number, type: CvEnum): Mat };
  MatVector: { new (): MatVector };
  Size: { new (width: number, height: number): Size };
  Rect: {
    new (x: number, y: number, width: number, height: number): Rect;
  };

  // ── Factory helpers ──
  matFromImageData(imageData: ImageData): Mat;
  matFromArray(
    rows: number,
    cols: number,
    type: CvEnum,
    array: number[],
  ): Mat;

  // ── Image processing ──
  cvtColor(src: Mat, dst: Mat, code: CvEnum): void;
  GaussianBlur(src: Mat, dst: Mat, ksize: Size, sigmaX: number): void;
  Canny(image: Mat, edges: Mat, threshold1: number, threshold2: number): void;
  dilate(src: Mat, dst: Mat, kernel: Mat): void;
  morphologyEx(src: Mat, dst: Mat, op: CvEnum, kernel: Mat): void;
  threshold(
    src: Mat,
    dst: Mat,
    thresh: number,
    maxval: number,
    type: CvEnum,
  ): number;
  getStructuringElement(shape: CvEnum, ksize: Size): Mat;
  resize?(src: Mat, dst: Mat, dsize: Size): void;
  rotate(src: Mat, dst: Mat, rotateCode: CvEnum): void;

  // ── Contour analysis ──
  findContours(
    image: Mat,
    contours: MatVector,
    hierarchy: Mat,
    mode: CvEnum,
    method: CvEnum,
  ): void;
  contourArea(contour: Mat): number;
  arcLength(curve: Mat, closed: boolean): number;
  approxPolyDP(
    curve: Mat,
    approxCurve: Mat,
    epsilon: number,
    closed: boolean,
  ): void;
  isContourConvex(contour: Mat): boolean;

  // ── Geometry ──
  getPerspectiveTransform(src: Mat, dst: Mat): Mat;
  warpPerspective(src: Mat, dst: Mat, M: Mat, dsize: Size): void;

  // ── Statistics ──
  mean(src: Mat): [number, number, number, number];

  // ── Runtime ──
  onRuntimeInitialized?: () => void;

  // ── Enum constants ──
  readonly COLOR_RGBA2GRAY: CvEnum;
  readonly COLOR_BGR2GRAY: CvEnum;
  readonly COLOR_BGR2RGBA: CvEnum;
  readonly COLOR_GRAY2RGBA: CvEnum;
  readonly MORPH_RECT: CvEnum;
  readonly MORPH_CLOSE: CvEnum;
  readonly RETR_LIST: CvEnum;
  readonly CHAIN_APPROX_SIMPLE: CvEnum;
  readonly THRESH_BINARY_INV: CvEnum;
  readonly THRESH_OTSU: CvEnum;
  readonly ROTATE_90_CLOCKWISE: CvEnum;
  readonly ROTATE_90_COUNTERCLOCKWISE: CvEnum;
  readonly ROTATE_180: CvEnum;
  readonly CV_32FC2: CvEnum;
}

const typedCv = cv as unknown as Cv;

// Wait for the WASM runtime to initialize before exporting.
// If cv.Mat already exists, the runtime is ready (e.g. Vite pre-bundled).
// Otherwise, wait for the onRuntimeInitialized callback.
if (!typedCv.Mat) {
  await new Promise<void>((resolve) => {
    typedCv.onRuntimeInitialized = () => resolve();
  });
}

export default typedCv;
