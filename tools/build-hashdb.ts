/// <reference lib="deno.ns" />

/**
 * Build Hash Database
 *
 * Reads downloaded art crop images, computes perceptual hashes (pHash + dHash),
 * and generates:
 *   1. A compact binary hash database (for fast matching in the PWA)
 *   2. A metadata JSON file (illustration_id → card info + printings)
 *
 * Usage: deno task db:build
 *
 * Requires: art images downloaded via 'deno task db:art'
 */

import {
  ensureDataDirs,
  BULK_DIR,
  ART_DIR,
  OUTPUT_DIR,
  HASH_IMAGE_SIZE,
  type CardData,
  type CardMetadata,
  type IllustrationEntry,
  type PrintingInfo,
} from "./config.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

// We use the 'sharp' library via Deno's npm compatibility for image processing
import sharp from "npm:sharp@0.33.2";

const CARDS_FILE = join(BULK_DIR, "cards.json");
const HASH_DB_FILE = join(OUTPUT_DIR, "hash-db.bin");
const METADATA_FILE = join(OUTPUT_DIR, "metadata.json");
const PROGRESS_INTERVAL = 1000;

/**
 * Binary format:
 *
 * Header (16 bytes):
 *   [0..3]  Magic: "MTGH" (4 bytes)
 *   [4..5]  Version: 1 (uint16)
 *   [6..9]  Entry count (uint32)
 *   [10..11] Hash size in bytes: 8 for 64-bit (uint16)
 *   [12..15] Reserved (uint32, set to 0)
 *
 * Entries (32 bytes each):
 *   [0..15]  illustration_id as raw bytes (UUID without dashes, hex-decoded = 16 bytes)
 *   [16..23] pHash (uint64, stored as 8 bytes big-endian)
 *   [24..31] dHash (uint64, stored as 8 bytes big-endian)
 */
const HEADER_SIZE = 16;
const ENTRY_SIZE = 32;
const MAGIC = new TextEncoder().encode("MTGH");

async function main() {
  await ensureDataDirs();

  // Load card data
  console.log("Loading card data...");
  let cards: CardData[];
  try {
    cards = JSON.parse(await Deno.readTextFile(CARDS_FILE));
  } catch {
    console.error("Card data not found. Run 'deno task db:download' first.");
    Deno.exit(1);
    return; // unreachable but satisfies TS
  }

  // Build metadata: group cards by illustration_id
  console.log("Building metadata...");
  const metadata: CardMetadata = { illustrations: {} };

  for (const card of cards) {
    if (!metadata.illustrations[card.illustration_id]) {
      metadata.illustrations[card.illustration_id] = {
        oracle_id: card.oracle_id,
        name: card.name,
        printings: [],
      };
    }

    const entry = metadata.illustrations[card.illustration_id];

    // Use English name as primary name
    if (card.lang === "en" && entry.name !== card.name) {
      entry.name = card.name;
    }

    entry.printings.push({
      id: card.id,
      set: card.set,
      set_name: card.set_name,
      collector_number: card.collector_number,
      lang: card.lang,
      released_at: card.released_at,
    });
  }

  const illustrationIds = Object.keys(metadata.illustrations);
  console.log(`Total unique illustrations in metadata: ${illustrationIds.length}`);

  // Compute hashes for each illustration that has a downloaded art image
  console.log("Computing perceptual hashes...");
  const hashEntries: { illustrationId: string; pHash: bigint; dHash: bigint }[] = [];
  let processed = 0;
  let skipped = 0;

  for (const illustrationId of illustrationIds) {
    const artPath = join(ART_DIR, `${illustrationId}.jpg`);

    try {
      await Deno.stat(artPath);
    } catch {
      skipped++;
      continue;
    }

    try {
      const imageBuffer = await Deno.readFile(artPath);
      const { pHash, dHash } = await computeHashes(imageBuffer);

      hashEntries.push({ illustrationId, pHash, dHash });
      processed++;

      if (processed % PROGRESS_INTERVAL === 0) {
        console.log(`  Hashed ${processed} images...`);
      }
    } catch (err) {
      console.error(`  Error hashing ${illustrationId}: ${(err as Error).message}`);
      skipped++;
    }
  }

  console.log(`\nHash computation complete:`);
  console.log(`  Hashed: ${processed}`);
  console.log(`  Skipped: ${skipped}`);

  // Generate binary hash database
  console.log("\nGenerating binary hash database...");
  const dbBuffer = new ArrayBuffer(HEADER_SIZE + hashEntries.length * ENTRY_SIZE);
  const dbView = new DataView(dbBuffer);
  const dbBytes = new Uint8Array(dbBuffer);

  // Write header
  dbBytes.set(MAGIC, 0);
  dbView.setUint16(4, 1); // Version 1
  dbView.setUint32(6, hashEntries.length);
  dbView.setUint16(10, 8); // 8 bytes per hash
  dbView.setUint32(12, 0); // Reserved

  // Write entries
  for (let i = 0; i < hashEntries.length; i++) {
    const offset = HEADER_SIZE + i * ENTRY_SIZE;
    const { illustrationId, pHash, dHash } = hashEntries[i];

    // Write illustration_id as 16 raw bytes (UUID hex-decoded)
    const idBytes = hexToBytes(illustrationId.replace(/-/g, ""));
    dbBytes.set(idBytes, offset);

    // Write pHash as 8 bytes big-endian
    writeBigUint64(dbView, offset + 16, pHash);

    // Write dHash as 8 bytes big-endian
    writeBigUint64(dbView, offset + 24, dHash);
  }

  await Deno.writeFile(HASH_DB_FILE, new Uint8Array(dbBuffer));
  console.log(`  Hash DB: ${HASH_DB_FILE} (${(dbBuffer.byteLength / 1024).toFixed(1)} KB)`);

  // Write metadata JSON
  await Deno.writeTextFile(METADATA_FILE, JSON.stringify(metadata));
  const metaSize = new TextEncoder().encode(JSON.stringify(metadata)).length;
  console.log(`  Metadata: ${METADATA_FILE} (${(metaSize / 1024 / 1024).toFixed(1)} MB)`);

  // Also write to public/db/ for the PWA to access
  const publicDbDir = join(Deno.cwd(), "public", "db");
  await Deno.mkdir(publicDbDir, { recursive: true });
  await Deno.copyFile(HASH_DB_FILE, join(publicDbDir, "hash-db.bin"));
  await Deno.copyFile(METADATA_FILE, join(publicDbDir, "metadata.json"));
  console.log(`  Copied to public/db/ for PWA access`);

  console.log("\nDone! The hash database is ready for the PWA.");
}

