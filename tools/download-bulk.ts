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
  // `unique_artwork` collapses every printing down to one per illustration_id,
  // which silently drops legitimate alternate printings that share the same
  // art (e.g. Enlightened Tutor's 1997-frame vs 2015-frame retro printings in
  // Dominaria Remastered) — exactly the versions the printing picker needs to
  // offer. `default_cards` has one entry per real printing instead; we still
  // group by illustration_id ourselves in build-hashdb.ts, so this just means
  // each illustration's `printings` array is now complete instead of always
  // having exactly one entry.
  const defaultCards = catalog.data.find(
    (d: any) => d.type === "default_cards",
  );

  if (!defaultCards) {
    throw new Error("Could not find 'default_cards' in bulk data catalog");
  }

  console.log(`Bulk data info:`);
  console.log(`  Type: ${defaultCards.type}`);
  console.log(`  Updated: ${defaultCards.updated_at}`);
  console.log(
    `  Compressed size: ${
      (defaultCards.compressed_size / 1024 / 1024).toFixed(1)
    } MB`,
  );
  console.log(`  URI: ${defaultCards.jsonl_download_uri}`);
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
  const dataRes = await fetch(defaultCards.jsonl_download_uri);
  if (!dataRes.ok || !dataRes.body) {
    throw new Error(`Failed to download bulk data: ${dataRes.status}`);
  }

  // Scryfall bulk data is only offered gzip-compressed newline-delimited
  // JSON now (no more plain JSON-array `download_uri`), so decompress and
  // parse line-by-line as it streams in rather than buffering the whole
  // ~600 MB decompressed file in memory at once.
  console.log("Decompressing and parsing card data...");
  const lines = dataRes.body
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream());

  const cards: CardData[] = [];
  const seenIllustrations = new Set<string>();
  let skipped = 0;
  let processed = 0;
  let buffer = "";

  for await (const chunk of lines) {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim() || line === "[" || line === "]") continue;
      // Each line may have a trailing comma if the file happens to be a
      // pretty-printed JSON array instead of true JSONL; strip it either way.
      const json = line.endsWith(",") ? line.slice(0, -1) : line;
      processCard(JSON.parse(json), cards, seenIllustrations);
      processed++;
      if (processed % PROGRESS_INTERVAL === 0) {
        console.log(`  Processed ${processed}...`);
      }
    }
  }
  if (buffer.trim() && buffer.trim() !== "]") {
    processCard(JSON.parse(buffer), cards, seenIllustrations);
    processed++;
  }

  console.log(`Total cards in bulk data: ${processed}`);
  skipped = processed - cards.length;

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

/** Extract the fields we care about from one raw Scryfall card object. */
function processCard(
  card: any,
  cards: CardData[],
  seenIllustrations: Set<string>,
): void {
  // Art Series cards ("Phyrexia: All Will Be One Art Series", etc.) share
  // illustration_ids with the real card art but report a mangled
  // "Name // Name" card.name (Scryfall models them as double-faced), which
  // corrupts name lookups for that illustration group. Skip them entirely.
  // Also messes with sorting since they have cmc=0 etc.
  if (card.layout === "art_series") return;

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
        image_uri_art_full: card.card_faces[0].image_uris.small
          ? card.card_faces[0].image_uris.small
          : card.card_faces[0].image_uris.normal,
        released_at: card.released_at,
        cmc: card.cmc,
        colors: card.card_faces[0].colors ?? card.colors ?? [],
        rarity: card.rarity,
      });
      seenIllustrations.add(
        card.card_faces[0].illustration_id || card.illustration_id,
      );
    }
    return;
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
    image_uri_art_full: card.image_uris.small
      ? card.image_uris.small
      : card.image_uris.normal,
    released_at: card.released_at,
    cmc: card.cmc,
    colors: card.colors ?? [],
    rarity: card.rarity,
  });
  seenIllustrations.add(card.illustration_id);
}

main().catch((err) => {
  console.error("Error:", err.message);
  Deno.exit(1);
});
