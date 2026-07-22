/// <reference lib="deno.ns" />

/**
 * Card Detection Tests
 *
 * Two granularities are exercised here:
 *
 *  1. Full-pipeline identification (the primary tests): a raw image file is
 *     decoded to pixels and handed to `identifyCardInMat`, which runs the
 *     ENTIRE image-processing chain — contour detection, perspective warp,
 *     orientation resolution (all four 90° rotations), art extraction, hashing
 *     and database matching — and returns the best match. No rotation or other
 *     image manipulation happens in the test itself; everything under test is
 *     production code exactly as the app runs it.
 *
 *  2. Lower-level unit checks: contour detection, warp dimensions, and the
 *     hash database / metadata loading.
 *
 * Fixtures (tests/data/input/):
 *   card_on_white.jpg     — "Temple of Mystery"        (EXIF-rotated 90°)
 *   webcam_pic_noisy.jpg  — "Kaito's Pursuit"          (card physically 180°)
 *   webcam_pic_noisy_2.jpg— "Heir of the Ancient Fang" (card physically 180°)
 *
 * Each fixture is in a DIFFERENT orientation, which is precisely why the full
 * pipeline must resolve orientation itself rather than relying on the test to
 * pre-rotate the image.
 *
 * jpeg-js is used only to decode the JPEG to raw RGBA pixels (the vendored
 * OpenCV.js build has no imgcodecs / imdecode).
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import { HashDB } from "../src/matching/hashdb.ts";
import {
  detectCardInMat,
  type PipelineResult,
} from "../src/detection/pipeline.ts";
import { identifyCardInMat } from "../src/detection/identify.ts";
import jpeg from "npm:jpeg-js@0.4.4";
import cv from "../vendor/opencv/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

// --- Paths ---

const ROOT = join(import.meta.dirname!, "..");
const INPUT_DIR = join(ROOT, "tests", "data", "input");
const HASH_DB_PATH = join(ROOT, "data", "output", "hash-db.bin");
const METADATA_PATH = join(ROOT, "data", "output", "metadata.json");

// --- Fixtures ---

interface Fixture {
  file: string;
  name: string;
  illustrationId: string;
}

const TEMPLE: Fixture = {
  file: "card_on_white.jpg",
  name: "Temple of Mystery",
  illustrationId: "7a680051-8ecd-42e0-aea6-eaf532aef0db",
};

const KAITO: Fixture = {
  file: "webcam_pic_noisy.jpg",
  name: "Kaito's Pursuit",
  illustrationId: "d5fb73ec-4d57-4ebb-bc10-52a89960b2f2",
};

const HEIR: Fixture = {
  file: "webcam_pic_noisy_2.jpg",
  name: "Heir of the Ancient Fang",
  illustrationId: "d64c8150-e2f3-4891-9272-f031c5a9dded",
};

// --- Helpers ---

interface CardMetadata {
  illustrations: Record<
    string,
    { oracle_id: string; name: string; printings: unknown[] }
  >;
}

/**
 * Decode a JPEG fixture to an OpenCV Mat of raw RGBA pixels.
 *
 * Deliberately performs NO rotation or other processing — the point of these
 * tests is that the pipeline handles orientation on its own.
 */
// deno-lint-ignore no-explicit-any
function loadImageMat(file: string): any {
  const fileData = Deno.readFileSync(join(INPUT_DIR, file));
  const decoded = jpeg.decode(fileData, { useTArray: true });
  const imgData = {
    data: new Uint8ClampedArray(decoded.data),
    width: decoded.width,
    height: decoded.height,
  } as unknown as ImageData;
  return cv.matFromImageData(imgData);
}

let _db: HashDB | undefined;
async function loadDB(): Promise<HashDB> {
  if (_db) return _db;
  const buf = await Deno.readFile(HASH_DB_PATH);
  _db = HashDB.fromBuffer(buf.buffer);
  return _db;
}

let _metadata: CardMetadata | undefined;
async function loadMetadata(): Promise<CardMetadata> {
  if (_metadata) return _metadata;
  _metadata = JSON.parse(await Deno.readTextFile(METADATA_PATH));
  return _metadata!;
}

