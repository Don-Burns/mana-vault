/**
 * Core Perceptual Hash Algorithms
 *
 * Pure math functions for computing pHash and dHash from a 32x32 grayscale
 * pixel buffer. No dependencies — used by both the browser client
 * (src/matching/hasher.ts) and the build tool (tools/build-hashdb.ts).
 *
 * Input: Uint8Array of length 1024 (32 * 32), row-major grayscale pixels.
 * Output: 64-bit bigint hash values.
 */

/**
 * Perceptual Hash (pHash) - DCT based
 *
 * 1. Compute 2D DCT of the image
 * 2. Take the top-left 8x8 block (low frequencies)
 * 3. Compute median of the 64 DCT values
 * 4. Each bit = 1 if DCT value > median, else 0
 */
export function computePHash(pixels: Uint8Array, size: number): bigint {
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
 *
 * 1. Resample to 9x8 (9 wide, 8 tall)
 * 2. Each bit = 1 if pixel[x] > pixel[x+1], comparing horizontally
 * 3. Produces 64 bits (8 rows x 8 comparisons per row)
 */
export function computeDHash(pixels: Uint8Array, size: number): bigint {
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
