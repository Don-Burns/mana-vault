/// <reference lib="deno.ns" />

/**
 * Download Art Crop Images from Scryfall
 *
 * Downloads the art_crop image for each unique illustration_id.
 * Rate-limited and resumable — skips already-downloaded images.
 *
 * Usage: deno task db:art
 *
 * Note: This downloads ~50k images and can take several hours.
 * The download is resumable — run again to pick up where you left off.
 */

import {
  BULK_DIR,
  type CardData,
  CROP_ART_DIR,
  ensureDataDirs,
  FULL_ART_DIR,
  RATE_LIMIT_MS,
} from "./config.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const CARDS_FILE = join(BULK_DIR, "cards.json");
const CROP_PROGRESS_FILE = join(CROP_ART_DIR, ".progress.json");
const FULL_ART_PROGRESS_FILE = join(FULL_ART_DIR, ".progress.json");
const BATCH_SIZE = 100; // Save progress every N downloads

interface Progress {
  completed: string[]; // illustration_ids already downloaded
  failed: string[]; // illustration_ids that failed (for retry)
  lastUpdated: string;
}

async function main() {
  await ensureDataDirs();

  // Load card data
  console.log("Loading card data...");
  let cards: CardData[];
  try {
    cards = JSON.parse(await Deno.readTextFile(CARDS_FILE));
  } catch {
    console.error("Card data not found. Run 'deno task db:download' first.");
    Deno.exit(1);
    return; // unreachable but satisfies TS
  }
  await downloadFiles(
    cards,
    CROP_PROGRESS_FILE,
    CROP_ART_DIR,
    (card) => card.image_uri_art_crop,
  );
  await downloadFiles(
    cards,
    FULL_ART_PROGRESS_FILE,
    FULL_ART_DIR,
    (card) => card.image_uri_art_full,
  );

  console.log("Run 'deno task db:build' next to generate the hash database.");
}

async function downloadFiles(
  cards: CardData[],
  progressFile: string,
  artDir: string,
  getUrl: (card: CardData) => string,
) {
  // Deduplicate by illustration_id — we only need one art per unique illustration
  const illustrationMap = new Map<string, string>(); // illustration_id → art URL
  for (const card of cards) {
    if (!illustrationMap.has(card.illustration_id)) {
      illustrationMap.set(card.illustration_id, getUrl(card));
    }
  }

  console.log(`Unique illustrations to download: ${illustrationMap.size}`);

  // Load progress
  let progress: Progress;
  try {
    progress = JSON.parse(await Deno.readTextFile(progressFile));
    console.log(
      `Resuming: ${progress.completed.length} already downloaded, ${progress.failed.length} previously failed`,
    );
  } catch {
    progress = {
      completed: [],
      failed: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  const completedSet = new Set(progress.completed);
  const toDownload: [string, string][] = [];

  for (const [illustrationId, url] of illustrationMap) {
    if (!completedSet.has(illustrationId)) {
      toDownload.push([illustrationId, url]);
    }
  }

  console.log(`Remaining to download: ${toDownload.length}`);

  if (toDownload.length === 0) {
    console.log("All art images already downloaded!");
    return;
  }

  // Download loop
  let downloaded = 0;
  let failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < toDownload.length; i++) {
    const [illustrationId, url] = toDownload[i];
    const filename = `${illustrationId}.jpg`;
    const filepath = join(artDir, filename);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = new Uint8Array(await response.arrayBuffer());
      await Deno.writeFile(filepath, data);

      progress.completed.push(illustrationId);
      downloaded++;
    } catch (err) {
      progress.failed.push(illustrationId);
      failed++;
      console.error(`  Failed ${illustrationId}: ${(err as Error).message}`);
    }

    // Rate limiting
    await sleep(RATE_LIMIT_MS);

    // Progress logging
    if ((i + 1) % BATCH_SIZE === 0 || i === toDownload.length - 1) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = downloaded / elapsed;
      const remaining = toDownload.length - (i + 1);
      const eta = remaining / rate;

      console.log(
        `  [${i + 1}/${toDownload.length}] ` +
          `Downloaded: ${downloaded}, Failed: ${failed}, ` +
          `Rate: ${rate.toFixed(1)}/s, ETA: ${formatTime(eta)}`,
      );

      // Save progress
      progress.lastUpdated = new Date().toISOString();
      await Deno.writeTextFile(progressFile, JSON.stringify(progress));
    }
  }

  // Final progress save
  progress.lastUpdated = new Date().toISOString();
  await Deno.writeTextFile(progressFile, JSON.stringify(progress));

  const totalTime = (Date.now() - startTime) / 1000;
  console.log("");
  console.log(`Done!`);
  console.log(`  Downloaded: ${downloaded}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total time: ${formatTime(totalTime)}`);
  console.log("");

  if (failed > 0) {
    console.log(`${failed} downloads failed. Run again to retry.`);
    // Clear failed list so they'll be retried next run
    progress.failed = [];
    await Deno.writeTextFile(progressFile, JSON.stringify(progress));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

main().catch((err) => {
  console.error("Error:", err.message);
  Deno.exit(1);
});
