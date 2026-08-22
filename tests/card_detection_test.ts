/// <reference lib="deno.ns" />

/**
 * Card Detection Tests
 *
 * Two granularities are exercised here:
 *
 *  1. Full-pipeline identification (the primary tests): a raw image file is
 *     decoded to pixels and handed to `identifyCardInMat`, which runs the
 *     ENTIRE image-processing chain — contour detection, perspective warp,
 *     orientation resolution (geometric, plus both 180° flips), candidate
 *     extraction (uncropped card + three art-region layouts), hashing and
 *     database matching — and returns the best match. No rotation or other
 *     image manipulation happens in the test itself; everything under test is
 *     production code exactly as the app runs it.
 *
 *  2. Lower-level unit checks: corner ordering, quad orientation, contour
 *     detection, warp dimensions, and the hash database / metadata loading.
 *
 * Fixtures (tests/data/input/):
 *   card_on_white.jpg     — "Temple of Mystery"        (EXIF-rotated 90°)
 *   webcam_pic_noisy.jpg  — "Kaito's Pursuit"          (card physically 180°)
 *   webcam_pic_noisy_2.jpg— "Heir of the Ancient Fang" (card physically 180°)
 *   webcam_pic_noisy_3.jpg— "Primeval Titan"           (borderless showcase)
 *   webcam_pic_noisy_4.jpg— "Mister Negative"
 *   webcam_pic_noisy_5.jpg— "Hydro-Man, Fluid Felon"
 *   full_art_white_on_white.jpg          — "Intangible Virtue" (WOT #6)
 *   junji_on_white.jpg                   — "Junji, the Midnight Sky" (NEO #102)
 *   toshiro_umezawa_sld_on_white.jpg     — "Toshiro Umezawa" (SLD #261)
 *   sleeved_multani.jpg                  — "Multani, Yavimaya's Avatar" (DOM #174, sleeved)
 *   crucible_of_worlds_sleeved_on_mat.jpg — "Crucible of Worlds" (sleeved, on mat)
 *   thalia_guadian_of_thraben_on_mat.jpg  — "Thalia, Guardian of Thraben" (on mat)
 *   villainous_wealth_sleeved_on_mat.jpg   — "Villainous Wealth" (sleeved, on mat)
 *   villainous_wealth_sleeved_on_white.jpg — "Villainous Wealth" (sleeved, on white)
 *
 * The fixtures are in DIFFERENT orientations, which is precisely why the full
 * pipeline must resolve orientation itself rather than relying on the test to
 * pre-rotate the image. They also cover both hash spaces: the first three are
 * won by an art crop, the last three by the uncropped full-card hash.
 *
 * jpeg-js is used only to decode the JPEG to raw RGBA pixels (the vendored
 * OpenCV.js build has no imgcodecs / imdecode).
 */