/**
 * Compute perceptual hash (pHash) and difference hash (dHash) for an image.
 *
 * pHash: Based on DCT (Discrete Cosine Transform) of the image
 * dHash: Based on gradient direction between adjacent pixels
 */
async function computeHashes(imageBuffer: Uint8Array): Promise<{ pHash: bigint; dHash: bigint }> {
  // Resize to small square and convert to grayscale
  const grayscaleBuffer = await sharp(imageBuffer)
    .resize(HASH_IMAGE_SIZE, HASH_IMAGE_SIZE, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  const pixels = new Uint8Array(grayscaleBuffer);

  const pHash = computePHash(pixels, HASH_IMAGE_SIZE);
  const dHash = computeDHash(pixels, HASH_IMAGE_SIZE);

  return { pHash, dHash };
}

/**
 * Perceptual Hash (pHash)
 *
 * 1. Compute DCT of the image
 * 2. Take the top-left 8x8 block (low frequencies)
 * 3. Compute median of the 64 DCT values
 * 4. Each bit = 1 if DCT value > median, else 0
 */
function computePHash(pixels: Uint8Array, size: number): bigint {
  // Compute 2D DCT
  const dctValues: number[] = [];
  const dctSize = 8; // We only need top-left 8x8

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

  // Skip DC component (index 0), use remaining 63 values + DC = 64 total
  // Actually use all 64 for the hash
  const sorted = [...dctValues].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Generate 64-bit hash
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (dctValues[i] > median) {
      hash |= 1n << BigInt(63 - i);
    }
  }

  return hash;
}

/**
 * Difference Hash (dHash)
 *
 * 1. Resize to 9x8 (9 wide, 8 tall)
 * 2. Each bit = 1 if pixel[x] > pixel[x+1], comparing horizontally
 * 3. Produces 64 bits (8 rows × 8 comparisons per row)
 *
 * Since we already have a 32x32 image, we'll resample to 9x8.
 */
function computeDHash(pixels: Uint8Array, size: number): bigint {
  // Resample to 9x8
  const dHashW = 9;
  const dHashH = 8;
  const resampled: number[] = [];

  for (let y = 0; y < dHashH; y++) {
    for (let x = 0; x < dHashW; x++) {
      // Map to source coordinates
      const srcX = Math.floor((x / dHashW) * size);
      const srcY = Math.floor((y / dHashH) * size);
      resampled.push(pixels[srcY * size + srcX]);
    }
  }

  // Compute hash: compare adjacent horizontal pixels
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

// Utility functions

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function writeBigUint64(view: DataView, offset: number, value: bigint): void {
  // Write as two uint32 values (big-endian)
  const high = Number((value >> 32n) & 0xFFFFFFFFn);
  const low = Number(value & 0xFFFFFFFFn);
  view.setUint32(offset, high);
  view.setUint32(offset + 4, low);
}

main().catch((err) => {
  console.error("Error:", err.message);
  Deno.exit(1);
});
