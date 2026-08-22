/// <reference lib="deno.ns" />

import { assert, assertEquals } from "@std/assert";
import {
  computeTrackingRect,
  translateQuad,
  translateQuads,
} from "../src/ui/tracking-rect.ts";

Deno.test("computeTrackingRect returns null when there's no hint", () => {
  assertEquals(computeTrackingRect(null, 1280, 720), null);
  assertEquals(computeTrackingRect([], 1280, 720), null);
});

Deno.test("computeTrackingRect pads the bounding box by the margin", () => {
  const corners: [number, number][] = [
    [100, 100],
    [300, 100],
    [300, 500],
    [100, 500],
  ];
  // width=200, height=400; margin 0.2 -> pad 40 / 80
  const rect = computeTrackingRect(corners, 1280, 720, 0.2);

  assertEquals(rect, { x: 60, y: 20, width: 280, height: 560 });
});

Deno.test("computeTrackingRect clamps to the frame bounds", () => {
  const corners: [number, number][] = [
    [10, 10],
    [50, 10],
    [50, 50],
    [10, 50],
  ];
  const rect = computeTrackingRect(corners, 1280, 720, 1); // pad = box size

  assert(rect);
  assertEquals(rect.x, 0, "clamped to left edge");
  assertEquals(rect.y, 0, "clamped to top edge");
});

Deno.test("computeTrackingRect clamps against the far edges too", () => {
  const corners: [number, number][] = [
    [1200, 650],
    [1270, 650],
    [1270, 710],
    [1200, 710],
  ];
  const rect = computeTrackingRect(corners, 1280, 720, 1);

  assert(rect);
  assertEquals(rect.x + rect.width, 1280, "clamped to right edge");
  assertEquals(rect.y + rect.height, 720, "clamped to bottom edge");
});

Deno.test("computeTrackingRect uses the default margin constant when omitted", () => {
  const corners: [number, number][] = [
    [100, 100],
    [300, 100],
    [300, 500],
    [100, 500],
  ];
  const withDefault = computeTrackingRect(corners, 1280, 720);
  const withExplicit = computeTrackingRect(corners, 1280, 720, 0.2);

  assertEquals(withDefault, withExplicit);
});

Deno.test("translateQuad shifts every point by (dx, dy)", () => {
  const quad: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assertEquals(translateQuad(quad, 5, -3), [
    [5, -3],
    [15, -3],
    [15, 7],
    [5, 7],
  ]);
});

Deno.test("translateQuads shifts every quad in the list", () => {
  const quads: [number, number][][] = [
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    [[10, 10], [11, 10], [11, 11], [10, 11]],
  ];
  assertEquals(translateQuads(quads, 2, 3), [
    [[2, 3], [3, 3], [3, 4], [2, 4]],
    [[12, 13], [13, 13], [13, 14], [12, 14]],
  ]);
});