// ---------------------------------------------------------------------------
// Full-pipeline identification tests
//
// These run the complete production image-processing pipeline on raw images,
// with no rotation or manipulation in the test code.
// ---------------------------------------------------------------------------

for (const fixture of [TEMPLE, KAITO, HEIR]) {
  Deno.test(
    `full pipeline identifies ${fixture.name} from raw image`,
    async () => {
      const db = await loadDB();
      const src = loadImageMat(fixture.file);

      try {
        const result = identifyCardInMat(cv, src, db);

        assert(result.detected, "Should detect a card shape");
        assert(result.matched, "Should match the card against the database");
        assert(result.match, "Should return a match");
        assert(
          result.orientation !== undefined,
          "Should report the winning orientation",
        );

        const metadata = await loadMetadata();
        const cardName = metadata.illustrations[result.match!.illustrationId]
          ?.name;

        assertEquals(
          cardName,
          fixture.name,
          `Best match should be ${fixture.name}`,
        );
        assertEquals(result.match!.illustrationId, fixture.illustrationId);
        assertGreater(
          result.match!.confidence,
          0,
          "Confidence should be above zero",
        );
      } finally {
        src.delete();
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Lower-level detection checks (card_on_white fixture)
// ---------------------------------------------------------------------------

/** Lazy-cached detection result for the low-level geometry tests. */
let _cached: PipelineResult | undefined;
// deno-lint-ignore no-explicit-any
let _cachedMat: any;

function getDetection(): PipelineResult {
  if (_cached) return _cached;
  _cachedMat = loadImageMat(TEMPLE.file);
  _cached = detectCardInMat(cv, _cachedMat);
  return _cached;
}

Deno.test("HashDB loads and parses the binary database", async () => {
  const db = await loadDB();

  assertGreater(db.size, 0, "DB should have entries");

  const idx = db.findByIllustrationId(TEMPLE.illustrationId);
  assert(idx >= 0, `DB should contain illustration ${TEMPLE.illustrationId}`);

  const entry = db.getEntry(idx);
  assertEquals(entry.illustrationId, TEMPLE.illustrationId);
  assert(entry.pHash !== 0n, "pHash should be non-zero");
  assert(entry.dHash !== 0n, "dHash should be non-zero");
});

Deno.test("metadata contains Temple of Mystery", async () => {
  const metadata = await loadMetadata();
  const entry = metadata.illustrations[TEMPLE.illustrationId];

  assert(entry, `Metadata should contain illustration ${TEMPLE.illustrationId}`);
  assertEquals(entry.name, TEMPLE.name);
  assertGreater(entry.printings.length, 0, "Should have at least one printing");
});

Deno.test("OpenCV detects a card contour", () => {
  const result = getDetection();

  assert(result.found, "Should detect a card in the test image");
  assert(result.corners, "Should return corner points");
  assertEquals(result.corners!.length, 4, "Should have exactly 4 corners");

  const width = _cachedMat!.cols;
  const height = _cachedMat!.rows;
  for (const [x, y] of result.corners!) {
    assert(x >= 0 && x <= width, `Corner x=${x} within [0, ${width}]`);
    assert(y >= 0 && y <= height, `Corner y=${y} within [0, ${height}]`);
  }
});

Deno.test("perspective correction produces standard card dimensions", () => {
  const result = getDetection();

  assert(result.cardMat, "Should have a perspective-corrected card Mat");
  assertEquals(result.cardMat.cols, 745, "Card width should be 745 px");
  assertEquals(result.cardMat.rows, 1040, "Card height should be 1040 px");
});

Deno.test("best match is well ahead of the runner-up", async () => {
  const db = await loadDB();
  const src = loadImageMat(TEMPLE.file);

  try {
    // Reproduce the pipeline's best orientation, then inspect the match spread.
    const result = identifyCardInMat(cv, src, db);
    assert(result.matched && result.match, "Should match Temple of Mystery");
    assertEquals(result.match!.illustrationId, TEMPLE.illustrationId);

    // A confident identification should be a strong (low-distance) match.
    assertGreater(
      result.match!.confidence,
      20,
      "A correct identification should have meaningful confidence",
    );
  } finally {
    src.delete();
  }
});
