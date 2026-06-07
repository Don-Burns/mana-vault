/**
 * OpenCV.js ES Module Wrapper
 *
 * Re-exports the vendored OpenCV.js build as an ES module default export.
 * The underlying opencv.cjs is a UMD/CommonJS build patched for Deno
 * compatibility by tools/download-opencv.ts.
 *
 * The Emscripten module compiles WASM asynchronously. We await its
 * onRuntimeInitialized callback at the top level so consumers get a
 * ready-to-use cv object when they import this module.
 *
 * Usage:
 *   import cv from "../../vendor/opencv/mod.ts";
 *
 * In the browser (via Vite), the CJS module is bundled into ESM.
 * In Deno (tests), the .cjs extension triggers CommonJS loading.
 */

// @ts-ignore — opencv.js has no type declarations
import _cv from "./opencv.cjs";

// deno-lint-ignore no-explicit-any
const cv: any = _cv;

// Wait for the WASM runtime to initialize before exporting.
// If cv.Mat already exists, the runtime is ready (e.g. Vite pre-bundled).
// Otherwise, wait for the onRuntimeInitialized callback.
if (!cv.Mat) {
  await new Promise<void>((resolve) => {
    cv.onRuntimeInitialized = () => resolve();
  });
}

export default cv;
