/// <reference lib="deno.ns" />

/**
 * Shared configuration for database build tools.
 */

import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

/** Base directory for all downloaded/generated data */
export const DATA_DIR = join(Deno.cwd(), "data");

/** Directory for raw Scryfall bulk data */
export const BULK_DIR = join(DATA_DIR, "bulk");

/** Directory for downloaded art crop images */
export const CROP_ART_DIR = join(DATA_DIR, "crop_art");

/** Directory for full art images */
export const FULL_ART_DIR = join(DATA_DIR, "full_art");

/** Directory for generated hash database files */
export const OUTPUT_DIR = join(DATA_DIR, "output");

/** Scryfall API base URL */
export const SCRYFALL_API = "https://api.scryfall.com";

/** Rate limit delay between Scryfall API requests (ms) */
export const RATE_LIMIT_MS = 75; // Scryfall asks for 50-100ms between requests

/** Card image dimensions for hash computation */
export const HASH_IMAGE_SIZE = 32; // Resize art to 32x32 before hashing

/** Fields we extract from each card in bulk data */
export interface CardData {
  id: string; // Scryfall card ID (unique per printing)
  oracle_id: string; // Logical card identity
  illustration_id: string; // Shared across reprints with same art
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  lang: string;
  image_uri_art_crop: string; // art_crop image URL
  image_uri_art_full: string; // full art image URL
  released_at: string;
}

/** Structure for the metadata JSON */
export interface CardMetadata {
  illustrations: Record<string, IllustrationEntry>;
}

export interface IllustrationEntry {
  oracle_id: string;
  name: string; // Primary English name
  printings: PrintingInfo[];
}

export interface PrintingInfo {
  id: string; // Scryfall card ID
  set: string;
  set_name: string;
  collector_number: string;
  lang: string;
  released_at: string;
}

/** Ensure all data directories exist */
export async function ensureDataDirs(): Promise<void> {
  await Deno.mkdir(BULK_DIR, { recursive: true });
  await Deno.mkdir(CROP_ART_DIR, { recursive: true });
  await Deno.mkdir(FULL_ART_DIR, { recursive: true });
  await Deno.mkdir(OUTPUT_DIR, { recursive: true });
}
