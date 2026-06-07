/// <reference lib="deno.ns" />

/**
 * Card Detection Tests
 *
 * End-to-end tests that verify the full detection + matching pipeline can
 * identify a card from a photo.  Uses:
 *
 *   tests/data/input/card_on_white.jpg
 *     — a photo of "Temple of Mystery" (M3C #390) on a white background
 *
 * The pipeline exercised here is the same one the PWA uses at runtime:
 *
 *   JPEG → OpenCV (contour detection, perspective warp, art crop)
 *        → pHash / dHash  → Hamming search against hash DB
 *
 * jpeg-js is used only to decode the JPEG to raw RGBA pixels (since the
 * vendored OpenCV.js build does not include imgcodecs / imdecode).
 *
 * What IS tested:
 *   - OpenCV contour detection and quadrilateral filtering
 *   - Perspective warp to standard 745×1040 card
 *   - Art region extraction via frame classification
 *   - Hash computation (both server-side and client-side paths)
 *   - Hamming distance matching against the hash DB
 *   - Metadata lookup
 *
 * What is NOT tested (requires browser / camera):
 *   - Camera capture
 *   - Web Worker message passing
 *   - Auto-capture stabilization logic
 */

import { assertEquals, assertGreater, assert } from "@std/assert";
import { computePHash, computeDHash } from "../src/matching/hash-core.ts";
import { computeHashesFromImageData } from "../src/matching/hasher.ts";
import { HashDB } from "../src/matching/hashdb.ts";
import { findMatches } from "../src/matching/matcher.ts";
import {
  detectCardInMat,
  matToImageData,
  type PipelineResult,
} from "../src/detection/pipeline.ts";
// deno-lint-ignore no-explicit-any
import jpeg from "npm:jpeg-js@0.4.4";
// deno-lint-ignore no-explicit-any
import cv from "../vendor/opencv/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

// --- Paths ---

const ROOT = join(import.meta.dirname!, "..");
const TEST_IMAGE = join(ROOT, "tests", "data", "input", "card_on_white.jpg");
const HASH_DB_PATH = join(ROOT, "data", "output", "hash-db.bin");
const METADATA_PATH = join(ROOT, "data", "output", "metadata.json");

// --- Test fixture constants ---

const EXPECTED_NAME = "Temple of Mystery";
const EXPECTED_ILLUSTRATION_ID = "7a680051-8ecd-42e0-aea6-eaf532aef0db";

// --- Helpers ---

interface CardMetadata {
  illustrations: Record<
    string,
    { oracle_id: string; name: string; printings: unknown[] }
  >;
}

/**
 * Load the test image via jpeg-js, apply EXIF rotation, return an OpenCV Mat.
 *
 * The test fixture has EXIF orientation 6 ("right-top") which means the raw
 * sensor image is landscape 816×612 and needs a 90° clockwise rotation to
 * produce the correct portrait 612×816 orientation.
 *
 * jpeg-js decodes raw pixels without applying EXIF rotation, so we rotate
 * manually with cv.rotate().
 */
// deno-lint-ignore no-explicit-any
function loadTestImage(): { mat: any; width: number; height: number } {
  const fileData = Deno.readFileSync(TEST_IMAGE);
  const decoded = jpeg.decode(fileData, { useTArray: true });

  const imgData = {
    data: new Uint8ClampedArray(decoded.data),
    width: decoded.width,
    height: decoded.height,
  } as unknown as ImageData;

  const raw = cv.matFromImageData(imgData);

  // EXIF orientation 6 → rotate 90° clockwise
  const rotated = new cv.Mat();
  cv.rotate(raw, rotated, cv.ROTATE_90_CLOCKWISE);
  raw.delete();

  return { mat: rotated, width: rotated.cols, height: rotated.rows };
}

/** Lazy-cached detection result (shared across tests). */
let _cached: PipelineResult | undefined;
// deno-lint-ignore no-explicit-any
let _cachedMat: any;

