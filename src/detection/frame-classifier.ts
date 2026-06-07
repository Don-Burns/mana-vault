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
 * Classify the frame type by analyzing border regions of the card.
 *
 * Strategy:
 * 1. Sample pixels along the border edges
 * 2. Modern frames have thin, relatively uniform colored borders
 * 3. Old frames have thick, textured borders
 * 4. Borderless cards have image content right at the edges
 *
 * This operates on raw pixel data from a perspective-corrected card image.
 */
export function classifyFrameType(
  imageData: ImageData,
): FrameType {
  const { width, height, data } = imageData;

  // Sample the border region (outermost 5% of the card)
  const borderWidth = Math.round(width * 0.05);
  const borderHeight = Math.round(height * 0.05);

  // Check if there's a distinct border by comparing variance of edge pixels
  // vs inner pixels
  const edgeColors = sampleEdge(data, width, height, borderWidth, borderHeight);
  const innerColors = sampleInner(data, width, height, borderWidth, borderHeight);

  const edgeVariance = colorVariance(edgeColors);
  const innerVariance = colorVariance(innerColors);

  // High edge variance → likely borderless (image content at edges)
  if (edgeVariance > 2000) {
    return "borderless";
  }

  // Check border thickness by looking at how far the uniform border extends
  const borderThickness = measureBorderThickness(data, width, height);
  const thicknessRatio = borderThickness / width;

  // Old frames have thicker borders (>7% of card width)
  if (thicknessRatio > 0.07) {
    return "old";
  }

  // Check if the edge is very dark (black border = modern) vs colored (old)
  const avgEdgeBrightness = edgeColors.reduce((sum, c) => sum + c.r + c.g + c.b, 0) /
    (edgeColors.length * 3);

  if (avgEdgeBrightness < 30) {
    // Very dark border — modern black-bordered card
    return "modern";
  }

  // Default to modern (most common in current era)
  // The edge variance being low + thin border = modern
  if (edgeVariance < innerVariance * 0.3) {
    return "modern";
  }

  return "modern";
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

function sampleEdge(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  borderW: number,
  borderH: number,
): RGB[] {
  const colors: RGB[] = [];
  const step = 4; // Sample every 4th pixel for speed

  // Top edge
  for (let x = 0; x < width; x += step) {
    for (let y = 0; y < borderH; y += step) {
      const idx = (y * width + x) * 4;
      colors.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
    }
  }

  // Left edge
  for (let y = borderH; y < height - borderH; y += step) {
    for (let x = 0; x < borderW; x += step) {
      const idx = (y * width + x) * 4;
      colors.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
    }
  }

  // Right edge
  for (let y = borderH; y < height - borderH; y += step) {
    for (let x = width - borderW; x < width; x += step) {
      const idx = (y * width + x) * 4;
      colors.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
    }
  }

  // Bottom edge
  for (let x = 0; x < width; x += step) {
    for (let y = height - borderH; y < height; y += step) {
      const idx = (y * width + x) * 4;
      colors.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
    }
  }

  return colors;
}

function sampleInner(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  borderW: number,
  borderH: number,
): RGB[] {
  const colors: RGB[] = [];
  const step = 8;

  // Sample the inner area (art region)
  const startX = borderW * 2;
  const endX = width - borderW * 2;
  const startY = borderH * 3; // Skip title bar area
  const endY = Math.round(height * 0.55);

  for (let y = startY; y < endY; y += step) {
    for (let x = startX; x < endX; x += step) {
      const idx = (y * width + x) * 4;
      colors.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
    }
  }

  return colors;
}

function colorVariance(colors: RGB[]): number {
  if (colors.length === 0) return 0;

  const n = colors.length;
  const avgR = colors.reduce((s, c) => s + c.r, 0) / n;
  const avgG = colors.reduce((s, c) => s + c.g, 0) / n;
  const avgB = colors.reduce((s, c) => s + c.b, 0) / n;

  let variance = 0;
  for (const c of colors) {
    variance += (c.r - avgR) ** 2 + (c.g - avgG) ** 2 + (c.b - avgB) ** 2;
  }

  return variance / n;
}

/**
 * Measure how thick the border is by scanning inward from the left edge
 * until the color changes significantly.
 */
function measureBorderThickness(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  // Sample at the middle of the card height
  const y = Math.round(height * 0.4);
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
