import { test, expect } from "@playwright/test";

// collection-view.ts's init() doesn't await its async folder-list render, so
// assertions must wait for ".folder-item" rather than assume it's present
// immediately after switching views.

test("creating a folder via the add-folder prompt renders it in the list", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", { timeout: 30_000 });
  await page.click(".nav-btn[data-view='collection']");

  const folderName = `E2E Folder ${Date.now()}`;
  page.once("dialog", (dialog) => dialog.accept(folderName));
  await page.click("#btn-add-folder");

  await expect(page.locator(".folder-item", { hasText: folderName })).toBeVisible();
});
