import { expect, type Page, test } from "@playwright/test";

// "Mystical Tutor" is a real card in the shipped metadata.json with 6
// distinct illustration IDs (different arts across reprints), each with
// exactly one printing — dmr/mir/ss1/ema/sld/tle. It's the exact case the
// printing-picker feature exists for: search must dedupe to one row, and
// the picker must offer every printing across all those illustration IDs.

/**
 * Opens the manual-add search in staging review, searches "Mystical Tutor",
 * clicks the (single, deduped) result, waits for the printing picker, and
 * picks the option matching `setName`. Leaves the staging overlay open with
 * the new staged card visible. Opens the staging overlay itself first if
 * it isn't already open.
 */
async function addMysticalTutorToStaging(page: Page, setName: string) {
  if (!(await page.locator(".staging-review").isVisible())) {
    await page.click("#btn-staging");
  }
  await page.fill("#staging-search-input", "Mystical Tutor");
  await expect(page.locator(".staging-search-result")).toHaveCount(1);
  await page.click(".staging-search-result");

  await expect(page.locator(".printing-picker-overlay")).toBeVisible();
  await page
    .locator(".printing-option", { hasText: setName })
    .click();
  await expect(page.locator(".printing-picker-overlay")).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", {
    timeout: 30_000,
  });
});

test("manual-add search dedupes multiple printings of the same card into one result", async ({ page }) => {
  await page.click("#btn-staging");
  await page.fill("#staging-search-input", "Mystical Tutor");

  const results = page.locator(".staging-search-result");
  await expect(results).toHaveCount(1);
  await expect(results).toHaveText("Mystical Tutor");
});

test("selecting a search result opens the printing picker with every printing", async ({ page }) => {
  await page.click("#btn-staging");
  await page.fill("#staging-search-input", "Mystical Tutor");
  await page.click(".staging-search-result");

  const options = page.locator(".printing-option");
  await expect(options).toHaveCount(6);
  await expect(page.locator(".printing-option-thumb").first()).toBeVisible();
});

test("picking a printing adds that exact version to staging", async ({ page }) => {
  await addMysticalTutorToStaging(page, "Mirage");

  const staged = page.locator(".staged-card", { hasText: "Mystical Tutor" });
  await expect(staged).toBeVisible();
  await expect(staged.locator(".card-set")).toHaveText("MIR #80");
});

test("the Printing button on a staged card reopens the picker and swaps the version", async ({ page }) => {
  await addMysticalTutorToStaging(page, "Mirage");

  const staged = page.locator(".staged-card", { hasText: "Mystical Tutor" });
  await staged.locator(".staged-change-printing").click();

  await expect(page.locator(".printing-picker-overlay")).toBeVisible();
  await expect(
    page.locator(".printing-option-current", { hasText: "Mirage" }),
  ).toBeVisible();

  await page.locator(".printing-option", { hasText: "Dominaria Remastered" })
    .click();

  await expect(
    page.locator(".staged-card", { hasText: "Mystical Tutor" }).locator(
      ".card-set",
    ),
  )
    .toHaveText("DMR #421");
});

test("the Printing button in collection edit mode changes an existing entry's printing", async ({ page }) => {
  await addMysticalTutorToStaging(page, "Mirage");

  await page.click("#btn-confirm-staging");
  await page.click("#merge-confirm");

  await page.click(".nav-btn[data-view='collection']");
  await page.locator(".folder-item", { hasText: "Unsorted" }).click();
  await page.click("#btn-edit-mode");

  const cardItem = page.locator(".card-item", { hasText: "Mystical Tutor" });
  await expect(cardItem).toBeVisible();
  await cardItem.locator("[data-action='change-printing']").click();

  await expect(page.locator(".printing-picker-overlay")).toBeVisible();
  await page.locator(".printing-option", { hasText: "Dominaria Remastered" })
    .click();

  await expect(cardItem.locator(".card-set")).toHaveText("DMR #421");
});
