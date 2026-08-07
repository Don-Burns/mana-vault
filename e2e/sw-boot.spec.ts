import { test, expect } from "@playwright/test";

// Regression test for the exact bug fixed in this session: the service
// worker's precache list deduped raw URL strings, but APP_SHELL entries were
// absolute (base-prefixed) while the build manifest's entries were bare
// relative filenames — both resolved to the same URL but weren't caught as
// duplicates, so `cache.addAll()` threw `InvalidStateError` on install. That
// left the SW never activating, which meant `navigator.serviceWorker.ready`
// in src/main.ts never resolved, and the app hung forever before
// `new App()` ever ran (frozen UI, no console errors, no camera feed).
//
// This only reproduces under a non-root base path (see "subpath" project in
// playwright.config.ts) — at "/" the two URL forms happen to collide anyway
// so this class of bug would silently pass.

test("service worker installs, activates, and achieves cross-origin isolation", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/");
  // main.ts forces one reload if the page isn't already cross-origin
  // isolated, to pick up the SW's injected COOP/COEP headers (GitHub Pages
  // can't set these itself). The local preview server sends those headers
  // directly (see vite.config.ts server.headers), so isolation may already
  // be true on the very first load without needing that reload — either way
  // the app must end up isolated with an active, controlling SW.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 20_000,
  });
  const isolated = await page.evaluate(() => self.crossOriginIsolated);
  expect(isolated).toBe(true);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
