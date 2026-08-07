import { test, expect } from "@playwright/test";

// End-to-end detection + hashing + matching against the real, checked-in
// hash DB (public/db/), using a fake camera fed a real photo of a known
// card (tests/data/input/card_on_white.jpg = "Temple of Mystery",
// illustration 7a680051-8ecd-42e0-aea6-eaf532aef0db — see
// tests/card_detection_test.ts). Chromium's fake video device loops
// e2e/fixtures/card.mjpeg, generated from that same fixture image.

test("scanner detects and matches a known card from the camera feed", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", { timeout: 30_000 });

  // Auto-capture fires once the detector sees a stable card quad for enough
  // consecutive frames (STABLE_THRESHOLD in scanner-view.ts) — no manual
  // click needed, matching real-world usage.
  await expect(page.locator("#match-splash-name")).toHaveText("Temple of Mystery", {
    timeout: 30_000,
  });
});
