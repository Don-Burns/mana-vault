/**
 * Perceptual Hash Computation (Client-side)
 *
 * Computes pHash and dHash from an ImageData object (extracted art region).
 * Designed to run in a Web Worker for performance.
 */

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

/**
 * Perceptual Hash (pHash) - DCT based
 */
function computePHash(pixels: Uint8Array, size: number): bigint {
  const dctSize = 8;
  const dctValues: number[] = [];

  for (let u = 0; u < dctSize; u++) {
    for (let v = 0; v < dctSize; v++) {
      let sum = 0;
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          const pixel = pixels[x * size + y];
          sum += pixel *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
        }
      }
      const cu = u === 0 ? 1 / Math.SQRT2 : 1;
      const cv = v === 0 ? 1 / Math.SQRT2 : 1;
      dctValues.push(sum * cu * cv * (2 / size));
    }
  }

  const sorted = [...dctValues].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (dctValues[i] > median) {
      hash |= 1n << BigInt(63 - i);
    }
  }

  return hash;
}

/**
 * Difference Hash (dHash) - Gradient based
 */
function computeDHash(pixels: Uint8Array, size: number): bigint {
  const dHashW = 9;
  const dHashH = 8;
  const resampled: number[] = [];

  for (let y = 0; y < dHashH; y++) {
    for (let x = 0; x < dHashW; x++) {
      const srcX = Math.floor((x / dHashW) * size);
      const srcY = Math.floor((y / dHashH) * size);
      resampled.push(pixels[srcY * size + srcX]);
    }
  }

  let hash = 0n;
  let bit = 63;

  for (let y = 0; y < dHashH; y++) {
    for (let x = 0; x < dHashW - 1; x++) {
      const left = resampled[y * dHashW + x];
      const right = resampled[y * dHashW + x + 1];
      if (left > right) {
        hash |= 1n << BigInt(bit);
      }
      bit--;
    }
  }

  return hash;
}
