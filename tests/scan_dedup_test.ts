/// <reference lib="deno.ns" />

import { assert, assertFalse } from "@std/assert";
import { ScanDedupTracker } from "../src/ui/scan-dedup.ts";

Deno.test("allows the first scan when nothing is staged yet", () => {
  const dedup = new ScanDedupTracker(500);
  assertFalse(dedup.shouldSkip("card-a", undefined));
});

Deno.test("skips the same card with no gap in detection", () => {
  const dedup = new ScanDedupTracker(500);
  assert(dedup.shouldSkip("card-a", "card-a"));
});

Deno.test("allows a different card even with no gap", () => {
  const dedup = new ScanDedupTracker(500);
  assertFalse(dedup.shouldSkip("card-b", "card-a"));
});

Deno.test("allows the same card again once the view has been empty long enough", () => {
  const dedup = new ScanDedupTracker(500);
  dedup.onNotFound(0);
  dedup.onNotFound(500); // 500ms with no card in view
  assertFalse(dedup.shouldSkip("card-a", "card-a"));
});

Deno.test("still skips just under the gap threshold (boundary)", () => {
  const dedup = new ScanDedupTracker(500);
  dedup.onNotFound(0);
  dedup.onNotFound(499);
  assert(dedup.shouldSkip("card-a", "card-a"));
});

Deno.test("a found blip resets the gap timer (flicker doesn't accumulate)", () => {
  const dedup = new ScanDedupTracker(500);
  dedup.onNotFound(0);
  dedup.onNotFound(400); // 400ms empty so far
  dedup.onFound(); // card briefly re-detected, timer resets
  dedup.onNotFound(600); // only 200ms since the reset
  assert(dedup.shouldSkip("card-a", "card-a"));
});

Deno.test("recordCapture consumes the gap so the next identical card dedupes again", () => {
  const dedup = new ScanDedupTracker(500);
  dedup.onNotFound(0);
  dedup.onNotFound(500);
  assertFalse(dedup.shouldSkip("card-a", "card-a"));

  dedup.recordCapture();
  assert(dedup.shouldSkip("card-a", "card-a"));
});
