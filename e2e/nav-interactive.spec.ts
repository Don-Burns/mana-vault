import { test, expect } from "@playwright/test";

// Regression test for the "page loads but is completely frozen" symptom
// reported this session: nav buttons render (they're static markup in
// index.html) but clicking them does nothing, because `new App()` — which
// wires up the click handlers — never runs while boot() is stuck waiting on
// a service worker that never activates.

test("nav buttons switch between scanner and collection views", async ({ page }) => {
  await page.goto("/");
  // Wait for the app to actually finish booting (new App() wires up the nav
  // click handlers) rather than just for static markup, which is present
  // immediately and would otherwise mask a hang like the one fixed this
  // session.
  await page.waitForSelector("#capture-btn:not([disabled])", { timeout: 30_000 });
  await expect(page.locator(".nav-btn[data-view='scanner']")).toHaveClass(/active/);

  await page.click(".nav-btn[data-view='collection']");
  await expect(page.locator(".nav-btn[data-view='collection']")).toHaveClass(/active/);
  await expect(page.locator(".nav-btn[data-view='scanner']")).not.toHaveClass(/active/);
  await expect(page.locator("#folder-list")).toBeVisible();

  await page.click(".nav-btn[data-view='scanner']");
  await expect(page.locator(".nav-btn[data-view='scanner']")).toHaveClass(/active/);
  await expect(page.locator("#camera-video")).toBeVisible();
});
