/// <reference lib="deno.ns" />

/**
 * Download Scryfall Bulk Data
 *
 * Downloads the default_cards bulk data file from Scryfall and extracts
 * the relevant fields for our hash database.
 *
 * Usage: deno task db:download
 *
 * Scryfall bulk data docs: https://scryfall.com/docs/api/bulk-data
 */

import {
  BULK_DIR,
  type CardData,
  ensureDataDirs,
  SCRYFALL_API,
} from "./config.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const BULK_DATA_URL = `${SCRYFALL_API}/bulk-data`;
const CARDS_OUTPUT_FILE = join(BULK_DIR, "cards.json");
const PROGRESS_INTERVAL = 10000; // Log progress every N cards

async function main() {
  await ensureDataDirs();

  console.log("Fetching bulk data catalog from Scryfall...");
  const catalogRes = await fetch(BULK_DATA_URL);
  if (!catalogRes.ok) {
    throw new Error(`Failed to fetch bulk data catalog: ${catalogRes.status}`);
  }

  const catalog = await catalogRes.json();
  const defaultCards = catalog.data.find(
    // (d: any) => d.type === "default_cards",
    (d: any) => d.type === "unique_artwork",
  );

  if (!defaultCards) {
    throw new Error("Could not find 'default_cards' in bulk data catalog");
  }

  console.log(`Bulk data info:`);
  console.log(`  Type: ${defaultCards.type}`);
  console.log(`  Updated: ${defaultCards.updated_at}`);
  console.log(`  Size: ${(defaultCards.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  URI: ${defaultCards.download_uri}`);
  console.log("");

  // Check if we already have this version
  const metaFile = join(BULK_DIR, "meta.json");
  try {
    const existing = JSON.parse(await Deno.readTextFile(metaFile));
    if (existing.updated_at === defaultCards.updated_at) {
      console.log(
        "Already have the latest version. Use --force to re-download.",
      );
      if (!Deno.args.includes("--force")) {
        return;
      }
    }
  } catch {
    // No existing meta, proceed with download
  }

  console.log("Downloading bulk data (this may take a minute)...");
  const dataRes = await fetch(defaultCards.download_uri);
  if (!dataRes.ok) {
    throw new Error(`Failed to download bulk data: ${dataRes.status}`);
  }
  console.log("Download complete. Processing data...");

  // Stream and parse the JSON array
  // The file is a large JSON array of card objects
  console.log("Parsing card data...");
  const allCards: any[] = await dataRes.json();
  console.log(`Total cards in bulk data: ${allCards.length}`);

  // Extract relevant fields, filtering to cards with art
  const cards: CardData[] = [];
  const seenIllustrations = new Set<string>();
  let skipped = 0;

  for (let i = 0; i < allCards.length; i++) {
    const card = allCards[i];

    if (i > 0 && i % PROGRESS_INTERVAL === 0) {
      console.log(`  Processing ${i}/${allCards.length}...`);
    }

    // Skip cards without illustration_id or image URIs
    if (!card.illustration_id || !card.image_uris?.art_crop) {
      // Check card_faces for double-faced cards
      if (
        card.card_faces?.[0]?.image_uris?.art_crop &&
        card.card_faces?.[0]?.illustration_id
      ) {
        // Use front face
        cards.push({
          id: card.id,
          oracle_id: card.oracle_id,
          illustration_id: card.card_faces[0].illustration_id ||
            card.illustration_id,
          name: card.name,
          set: card.set,
          set_name: card.set_name,
          collector_number: card.collector_number,
          lang: card.lang,
          image_uri_art_crop: card.card_faces[0].image_uris.art_crop,
          released_at: card.released_at,
        });
        seenIllustrations.add(
          card.card_faces[0].illustration_id || card.illustration_id,
        );
      } else {
        skipped++;
      }
      continue;
    }

    cards.push({
      id: card.id,
      oracle_id: card.oracle_id,
      illustration_id: card.illustration_id,
      name: card.name,
      set: card.set,
      set_name: card.set_name,
      collector_number: card.collector_number,
      lang: card.lang,
      image_uri_art_crop: card.image_uris.art_crop,
      released_at: card.released_at,
    });
    seenIllustrations.add(card.illustration_id);
  }

  console.log("");
  console.log(`Results:`);
  console.log(`  Cards with art: ${cards.length}`);
  console.log(`  Unique illustrations: ${seenIllustrations.size}`);
  console.log(`  Skipped (no art): ${skipped}`);

  // Write extracted card data
  await Deno.writeTextFile(CARDS_OUTPUT_FILE, JSON.stringify(cards));
  console.log(`  Written to: ${CARDS_OUTPUT_FILE}`);

  // Write meta info
  await Deno.writeTextFile(
    metaFile,
    JSON.stringify(
      {
        updated_at: defaultCards.updated_at,
        total_cards: cards.length,
        unique_illustrations: seenIllustrations.size,
        downloaded_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.log("\nDone! Run 'deno task db:art' next to download art images.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  Deno.exit(1);
});