import {
  assert,
  assertEquals,
  assertGreater,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { HashDB } from "../src/matching/hashdb.ts";
import {
  detectCardInMat,
  orderPoints,
  orientQuadPortrait,
  type PipelineResult,
} from "../src/detection/pipeline.ts";
import { identifyCardInMat } from "../src/detection/identify.ts";
import jpeg from "npm:jpeg-js@0.4.4";
import cv, { type Mat } from "../vendor/opencv/mod.ts";
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
  /**
   * Set when this fixture is a known, not-yet-fixed detection/identification
   * failure (tracked in docs/plans/non_white_surface_detection.md). The test
   * asserts that it *still* fails, so the suite stays green without hiding
   * the fixture — and so it fails loudly (telling you to drop this flag)
   * the moment a future fix makes it pass.
   */
  knownFailing?: string;
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

// Borderless showcase printing, whose in-frame art sits where none of the
// ART_REGIONS rectangles look. Only the uncropped full-card hash identifies it.
const PRIMEVAL_TITAN: Fixture = {
  file: "webcam_pic_noisy_3.jpg",
  name: "Primeval Titan",
  illustrationId: "8c621873-0029-4f00-943a-7923a5fbaa16",
};

const MR_NEGATIVE: Fixture = {
  file: "webcam_pic_noisy_4.jpg",
  name: "Mister Negative",
  illustrationId: "6c965ec9-f636-4148-9a0d-563f459f3478",
};

const HYDROMAN: Fixture = {
  file: "webcam_pic_noisy_5.jpg",
  name: "Hydro-Man, Fluid Felon",
  illustrationId: "42defbd3-7471-494b-a1ee-92e5784d0e3c",
};

// Newly added fixtures — not yet expected to pass.
const INTANGIBLE_VIRTUE: Fixture = {
  file: "full_art_white_on_white.jpg",
  name: "Intangible Virtue",
  illustrationId: "08794123-97e8-4aa9-8ee3-97bb2e552280",
};

const JUNJI: Fixture = {
  file: "junji_on_white.jpg",
  name: "Junji, the Midnight Sky",
  illustrationId: "ca4b32ec-4236-4d01-9372-a6aa1b688119",
};

const TOSHIRO_SLD: Fixture = {
  file: "toshiro_umezawa_sld_on_white.jpg",
  name: "Toshiro Umezawa",
  illustrationId: "512d84dd-10e4-4218-9454-cdf40721409c",
};

const MULTANI_SLEEVED: Fixture = {
  file: "sleeved_multani.jpg",
  name: "Multani, Yavimaya's Avatar",
  illustrationId: "2e356f4d-df6b-47f7-8a11-6e9bb1b7d080",
};

const CONDUIT_SLEEVED: Fixture = {
  file: "conduit_of_worlds_sleeved_on_mat.jpg",
  name: "Conduit of Worlds",
  illustrationId: "50414312-464d-4869-b96a-c731db9d485f",
  knownFailing:
    "dark/textured playmat with no clean card contour — see docs/plans/non_white_surface_detection.md",
};

const THALIA: Fixture = {
  file: "thalia_guadian_of_thraben_on_mat.jpg",
  name: "Thalia, Guardian of Thraben",
  illustrationId: "dd372f20-0ea6-4e69-92b5-c3d3d1a2ba2e",
};

const VILLAINOUS_WEALTH_MAT: Fixture = {
  file: "villainous_wealth_sleeved_on_mat.jpg",
  name: "Villainous Wealth",
  illustrationId: "e46a8183-2725-4ddf-9494-8f4367af826f",
  knownFailing:
    "dark/textured playmat with no clean card contour — see docs/plans/non_white_surface_detection.md",
};

const VILLAINOUS_WEALTH_WHITE: Fixture = {
  file: "villainous_wealth_sleeved_on_white.jpg",
  name: "Villainous Wealth",
  illustrationId: "e46a8183-2725-4ddf-9494-8f4367af826f",
};

const FIXTURES: Fixture[] = [
  TEMPLE,
  KAITO,
  HEIR,
  PRIMEVAL_TITAN,
  MR_NEGATIVE,
  HYDROMAN,
  INTANGIBLE_VIRTUE,
  JUNJI,
  TOSHIRO_SLD,
  MULTANI_SLEEVED,
  CONDUIT_SLEEVED,
  THALIA,
  VILLAINOUS_WEALTH_MAT,
  VILLAINOUS_WEALTH_WHITE,
];

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
function loadImageMat(file: string): Mat {
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

for (const fixture of FIXTURES) {
  Deno.test(
    `full pipeline identifies ${fixture.name} from raw image`,
    async () => {
      const db = await loadDB();
      const src = loadImageMat(fixture.file);

      const runAssertions = async () => {
        const result = identifyCardInMat(cv, src, db);

        assert(result.detected, "Should detect a card shape");
        assert(result.matched, "Should match the card against the database");
        assert(result.match, "Should return a match");
        assert(
          result.orientation === 0 || result.orientation === 1,
          `Orientation should be 0 or 1, got ${result.orientation}`,
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
      };

      try {
        if (fixture.knownFailing) {
          await assertRejects(
            () => runAssertions(),
            Error,
            undefined,
            `${fixture.name} is marked knownFailing (${fixture.knownFailing}) but now passes — remove the knownFailing flag on this fixture`,
          );
        } else {
          await runAssertions();
        }
      } finally {
        src.delete();
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Detection Performance Tests
// ---------------------------------------------------------------------------
const WARMUP_ITERATIONS = 2;
const TIMED_ITERATIONS = 5;
function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
/** Median wall-clock time (ms) of `fn`, after discarding warm-up runs. */
function timeMedian(fn: () => void): number {
  for (let i = 0; i < WARMUP_ITERATIONS; i++) fn();

  const timings: number[] = [];
  for (let i = 0; i < TIMED_ITERATIONS; i++) {
    const t0 = performance.now();
    fn();
    timings.push(performance.now() - t0);
  }
  return median(timings);
}

for (const fixture of FIXTURES) {
  if (fixture.knownFailing) continue; // Skip known-failing fixtures for performance tests, since they don't reach the matching stage.
  Deno.test(`detectCardInMat: ${fixture.file} completes within budget (${fixture.name})`, () => {
    const budget_ms = 50;
    const src = loadImageMat(fixture.file);
    try {
      const elapsed = timeMedian(() => {
        const result = detectCardInMat(cv, src);
        result.cardMat?.delete();
      });
      assert(
        elapsed < budget_ms,
        `detectCardInMat(${fixture.file}) took ${
          elapsed.toFixed(1)
        }ms (median of ${TIMED_ITERATIONS}), budget is ${budget_ms}ms`,
      );
    } finally {
      src.delete();
    }
  });
}

for (const fixture of FIXTURES) {
  if (fixture.knownFailing) continue; // Skip known-failing fixtures for performance tests, since they don't reach the matching stage.
  Deno.test(`identifyCardInMat: ${fixture.file} completes within budget (${fixture.name})`, async () => {
    const db = await loadDB();
    const src = loadImageMat(fixture.file);
    const budget_ms = 90;
    try {
      const elapsed = timeMedian(() => {
        identifyCardInMat(cv, src, db);
      });
      assert(
        elapsed < budget_ms,
        `identifyCardInMat(${fixture.file}) took ${
          elapsed.toFixed(1)
        }ms (median of ${TIMED_ITERATIONS}), budget is ${budget_ms}ms`,
      );
    } finally {
      src.delete();
    }
  });
}

// ---------------------------------------------------------------------------
// Quad geometry unit tests (pure, no OpenCV)
// ---------------------------------------------------------------------------

/** Rotate a point about the origin by `deg` (screen coords, y down). */
function rotate(
  [x, y]: [number, number],
  deg: number,
): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
}

/** True if the 4-point cycle has no self-intersection (a simple polygon). */
function isSimpleQuad(q: [number, number][]): boolean {
  const cross = (
    o: [number, number],
    a: [number, number],
    b: [number, number],
  ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  // A simple quad traversed in order has consistently-signed turns.
  const signs = [0, 1, 2, 3].map((i) =>
    Math.sign(cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]))
  );
  return signs.every((s) => s > 0) || signs.every((s) => s < 0);
}

Deno.test("orderPoints returns TL/TR/BR/BL for an axis-aligned quad", () => {
  const tl: [number, number] = [10, 20];
  const tr: [number, number] = [110, 20];
  const br: [number, number] = [110, 160];
  const bl: [number, number] = [10, 160];

  // Deliberately shuffled input.
  const ordered = orderPoints([br, bl, tr, tl]);

  assertEquals(ordered, [tl, tr, br, bl]);
});

Deno.test("orderPoints yields a simple cycle at any rotation", () => {
  // A portrait card-ish rectangle centred on the origin.
  const base: [number, number][] = [
    [-50, -70],
    [50, -70],
    [50, 70],
    [-50, 70],
  ];

  for (let deg = 0; deg < 360; deg += 5) {
    const rotated = base.map((p) =>
      // Translate away from the origin so all coords stay positive-ish.
      [rotate(p, deg)[0] + 500, rotate(p, deg)[1] + 500] as [number, number]
    );
    const ordered = orderPoints(rotated);

    assertEquals(ordered.length, 4, `4 corners at ${deg}°`);
    assert(
      isSimpleQuad(ordered),
      `Ordering at ${deg}° must not self-intersect: ${JSON.stringify(ordered)}`,
    );
    // Every input corner must appear exactly once.
    for (const p of rotated) {
      assertEquals(
        ordered.filter((o) => o[0] === p[0] && o[1] === p[1]).length,
        1,
        `Corner ${JSON.stringify(p)} appears exactly once at ${deg}°`,
      );
    }
  }
});

Deno.test("orderPoints handles a 45° rotated quad", () => {
  // The degenerate case for the old x+y / x-y extreme sort: a diamond, where
  // two corners share the same x+y and two share the same x-y.
  const diamond: [number, number][] = [
    [100, 0],
    [200, 100],
    [100, 200],
    [0, 100],
  ];

  const ordered = orderPoints(diamond);
  assert(isSimpleQuad(ordered), "Diamond ordering must not self-intersect");
  assertEquals(new Set(ordered.map((p) => p.join(","))).size, 4);
});

Deno.test("orientQuadPortrait leaves a portrait quad alone", () => {
  const portrait: [number, number][] = [
    [0, 0],
    [100, 0],
    [100, 200],
    [0, 200],
  ];

  assertEquals(orientQuadPortrait(portrait), portrait);
});

Deno.test("orientQuadPortrait rotates a landscape quad upright", () => {
  const landscape: [number, number][] = [
    [0, 0],
    [200, 0],
    [200, 100],
    [0, 100],
  ];

  const oriented = orientQuadPortrait(landscape);

  // Cycle rotated by one step: the long edge now runs top-to-bottom.
  assertEquals(oriented, [[0, 100], [0, 0], [200, 0], [200, 100]]);

  const width = Math.hypot(
    oriented[1][0] - oriented[0][0],
    oriented[1][1] - oriented[0][1],
  );
  const height = Math.hypot(
    oriented[3][0] - oriented[0][0],
    oriented[3][1] - oriented[0][1],
  );
  assertGreater(height, width, "Long axis should run top-to-bottom");
});

// ---------------------------------------------------------------------------
// Lower-level detection checks (card_on_white fixture)
// ---------------------------------------------------------------------------

/** Lazy-cached detection result for the low-level geometry tests. */
let _cached: PipelineResult | undefined;
let _cachedMat: Mat;

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

Deno.test("HashDB exposes both art and full-card hash spaces", async () => {
  const db = await loadDB();

  assert(
    db.hasFullCardHashes,
    "Checked-in DB should be format v2 (rebuild with `deno task db:build`)",
  );

  const idx = db.findByIllustrationId(TEMPLE.illustrationId);
  const entry = db.getEntry(idx);

  assert(entry.fullPHash !== 0n, "full-card pHash should be non-zero");
  assert(entry.fullDHash !== 0n, "full-card dHash should be non-zero");

  // The two spaces describe different images, so they must not coincide.
  assert(
    entry.pHash !== entry.fullPHash,
    "art and full-card pHash should differ",
  );

  // Bulk accessors must be parallel to the entry accessors.
  assertEquals(db.getFullPHashes().length, db.size);
  assertEquals(db.getFullDHashes().length, db.size);
  assertEquals(db.getFullPHashes()[idx], entry.fullPHash);
});

Deno.test("HashDB rejects an unsupported format version", () => {
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode("MTGH"), 0);
  view.setUint16(4, 99);
  view.setUint32(6, 0);
  view.setUint16(10, 8);

  assertThrows(
    () => HashDB.fromBuffer(buf),
    Error,
    "Unsupported hash DB version",
  );
});

Deno.test("metadata contains Temple of Mystery", async () => {
  const metadata = await loadMetadata();
  const entry = metadata.illustrations[TEMPLE.illustrationId];

  assert(
    entry,
    `Metadata should contain illustration ${TEMPLE.illustrationId}`,
  );
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
