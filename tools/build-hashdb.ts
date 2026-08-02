/// <reference lib="deno.ns" />

/**
 * Build Hash Database
 *
 * Reads downloaded card images, computes perceptual hashes (pHash + dHash) for
 * BOTH the art crop and the full card image, and generates:
 *   1. A compact binary hash database (for fast matching in the PWA)
 *   2. A metadata JSON file (illustration_id → card info + printings)
 *
 * Usage: deno task db:build
 *
 * Requires: images downloaded via 'deno task db:art' (populates both
 * data/crop_art/ and data/full_art/)
 */

import {
  BULK_DIR,
  type CardData,
  type CardMetadata,
  CROP_ART_DIR,
  ensureDataDirs,
  FULL_ART_DIR,
  HASH_IMAGE_SIZE,
  type IllustrationEntry,
  OUTPUT_DIR,
  type PrintingInfo,
} from "./config.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { computeDHash, computePHash } from "../src/matching/hash-core.ts";

// We use the 'sharp' library via Deno's npm compatibility for image processing
import sharp from "npm:sharp@0.33.2";

const CARDS_FILE = join(BULK_DIR, "cards.json");
const HASH_DB_FILE = join(OUTPUT_DIR, "hash-db.bin");
const METADATA_FILE = join(OUTPUT_DIR, "metadata.json");
const PROGRESS_INTERVAL = 1000;

/**
 * Binary format (version 2):
 *
 * Header (16 bytes):
 *   [0..3]  Magic: "MTGH" (4 bytes)
 *   [4..5]  Version: 2 (uint16)
 *   [6..9]  Entry count (uint32)
 *   [10..11] Hash size in bytes: 8 for 64-bit (uint16)
 *   [12..15] Reserved (uint32, set to 0)
 *
 * Entries (48 bytes each):
 *   [0..15]  illustration_id as raw bytes (UUID without dashes, hex-decoded = 16 bytes)
 *   [16..23] art pHash      (uint64, big-endian)
 *   [24..31] art dHash      (uint64, big-endian)
 *   [32..39] full-card pHash (uint64, big-endian)
 *   [40..47] full-card dHash (uint64, big-endian)
 *
 * Two hash pairs are stored per illustration because they fail in different
 * ways, and the matcher searches both:
 *
 *   - The ART hashes come from Scryfall's `art_crop` and are invariant to frame
 *     treatment, set symbol and language. They are the only thing that matches
 *     a printing whose frame differs from the one in the bulk data.
 *   - The FULL-CARD hashes come from the whole card image and need no art-region
 *     crop at all. They are what make showcase / borderless / extended-art cards
 *     work, since no fixed percentage rectangle reliably frames their art.
 *
 * Version 1 (32-byte entries, art hashes only) is still readable by
 * src/matching/hashdb.ts, which degrades to art-only matching.
 */
const HEADER_SIZE = 16;
const ENTRY_SIZE = 48;
const DB_VERSION = 2;
const MAGIC = new TextEncoder().encode("MTGH");

