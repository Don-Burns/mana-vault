import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";

// End-to-end regression test for the "Import CSV" button in the staging
// review overlay: it opens a dialog (csv-import-dialog.ts) offering either a
// file picker or a paste-CSV-data textarea, which then feeds
// importToStagingListFromCsv (staging.ts). Deno unit tests in
// tests/staging_test.ts already cover importToStagingListFromCsv() in
// isolation against a fixture metadata blob; this exercises the actual
// dialog + real card-metadata lookup end to end.

test("importing a CSV file stages the matching card", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", {
    timeout: 30_000,
  });

  // Fake camera auto-capture stages "Temple of Mystery" (see
  // scanner-match.spec.ts). Read its set/collector number off the staged
  // card so the CSV row below refers to a printing the real metadata db
  // actually contains.
  await expect(page.locator("#match-splash-name")).toHaveText(
    "Temple of Mystery",
    {
      timeout: 30_000,
    },
  );
  await page.click("#btn-staging");
  const setLine = await page.locator(".staged-card .card-set").first()
    .textContent();
  const [setCode, collectorNumber] = setLine!.trim().split(/\s+#/);

  // Start from a clean staging list so the assertion below is exact.
  await page.click("#btn-clear-staging");
  await page.click("#btn-staging");
  await expect(page.locator(".staging-empty")).toBeVisible();

  const csv = `name,set_code,collector_number,quantity
Temple of Mystery,${setCode.toLowerCase()},${collectorNumber},2
`;

  await page.click("#btn-import-csv");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#btn-csv-choose-file"),
  ]);
  await chooser.setFiles({
    name: "import.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });

  await expect(page.locator(".staged-card")).toHaveCount(1);
  await expect(page.locator(".staged-card .card-qty")).toHaveText("\u00d72");
});

test("pasting CSV data stages the matching card", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", {
    timeout: 30_000,
  });
  await expect(page.locator("#match-splash-name")).toHaveText(
    "Temple of Mystery",
    {
      timeout: 30_000,
    },
  );
  await page.click("#btn-staging");
  const setLine = await page.locator(".staged-card .card-set").first()
    .textContent();
  const [setCode, collectorNumber] = setLine!.trim().split(/\s+#/);

  await page.click("#btn-clear-staging");
  await page.click("#btn-staging");
  await expect(page.locator(".staging-empty")).toBeVisible();

  const csv = `name,set_code,collector_number,quantity
Temple of Mystery,${setCode.toLowerCase()},${collectorNumber},3`;

  await page.click("#btn-import-csv");
  await page.fill("#csv-import-textarea", csv);
  await page.click("#btn-csv-import-submit");

  await expect(page.locator(".staged-card")).toHaveCount(1);
  await expect(page.locator(".staged-card .card-qty")).toHaveText("\u00d73");
});

test("importing a CSV with an unknown card shows an error toast", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", {
    timeout: 30_000,
  });
  await expect(page.locator("#match-splash-name")).toHaveText(
    "Temple of Mystery",
    {
      timeout: 30_000,
    },
  );

  await page.click("#btn-staging");
  await page.click("#btn-clear-staging");
  await page.click("#btn-staging");

  const csv = `name,set,collector_number,quantity\nNot A Real Card,xyz,1,1`;
  await page.click("#btn-import-csv");
  await page.fill("#csv-import-textarea", csv);
  await page.click("#btn-csv-import-submit");

  await expect(page.locator(".toast", { hasText: "CSV import failed" }))
    .toBeVisible();
});

test("closing the CSV import dialog cancels without staging anything", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#capture-btn:not([disabled])", {
    timeout: 30_000,
  });
  await expect(page.locator("#match-splash-name")).toHaveText(
    "Temple of Mystery",
    {
      timeout: 30_000,
    },
  );

  await page.click("#btn-staging");
  await page.click("#btn-clear-staging");
  await page.click("#btn-staging");

  await page.click("#btn-import-csv");
  await expect(page.locator(".csv-import-dialog")).toBeVisible();
  await page.click("#btn-close-csv-import");

  await expect(page.locator(".csv-import-dialog")).toHaveCount(0);
  await expect(page.locator(".staging-empty")).toBeVisible();
});
