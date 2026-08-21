import { test, expect } from "@playwright/test";

// Staged cards should list most-recently-scanned first (reverse scan order),
// so a user reviewing after a scan session sees what they just scanned at
// the top instead of having to scroll past everything before it.
test("staging review shows most recently scanned card first", async ({ page }) => {
  // Seed the staging list directly via localStorage (same shape StagingList
  // persists/restores, see src/collection/staging.ts) instead of scanning
  // real cards through the camera — we only care about display order here.
  await page.addInitScript(() => {
    const cards = [
      { name: "First Scanned", scannedAt: "2024-01-01T00:00:00.000Z" },
      { name: "Second Scanned", scannedAt: "2024-01-01T00:00:01.000Z" },
      { name: "Third Scanned", scannedAt: "2024-01-01T00:00:02.000Z" },
    ].map((c, i) => ({
      id: `staged-${i}`,
      illustrationId: `illustration-${i}`,
      scryfallId: `scryfall-${i}`,
      oracleId: `oracle-${i}`,
      name: c.name,
      setCode: "TST",
      setName: "Test Set",
      collectorNumber: String(i + 1),
      quantity: 1,
      condition: "NM",
      confidence: 100,
      scannedAt: c.scannedAt,
    }));
    localStorage.setItem("mana-vault:staging", JSON.stringify(cards));
  });

  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", { timeout: 30_000 });

  await page.click("#btn-staging");

  const names = await page.locator(".staged-card .card-name").allTextContents();
  expect(names).toEqual(["Third Scanned", "Second Scanned", "First Scanned"]);
});