interface HashEntry {
  illustrationId: string;
  artPHash: bigint;
  artDHash: bigint;
  /** Zero when no full card image was available for this illustration. */
  fullPHash: bigint;
  fullDHash: bigint;
}

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
  console.log(
    `Total unique illustrations in metadata: ${illustrationIds.length}`,
  );

  // Compute hashes for each illustration that has a downloaded art image.
  //
  // Every illustration is hashed twice: once from the art crop and once from
  // the full card image. See the binary format docblock above for why both are
  // kept. The art crop is mandatory (an entry without it is skipped); the full
  // card image is optional and its hashes are written as zero when missing, at
  // which point the matcher ignores that entry in the full-card hash space.
  console.log("Computing perceptual hashes (art crop + full card)...");
  const hashEntries: HashEntry[] = [];
  let processed = 0;
  let skipped = 0;
  let missingFull = 0;

  async function hashIllustration(
    illustrationId: string,
  ): Promise<HashEntry | null> {
    const artPath = join(CROP_ART_DIR, `${illustrationId}.jpg`);

    let art: { pHash: bigint; dHash: bigint };
    try {
      art = await computeHashes(await Deno.readFile(artPath));
    } catch {
      // No art crop on disk (or it failed to decode): nothing to index.
      return null;
    }

    // The full card image is best-effort.
    let full = { pHash: 0n, dHash: 0n };
    try {
      full = await computeHashes(
        await Deno.readFile(join(FULL_ART_DIR, `${illustrationId}.jpg`)),
      );
    } catch {
      missingFull++;
    }

    return {
      illustrationId,
      artPHash: art.pHash,
      artDHash: art.dHash,
      fullPHash: full.pHash,
      fullDHash: full.dHash,
    };
  }

  // sharp releases the event loop while decoding, so hashing a batch
  // concurrently is dramatically faster than one at a time (~100k images).
  const CONCURRENCY = 16;
  for (let i = 0; i < illustrationIds.length; i += CONCURRENCY) {
    const batch = illustrationIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(hashIllustration));

    for (const entry of results) {
      if (entry) {
        hashEntries.push(entry);
        processed++;
      } else {
        skipped++;
      }
    }

    if (
      Math.floor(i / PROGRESS_INTERVAL) !==
        Math.floor((i + CONCURRENCY) / PROGRESS_INTERVAL)
    ) {
      console.log(`  Hashed ${processed} illustrations...`);
    }
  }

  console.log(`\nHash computation complete:`);
  console.log(`  Hashed: ${processed}`);
  console.log(`  Skipped (no art crop): ${skipped}`);
  console.log(`  Missing full card image: ${missingFull}`);

  // Generate binary hash database
  console.log("\nGenerating binary hash database...");
  const dbBuffer = new ArrayBuffer(
    HEADER_SIZE + hashEntries.length * ENTRY_SIZE,
  );
  const dbView = new DataView(dbBuffer);
  const dbBytes = new Uint8Array(dbBuffer);

  // Write header
  dbBytes.set(MAGIC, 0);
  dbView.setUint16(4, DB_VERSION);
  dbView.setUint32(6, hashEntries.length);
  dbView.setUint16(10, 8); // 8 bytes per hash
  dbView.setUint32(12, 0); // Reserved

  // Write entries
  for (let i = 0; i < hashEntries.length; i++) {
    const offset = HEADER_SIZE + i * ENTRY_SIZE;
    const entry = hashEntries[i];

    // Write illustration_id as 16 raw bytes (UUID hex-decoded)
    const idBytes = hexToBytes(entry.illustrationId.replace(/-/g, ""));
    dbBytes.set(idBytes, offset);

    // Hash pairs, each 8 bytes big-endian
    writeBigUint64(dbView, offset + 16, entry.artPHash);
    writeBigUint64(dbView, offset + 24, entry.artDHash);
    writeBigUint64(dbView, offset + 32, entry.fullPHash);
    writeBigUint64(dbView, offset + 40, entry.fullDHash);
  }

  await Deno.writeFile(HASH_DB_FILE, new Uint8Array(dbBuffer));
  console.log(
    `  Hash DB: ${HASH_DB_FILE} (${
      (dbBuffer.byteLength / 1024).toFixed(1)
    } KB)`,
  );

  // Write metadata JSON
  await Deno.writeTextFile(METADATA_FILE, JSON.stringify(metadata));
  const metaSize = new TextEncoder().encode(JSON.stringify(metadata)).length;
  console.log(
    `  Metadata: ${METADATA_FILE} (${(metaSize / 1024 / 1024).toFixed(1)} MB)`,
  );

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
 * Uses sharp for image resizing, then delegates to the shared hash algorithms
 * in src/matching/hash-core.ts.
 */
async function computeHashes(
  imageBuffer: Uint8Array,
): Promise<{ pHash: bigint; dHash: bigint }> {
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