function getDetection(): PipelineResult {
  if (_cached) return _cached;

  const { mat } = loadTestImage();
  _cachedMat = mat;
  _cached = detectCardInMat(cv, mat);
  return _cached;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("HashDB loads and parses the binary database", async () => {
  const buf = await Deno.readFile(HASH_DB_PATH);
  const db = HashDB.fromBuffer(buf.buffer);

  assertGreater(db.size, 0, "DB should have entries");

  // Spot-check: the known illustration must be present
  const idx = db.findByIllustrationId(EXPECTED_ILLUSTRATION_ID);
  assert(idx >= 0, `DB should contain illustration ${EXPECTED_ILLUSTRATION_ID}`);

  const entry = db.getEntry(idx);
  assertEquals(entry.illustrationId, EXPECTED_ILLUSTRATION_ID);
  assert(entry.pHash !== 0n, "pHash should be non-zero");
  assert(entry.dHash !== 0n, "dHash should be non-zero");
});

Deno.test("metadata contains Temple of Mystery", async () => {
  const metadata: CardMetadata = JSON.parse(
    await Deno.readTextFile(METADATA_PATH),
  );
  const entry = metadata.illustrations[EXPECTED_ILLUSTRATION_ID];

  assert(
    entry,
    `Metadata should contain illustration ${EXPECTED_ILLUSTRATION_ID}`,
  );
  assertEquals(entry.name, EXPECTED_NAME);
  assertGreater(entry.printings.length, 0, "Should have at least one printing");
});

Deno.test("OpenCV detects card contour in test image", () => {
  const result = getDetection();

  assert(result.found, "Should detect a card in the test image");
  assert(result.corners, "Should return corner points");
  assertEquals(result.corners!.length, 4, "Should have exactly 4 corners");

  // Sanity-check: all corners should be within the image bounds
  const { width, height } = { width: _cachedMat!.cols, height: _cachedMat!.rows };
  for (const [x, y] of result.corners!) {
    assert(x >= 0 && x <= width, `Corner x=${x} should be within [0, ${width}]`);
    assert(y >= 0 && y <= height, `Corner y=${y} should be within [0, ${height}]`);
  }
});

Deno.test("perspective correction produces standard card dimensions", () => {
  const result = getDetection();

  assert(result.cardMat, "Should have a perspective-corrected card Mat");
  assertEquals(result.cardMat.cols, 745, "Card width should be 745 px");
  assertEquals(result.cardMat.rows, 1040, "Card height should be 1040 px");
});

Deno.test("full pipeline identifies Temple of Mystery", async () => {
  const result = getDetection();
  assert(result.artMat, "Should have extracted art region");

  // Resize art to 32×32 grayscale (mirrors what build-hashdb.ts does)
  const gray = new cv.Mat();
  const resized = new cv.Mat();

  if (result.artMat.channels() === 4) {
    cv.cvtColor(result.artMat, gray, cv.COLOR_RGBA2GRAY);
  } else if (result.artMat.channels() === 3) {
    cv.cvtColor(result.artMat, gray, cv.COLOR_BGR2GRAY);
  } else {
    result.artMat.copyTo(gray);
  }

  cv.resize(gray, resized, new cv.Size(32, 32), 0, 0, cv.INTER_AREA);

  const pixels = new Uint8Array(resized.data);
  const pHash = computePHash(pixels, 32);
  const dHash = computeDHash(pixels, 32);

  gray.delete();
  resized.delete();

  assert(pHash !== 0n, "pHash should be non-zero");
  assert(dHash !== 0n, "dHash should be non-zero");

  const dbBuf = await Deno.readFile(HASH_DB_PATH);
  const db = HashDB.fromBuffer(dbBuf.buffer);
  const matches = findMatches(db, pHash, dHash);

  assertGreater(matches.length, 0, "Should find at least one match");

  const best = matches[0];
  const metadata: CardMetadata = JSON.parse(
    await Deno.readTextFile(METADATA_PATH),
  );
  const cardName = metadata.illustrations[best.illustrationId]?.name;

  assertEquals(cardName, EXPECTED_NAME, "Best match should be Temple of Mystery");
  assertEquals(best.illustrationId, EXPECTED_ILLUSTRATION_ID);
  assertGreater(best.confidence, 0, "Confidence should be above zero");
});

Deno.test("client-side hash path identifies Temple of Mystery", async () => {
  const result = getDetection();
  assert(result.artMat, "Should have extracted art region");

  // Convert to ImageData (RGBA) — this is what the browser path does
  const imageData = matToImageData(cv, result.artMat);

  const { pHash, dHash } = computeHashesFromImageData(imageData);

  assert(pHash !== 0n, "pHash should be non-zero");
  assert(dHash !== 0n, "dHash should be non-zero");

  const dbBuf = await Deno.readFile(HASH_DB_PATH);
  const db = HashDB.fromBuffer(dbBuf.buffer);
  const matches = findMatches(db, pHash, dHash);

  assertGreater(matches.length, 0, "Should find at least one match");

  const best = matches[0];
  const metadata: CardMetadata = JSON.parse(
    await Deno.readTextFile(METADATA_PATH),
  );
  const cardName = metadata.illustrations[best.illustrationId]?.name;

  assertEquals(
    cardName,
    EXPECTED_NAME,
    "Best match should be Temple of Mystery",
  );
});

Deno.test("best match is well ahead of second match", async () => {
  const result = getDetection();
  assert(result.artMat, "Should have extracted art region");

  const gray = new cv.Mat();
  const resized = new cv.Mat();

  if (result.artMat.channels() === 4) {
    cv.cvtColor(result.artMat, gray, cv.COLOR_RGBA2GRAY);
  } else if (result.artMat.channels() === 3) {
    cv.cvtColor(result.artMat, gray, cv.COLOR_BGR2GRAY);
  } else {
    result.artMat.copyTo(gray);
  }

  cv.resize(gray, resized, new cv.Size(32, 32), 0, 0, cv.INTER_AREA);

  const pHash = computePHash(new Uint8Array(resized.data), 32);
  const dHash = computeDHash(new Uint8Array(resized.data), 32);

  gray.delete();
  resized.delete();

  const dbBuf = await Deno.readFile(HASH_DB_PATH);
  const db = HashDB.fromBuffer(dbBuf.buffer);
  const matches = findMatches(db, pHash, dHash, 5);

  assertGreater(
    matches.length,
    1,
    "Should have multiple candidates to compare",
  );

  const gap = matches[1].combinedScore - matches[0].combinedScore;
  assertGreater(
    gap,
    2,
    "Best match should be well separated from runner-up (gap > 2)",
  );
});
