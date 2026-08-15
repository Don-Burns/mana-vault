import { test, expect } from "@playwright/test";

// Performance guard for moving a large folder's worth of cards via the
// "Select All" + "Move to..." flow, against the real WASM/OPFS Turso driver
// (see tests/commit_performance_test.ts for the equivalent fast-driver
// check). There's no UI path to bulk-add 500 unique printings — the manual
// staging flow is one search-and-pick per card — so cards are seeded
// directly via collectionStore.commitAdd (exposed on window in main.ts for
// e2e only), the same call the staging-confirm button itself makes. Only
// the actual "move" (Select All -> Move to... -> confirm) is driven through
// real UI clicks, since that's the operation under test.

const BUDGET_MS = 1000;
// commitAdd/commitMove currently hang (don't even complete) somewhere
// between 150-200 new rows in a single transaction against the real
// browser WASM/OPFS driver (confirmed by hand: 150 rows ~80ms, 200+ rows
// still not resolved after 15s+). Cap how long we wait so a hang fails
// fast with a clear message instead of stalling the whole suite for
// minutes.
const HANG_CEILING_MS = 5 * BUDGET_MS;
const CARD_COUNT = 500;

test("moving 500 selected cards to another folder completes within budget", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", { timeout: 30_000 });

  const { destId, seedMs } = await page.evaluate(
    async ({ count, ceilingMs }) => {
      const store = (window as unknown as {
        __collectionStore: {
          createFolder: (name: string) => Promise<{ id: string }>;
          commitAdd: (
            folderId: string,
            items: unknown[],
          ) => Promise<unknown>;
        };
      }).__collectionStore;

      const source = await store.createFolder("Perf Source");
      const dest = await store.createFolder("Perf Dest");

      const items = Array.from({ length: count }, (_, i) => ({
        scryfallId: `perf-scry-${i}`,
        illustrationId: `perf-illus-${i}`,
        oracleId: `perf-oracle-${i}`,
        name: `Perf Card ${i}`,
        setCode: "tst",
        setName: "Test Set",
        collectorNumber: String(i),
        quantity: 1,
        condition: "NM",
        cmc: 1,
        colors: ["U"],
        rarity: "common",
      }));

      const t0 = performance.now();
      const outcome = await Promise.race([
        store.commitAdd(source.id, items).then(() => "done" as const),
        new Promise<"timed-out">((resolve) =>
          setTimeout(() => resolve("timed-out"), ceilingMs)
        ),
      ]);
      const seedMs = performance.now() - t0;

      return { sourceId: source.id, destId: dest.id, seedMs, outcome };
    },
    { count: CARD_COUNT, ceilingMs: HANG_CEILING_MS },
  );

  expect(
    seedMs,
    `seeding ${CARD_COUNT} cards into the collection took ${seedMs.toFixed(0)}ms ` +
      `(outcome: ${seedMs >= HANG_CEILING_MS ? "did not complete" : "completed"}), ` +
      `budget is ${BUDGET_MS}ms`,
  ).toBeLessThan(BUDGET_MS);

  await page.click(".nav-btn[data-view='collection']");
  await page.locator(".folder-item", { hasText: "Perf Source" }).click();
  await expect(page.locator(".card-item")).toHaveCount(CARD_COUNT);

  await page.click("#btn-edit-mode");
  await page.click("#btn-toggle-select-all");
  await expect(page.locator("#selection-count")).toHaveText(`${CARD_COUNT} selected`);

  await page.click("#btn-move-selected");
  await page.selectOption("#move-folder-select", destId);
  await page.click("#btn-move-confirm");
  await page.waitForSelector("#merge-confirm");

  const t0 = Date.now();
  await page.click("#merge-confirm");
  let moveCompleted = true;
  try {
    await page.waitForSelector(".toast", { timeout: HANG_CEILING_MS });
  } catch {
    moveCompleted = false;
  }
  const moveMs = Date.now() - t0;

  expect(
    moveMs,
    `moving ${CARD_COUNT} cards took ${moveMs}ms ` +
      `(outcome: ${moveCompleted ? "completed" : "did not complete"}), ` +
      `budget is ${BUDGET_MS}ms`,
  ).toBeLessThan(BUDGET_MS);

  await expect(page.locator(".card-item")).toHaveCount(0);
  await page.click("#btn-back");
  await expect(page.locator(".folder-item", { hasText: "Perf Dest" })).toContainText(
    `${CARD_COUNT} cards`,
  );
});
