/**
 * Card Frame Layouts
 *
 * Where the art sits on a Magic card, as a fraction of the card's dimensions,
 * for each of the frame families the pipeline crops.
 *
 * Frame types:
 * - modern: 2003+ standard frames (thin colored border)
 * - old: Pre-2003 frames (thick textured border)
 * - borderless: Full-art/borderless cards (art extends to edges)
 *
 * There is deliberately no classifier here. Detecting the frame type from the
 * image was tried and removed: it measured border thickness by scanning inward
 * from the left edge of the perspective-corrected card, which fails badly in
 * practice. A card occupying a small part of the camera frame gets upscaled
 * several times over by the warp, smearing its border into a gradient and
 * contaminating the first column with background bleed, so the measurement
 * collapsed towards zero and reported normally-bordered cards as borderless.
 * Showcase and borderless layouts defeated it outright, since their art is not
 * where any of these rectangles say it is.
 *
 * The pipeline now crops all three layouts (plus the uncropped card, which is
 * what actually identifies irregular frames) and lets the hash matcher pick the
 * winner. See `extractCardCandidates` in ./pipeline.ts.
 */

export type FrameType = "modern" | "old" | "borderless";

/**
 * Art region coordinates as percentages of card dimensions.
 * Values are [left%, top%, right%, bottom%]
 */
export const ART_REGIONS: Record<FrameType, [number, number, number, number]> =
  {
    // Modern frame (2003+): art in upper portion, thin border
    modern: [0.057, 0.115, 0.943, 0.55],

    // Old border (pre-2003): thicker border, slightly different proportions
    old: [0.08, 0.13, 0.92, 0.53],

    // Borderless/full-art: art extends nearly to edges
    // Use a central region to avoid text overlay areas
    borderless: [0.03, 0.03, 0.97, 0.60],
  };
