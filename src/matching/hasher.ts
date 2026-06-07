/**
 * Perceptual Hash Computation (Client-side)
 *
 * Computes pHash and dHash from an ImageData object (extracted art region).
 * Designed to run in a Web Worker for performance.
 *
 * The core hash algorithms live in hash-core.ts and are shared with the
 * build tool (tools/build-hashdb.ts). This module handles the browser-specific
 * ImageData → 32x32 grayscale conversion before delegating to the shared code.
 */

import { computePHash, computeDHash } from "./hash-core.ts";

/**
 * Compute pHash and dHash from an art region ImageData.
 * The image is downscaled to 32x32 grayscale before hashing.
 */
export function computeHashesFromImageData(imageData: ImageData): { pHash: bigint; dHash: bigint } {
  const grayscale = toGrayscale32x32(imageData);
  const pHash = computePHash(grayscale, 32);
  const dHash = computeDHash(grayscale, 32);
  return { pHash, dHash };
}

/**
 * Convert ImageData to 32x32 grayscale pixel array.
 * Uses bilinear interpolation for quality downscaling.
 */
function toGrayscale32x32(imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData;
  const size = 32;
  const output = new Uint8Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Map to source coordinates
      const srcX = (x + 0.5) * (width / size) - 0.5;
      const srcY = (y + 0.5) * (height / size) - 0.5;

      // Bilinear interpolation
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const xFrac = srcX - x0;
      const yFrac = srcY - y0;

      // Get grayscale values at 4 corners (luminance formula)
      const g00 = pixelGray(data, width, x0, y0);
      const g10 = pixelGray(data, width, x1, y0);
      const g01 = pixelGray(data, width, x0, y1);
      const g11 = pixelGray(data, width, x1, y1);

      // Bilinear interpolate
      const gray = Math.round(
        g00 * (1 - xFrac) * (1 - yFrac) +
        g10 * xFrac * (1 - yFrac) +
        g01 * (1 - xFrac) * yFrac +
        g11 * xFrac * yFrac,
      );

      output[y * size + x] = gray;
    }
  }

  return output;
}

function pixelGray(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  const idx = (y * width + x) * 4;
  // ITU-R BT.601 luminance
  return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
}


