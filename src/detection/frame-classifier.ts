/**
 * Frame Type Classifier
 *
 * Identifies MTG card frame types from a perspective-corrected card image.
 * Used to determine where the art region is located.
 *
 * Frame types:
 * - modern: 2003+ standard frames (thin colored border)
 * - old: Pre-2003 frames (thick textured border)
 * - borderless: Full-art/borderless cards (art extends to edges)
 */

export type FrameType = "modern" | "old" | "borderless";

/**
 * Art region coordinates as percentages of card dimensions.
 * Values are [left%, top%, right%, bottom%]
 */
export const ART_REGIONS: Record<FrameType, [number, number, number, number]> = {
  // Modern frame (2003+): art in upper portion, thin border
  modern: [0.057, 0.115, 0.943, 0.55],

  // Old border (pre-2003): thicker border, slightly different proportions
  old: [0.08, 0.13, 0.92, 0.53],

  // Borderless/full-art: art extends nearly to edges
  // Use a central region to avoid text overlay areas
  borderless: [0.03, 0.03, 0.97, 0.60],
};

/**
 * Classify the frame type by measuring border thickness.
 *
 * Strategy: scan inward from the left edge at several heights, measuring
 * how many pixels of uniform color exist before the content changes.
 * - Borderless: < 1% uniform border (art extends to edge)
 * - Modern: 1–7% uniform border (thin colored border, post-2003)
 * - Old: > 7% uniform border (thick textured border, pre-2003)
 */
export function classifyFrameType(
  imageData: ImageData,
): FrameType {
  const { width, height, data } = imageData;

  // Sample border thickness at multiple heights for robustness
  const thicknesses: number[] = [];
  for (const yPct of [0.3, 0.4, 0.5]) {
    thicknesses.push(measureBorderThickness(data, width, height, yPct));
  }

  // Use the median thickness to be robust against outliers
  thicknesses.sort((a, b) => a - b);
  const medianThickness = thicknesses[Math.floor(thicknesses.length / 2)];
  const thicknessRatio = medianThickness / width;

  if (thicknessRatio < 0.01) {
    return "borderless"; // < 1% = no visible border
  }

  if (thicknessRatio > 0.07) {
    return "old"; // > 7% = old thick border
  }

  return "modern"; // 1–7% = modern thin border
}

/**
 * Measure how thick the border is by scanning inward from the left edge
 * until the color changes significantly.
 */
function measureBorderThickness(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  yPct = 0.4,
): number {
  const y = Math.round(height * yPct);
  const startIdx = (y * width) * 4;

  // Get the border color from the first pixel
  const borderR = data[startIdx];
  const borderG = data[startIdx + 1];
  const borderB = data[startIdx + 2];

  // Scan inward until color difference exceeds threshold
  const threshold = 40; // Color difference threshold
  let thickness = 0;

  for (let x = 1; x < Math.round(width * 0.2); x++) {
    const idx = startIdx + x * 4;
    const dr = Math.abs(data[idx] - borderR);
    const dg = Math.abs(data[idx + 1] - borderG);
    const db = Math.abs(data[idx + 2] - borderB);
    const diff = dr + dg + db;

    if (diff > threshold) {
      thickness = x;
      break;
    }
  }

  return thickness;
}
