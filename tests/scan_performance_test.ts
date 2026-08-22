/// <reference lib="deno.ns" />
/**
 * Performance guard for the card-scanning pipeline.
 *
 * Regression covered: between 0bebe7a and 747fb2c, `detectCardInMat`'s
 * candidate-collection step went from 2 contour passes (Canny, Otsu) to 3
 * (+ adaptive threshold), and gained `refineInnerCardQuad`, which re-runs the
 * *entire* 3-pass candidate collection a second time on the warped card to
 * check for a nested sleeve edge. Worst case, that's up to 6 contour passes
 * per scanned frame where there used to be 2.
 *
 * Two tiers are timed:
 *
 *  1. `detectCardInMat` — isolates exactly the code above, uncontaminated by
 *     hashing/DB-matching cost (which this diff didn't touch).
 *  2. `identifyCardInMat` — the full pipeline, reflecting real user-facing
 *     scan latency.
 *
 * Budgets are derived from median timings measured at 0bebe7a (the last
 * commit before the regression) plus ~50% headroom, not guessed.
 *
 * Expected to FAIL on main as of 747fb2c and later (measured ~2-3x over
 * budget); PASS once the candidate-collection/refinement cost is brought
 * back down to the 0bebe7a baseline (or the budgets are consciously raised
 * with a comment explaining the accepted new cost).
 */

import { assert } from "@std/assert";
import { HashDB } from "../src/matching/hashdb.ts";
import { detectCardInMat } from "../src/detection/pipeline.ts";
import { identifyCardInMat } from "../src/detection/identify.ts";
import jpeg from "npm:jpeg-js@0.4.4";
import cv, { type Mat } from "../vendor/opencv/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const ROOT = join(import.meta.dirname!, "..");
const INPUT_DIR = join(ROOT, "tests", "data", "input");
const HASH_DB_PATH = join(ROOT, "data", "output", "hash-db.bin");

const WARMUP_ITERATIONS = 2;
const TIMED_ITERATIONS = 5;

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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
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

interface Fixture {
  file: string;
  /** Which candidate-collection path this fixture exercises. */
  covers: string;
}

const FIXTURES: Fixture[] = [
  { file: "card_on_white.jpg", covers: "plain card (baseline 2-pass path)" },
  {
    file: "sleeved_multani.jpg",
    covers: "sleeved card (refineInnerCardQuad double-pass)",
  },
  {
    file: "junji_on_white.jpg",
    covers: "white-on-white (adaptive threshold pass)",
  },
];

// Budgets = median @ 0bebe7a (last commit before the regression) * 1.5
// headroom, rounded. Measured medians at 0bebe7a were:
//   card_on_white.jpg:    detect 25.8ms, identify 57.3ms
//   sleeved_multani.jpg:  detect 22.5ms, identify 49.9ms
//   junji_on_white.jpg:   detect 22.6ms, identify 51.0ms
// At 747fb2c (post-regression) these are ~70-80ms / ~100-110ms — 3x and 2x
// over budget respectively, which is exactly what these tests should catch.
const DETECT_BUDGET_MS: Record<string, number> = {
  "card_on_white.jpg": 40,
  "sleeved_multani.jpg": 40,
  "junji_on_white.jpg": 40,
};

const IDENTIFY_BUDGET_MS: Record<string, number> = {
  "card_on_white.jpg": 75,
  "sleeved_multani.jpg": 75,
  "junji_on_white.jpg": 75,
};

for (const fixture of FIXTURES) {
  Deno.test(`detectCardInMat: ${fixture.file} completes within budget (${fixture.covers})`, () => {
    const src = loadImageMat(fixture.file);
    try {
      const elapsed = timeMedian(() => {
        const result = detectCardInMat(cv, src);
        result.cardMat?.delete();
      });
      const budget = DETECT_BUDGET_MS[fixture.file];
      assert(
        elapsed < budget,
        `detectCardInMat(${fixture.file}) took ${
          elapsed.toFixed(1)
        }ms (median of ${TIMED_ITERATIONS}), budget is ${budget}ms`,
      );
    } finally {
      src.delete();
    }
  });
}

for (const fixture of FIXTURES) {
  Deno.test(`identifyCardInMat: ${fixture.file} completes within budget (${fixture.covers})`, async () => {
    const db = await loadDB();
    const src = loadImageMat(fixture.file);
    try {
      const elapsed = timeMedian(() => {
        identifyCardInMat(cv, src, db);
      });
      const budget = IDENTIFY_BUDGET_MS[fixture.file];
      assert(
        elapsed < budget,
        `identifyCardInMat(${fixture.file}) took ${
          elapsed.toFixed(1)
        }ms (median of ${TIMED_ITERATIONS}), budget is ${budget}ms`,
      );
    } finally {
      src.delete();
    }
  });
}
