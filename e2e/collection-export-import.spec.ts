import { test, expect } from "@playwright/test";

// End-to-end regression test for the DB export/import flow, exercised in a
// real browser against the actual WASM/OPFS sqlite-wasm driver (the Deno
// unit tests in tests/store_test.ts exercise the same snapshot/restore
// logic against an in-memory db, which never touches OPFS). Drives the
// whole UI flow the way a user actually would: add a
// card, export the collection to a .db file, delete the card, then
// re-import that file and confirm the card comes back — without a page
// reload, switching tabs a few times along the way (see below).
//
// #btn-export/#btn-import only exist in the folder-list header (hidden
// while a folder's detail view is open — see showFolderDetail() in
// collection-view.ts), so the test must go back to the folder list before
// using them.

test("export the collection, delete a card, then re-import restores it", async ({ page }) => {
  const dialogMessages: string[] = [];
  page.on("dialog", (dialog) => dialogMessages.push(dialog.message()));

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

  // Verify it landed in the collection.
  await page.click(".nav-btn[data-view='collection']");
  await page.locator(".folder-item", { hasText: "Unsorted" }).click();
  await expect(page.locator(".card-item", { hasText: "Temple of Mystery" })).toBeVisible();

  // Switch tabs a couple of times before continuing: CollectionView.init()
  // runs on every switch back to this tab (see App.showView() in main.ts),
  // and used to re-attach all its click listeners each time too, so
  // clicking Import below would fire the handler multiple times
  // concurrently and leave the folder list showing stale data until a
  // full page reload.
  await page.click(".nav-btn[data-view='scanner']");
  await page.click(".nav-btn[data-view='collection']");
  await page.click(".nav-btn[data-view='scanner']");
  await page.click(".nav-btn[data-view='collection']");

  // Export the collection as a .db file (export button lives on the folder
  // list, not the folder detail view).
  await page.click("#btn-back");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btn-export"),
  ]);
  const dbPath = await download.path();
  expect(dbPath).toBeTruthy();

  // Delete the card from the UI.
  await page.locator(".folder-item", { hasText: "Unsorted" }).click();
  await page.click("#btn-edit-mode");
  page.once("dialog", (dialog) => dialog.accept());
  await page.click(".card-item [data-action='delete']");
  await expect(page.locator(".empty-state")).toBeVisible();

  // Re-import the exported db (import button also lives on the folder list).
  await page.click("#btn-back");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#btn-import"),
  ]);
  const dialogPromise = page.waitForEvent("dialog");
  await chooser.setFiles(dbPath!);
  // Wait for the "Imported database: ..." success alert so the import (and
  // the folder list re-render that follows it) has actually finished
  // before interacting with the page again.
  const dialog = await dialogPromise;
  await dialog.accept();

  // Card should be back in "Unsorted" — no page reload involved.
  await page.locator(".folder-item", { hasText: "Unsorted" }).click();
  await expect(page.locator(".card-item", { hasText: "Temple of Mystery" })).toBeVisible({
    timeout: 10_000,
  });

  // Exactly one "Imported database: ..." alert should have fired. More
  // than one means click handlers got double-registered by the tab
  // switching above.
  const importAlerts = dialogMessages.filter((m) => m.startsWith("Imported database:"));
  expect(importAlerts).toHaveLength(1);
});
