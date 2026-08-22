/**
 * Frame-to-frame ROI tracking geometry.
 *
 * Once a card has been located, the next frame's search can be narrowed to a
 * region around where it was last seen instead of scanning the whole camera
 * frame — cheaper for the detector, and cheaper still because a smaller
 * `ImageData` crosses the worker's `postMessage` boundary. This module is
 * the pure geometry behind that: computing the crop rect from the last known
 * corners, and translating detection results (found within the crop) back
 * into full-frame coordinates.
 *
 * Deliberately has no dependency on the camera, detector, or OpenCV — the
 * caller (`scanner-view.ts`) owns capturing the (possibly cropped) frame and
 * translating results; this module only does the coordinate math, so it can
 * be unit tested without a browser.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Fraction of the last known bounding box's width/height added as padding on
 * each side when computing the next frame's search region.
 *
 * A starting point, not a tuned constant — normal hand movement/jitter
 * between frames (at the ~20fps target in `src/camera/capture.ts`) needs
 * enough padding that the card doesn't drift outside the crop and force a
 * fallback to full-frame search, but too much padding erodes the whole
 * point of cropping. Adjust here and re-run `e2e/scanner-performance.spec.ts`
 * to see the effect on real scan latency.
 */
export const TRACKING_MARGIN = 0.2;

/**
 * Compute the region to search for a card in the next frame, given where it
 * was last found.
 *
 * Returns `null` when there's no hint (`lastCorners` is `null`, e.g. no card
 * was found last frame) — the caller should fall back to a full-frame
 * search in that case, which also naturally recovers from a stale/bad hint
 * since losing the card resets tracking.
 */
export function computeTrackingRect(
  lastCorners: [number, number][] | null,
  frameWidth: number,
  frameHeight: number,
  margin: number = TRACKING_MARGIN,
): Rect | null {
  if (!lastCorners || lastCorners.length === 0) return null;

  const xs = lastCorners.map((p) => p[0]);
  const ys = lastCorners.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const padX = (maxX - minX) * margin;
  const padY = (maxY - minY) * margin;

  const x0 = Math.max(0, Math.floor(minX - padX));
  const y0 = Math.max(0, Math.floor(minY - padY));
  const x1 = Math.min(frameWidth, Math.ceil(maxX + padX));
  const y1 = Math.min(frameHeight, Math.ceil(maxY + padY));

  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;

  return { x: x0, y: y0, width, height };
}

/** Translate a single quad's points by `(dx, dy)`. */
export function translateQuad(
  quad: [number, number][],
  dx: number,
  dy: number,
): [number, number][] {
  return quad.map(([x, y]) => [x + dx, y + dy]);
}

/** Translate every quad in a list by `(dx, dy)`. */
export function translateQuads(
  quads: [number, number][][],
  dx: number,
  dy: number,
): [number, number][][] {
  return quads.map((q) => translateQuad(q, dx, dy));
}
