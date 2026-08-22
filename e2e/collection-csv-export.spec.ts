import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// End-to-end regression test for the CSV export flow (as opposed to the
// binary .db export/import covered by collection-export-import.spec.ts).
// Drives the whole UI flow the way a user actually would: add a card,
// open the CSV export dialog, then export to a file and to the clipboard,
// checking both contain the expected row.

test("export CSV to file and to clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", { timeout: 30_000 });

  // Fake camera auto-capture stages the fixture card (see scanner-match.spec.ts).
  await expect(page.locator("#match-splash-name")).toHaveText("Temple of Mystery", {
    timeout: 30_000,
  });

  // Review staged card and confirm add to the default "Unsorted" folder.
  await page.click("#btn-staging");
  await page.click("#btn-confirm-staging");
  await page.click("#merge-confirm");

  // #btn-export-csv lives on the folder list, not the folder detail view.
  await page.click(".nav-btn[data-view='collection']");
  await page.click("#btn-export-csv");

  // Whole collection, download to file.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btn-csv-export-file"),
  ]);
  const csvPath = await download.path();
  expect(csvPath).toBeTruthy();
  const csv = readFileSync(csvPath!, "utf-8");
  expect(csv).toContain("Temple of Mystery");

  // Whole collection, copy to clipboard.
  await page.click("#btn-export-csv");
  await page.click("#btn-csv-export-clipboard");
  await expect(page.locator(".toast", { hasText: "Copied CSV to clipboard." })).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain("Temple of Mystery");
});
