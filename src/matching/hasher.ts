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
 *
 * Uses area averaging with fractional edge weights: each output pixel is
 * the weighted mean of all source pixels that overlap it, with partial
 * pixels at the edges weighted proportionally.  This matches OpenCV's
 * INTER_AREA behaviour and is critical for large downscale factors
 * (e.g. 660×450 → 32×32) where bilinear interpolation would sample
 * only 4 neighbours and miss most of the image content.
 */
function toGrayscale32x32(imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData;
  const size = 32;
  const output = new Uint8Array(size * size);

  const scaleX = width / size;
  const scaleY = height / size;

  for (let oy = 0; oy < size; oy++) {
    const srcYStart = oy * scaleY;
    const srcYEnd = (oy + 1) * scaleY;
    const syMin = Math.floor(srcYStart);
    const syMax = Math.ceil(srcYEnd);

    for (let ox = 0; ox < size; ox++) {
      const srcXStart = ox * scaleX;
      const srcXEnd = (ox + 1) * scaleX;
      const sxMin = Math.floor(srcXStart);
      const sxMax = Math.ceil(srcXEnd);

      let sum = 0;
      let area = 0;

      for (let sy = syMin; sy < syMax; sy++) {
        const yWeight = Math.min(sy + 1, srcYEnd) - Math.max(sy, srcYStart);
        const rowOffset = sy * width;

        for (let sx = sxMin; sx < sxMax; sx++) {
          const xWeight = Math.min(sx + 1, srcXEnd) - Math.max(sx, srcXStart);
          const weight = xWeight * yWeight;
          const idx = (rowOffset + sx) * 4;
          // ITU-R BT.601 luminance
          sum += weight * (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
          area += weight;
        }
      }

      output[oy * size + ox] = Math.round(sum / area);
    }
  }

  return output;
}
