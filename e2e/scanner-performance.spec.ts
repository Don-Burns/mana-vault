import { expect, test } from "@playwright/test";

// Performance guard for the full in-browser scan-to-match path, mirroring
// tests/scan_performance_test.ts (which times detectCardInMat/
// identifyCardInMat directly in Deno) but through the real browser stack:
// fake camera -> canvas frame capture -> CardDetector.detect (WASM
// OpenCV.js, requestAnimationFrame loop) -> stability tracking -> hash
// matching -> match splash. Catches regressions that only show up with
// real browser/WASM overhead (e.g. main-thread contention with rendering)
// as well as ones already caught at the unit level, since here they're
// multiplied by STABLE_THRESHOLD (8) consecutive frames required before a
// capture fires.
//
// Uses the same fake-camera fixture as scanner-match.spec.ts (card.mjpeg,
// a loop of tests/data/input/card_on_white.jpg = "Temple of Mystery").
//
// Budget derived empirically (multiple runs, this machine): scan-to-match
// wall time from when the camera is ready to when the match splash appears
// was 1.30-1.86s at 0bebe7a (pre-regression) vs. 1.86-2.86s at 747fb2c
// (post-regression, unfixed) vs. 1.81-2.40s after removing the redundant
// refineInnerCardQuad double-detection pass (see pipeline.ts). 2800ms sits
// comfortably above the fixed range (leaving room for the legitimate cost
// of the adaptive-threshold fallback pass) while still well below the
// unfixed regression's range.
const BUDGET_MS = 2_500;

test("scanner reaches a match within budget", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", {
    timeout: 30_000,
  });

  const t0 = Date.now();
  await expect(page.locator("#match-splash-name")).toHaveText(
    "Temple of Mystery",
    { timeout: 30_000 },
  );
  const elapsed = Date.now() - t0;

  expect(
    elapsed,
    `scanning to first match took ${elapsed}ms, budget is ${BUDGET_MS}ms`,
  ).toBeLessThan(BUDGET_MS);
});
