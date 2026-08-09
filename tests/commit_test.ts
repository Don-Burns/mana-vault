/// <reference lib="deno.ns" />
/**
 * Correctness tests for CollectionStore's commitAdd/commitRemove/commitMove
 * (the diff-based batch commit path). Complements
 * tests/commit_performance_test.ts, which only checks timing — these verify
 * the actual resulting rows: merging, illustration-fallback matching,
 * quantity clamping, skip counts, and cross-folder consistency for moves.
 */

import { assertEquals } from "@std/assert";
import { connect } from "@tursodatabase/database";
import {
  type CardCondition,
  type CardEntry,
  collectionStore,
  type StagingItem,
} from "../src/collection/store.ts";

async function freshStore(): Promise<void> {
  const path = await Deno.makeTempFile({ suffix: ".db" });
  await collectionStore.open(path, connect);
}

function stagingItem(overrides: Partial<StagingItem> = {}): StagingItem {
  return {
    scryfallId: "scry-1",
    illustrationId: "illus-1",
    oracleId: "oracle-1",
    name: "Lightning Bolt",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "1",
    quantity: 1,
    condition: "NM" as CardCondition,
    ...overrides,
  };
}

/** Seed a card directly via `putCard` (a single INSERT, no merge-by-printing). */
async function seedCard(
  folderId: string,
  overrides: Partial<StagingItem> = {},
): Promise<CardEntry> {
  const card: CardEntry = {
    id: crypto.randomUUID(),
    dateAdded: new Date().toISOString(),
    notes: "",
    folderId,
    ...stagingItem(overrides),
  };
  await collectionStore.putCard(card);
  return card;
}

Deno.test("commitAdd: creates a new row for an unmatched printing", async () => {
  await freshStore();
  const folder = await collectionStore.createFolder("Folder");

  const result = await collectionStore.commitAdd(folder.id, [
    stagingItem({ scryfallId: "scry-1", quantity: 3 }),
  ]);

  assertEquals(result, { applied: 1 });
  const cards = await collectionStore.getCardsByFolder(folder.id);
  assertEquals(cards.length, 1);
  assertEquals(cards[0].scryfallId, "scry-1");
  assertEquals(cards[0].quantity, 3);
});

Deno.test("commitAdd: merges quantity into an existing scryfallId match", async () => {
  await freshStore();
  const folder = await collectionStore.createFolder("Folder");
  await seedCard(folder.id, { scryfallId: "scry-1", quantity: 2 });

  await collectionStore.commitAdd(folder.id, [
    stagingItem({ scryfallId: "scry-1", quantity: 5 }),
  ]);

  const cards = await collectionStore.getCardsByFolder(folder.id);
  assertEquals(cards.length, 1);
  assertEquals(cards[0].quantity, 7);
});

Deno.test("commitAdd: batch with both a merge and a new row", async () => {
  await freshStore();
  const folder = await collectionStore.createFolder("Folder");
  await seedCard(folder.id, { scryfallId: "existing", quantity: 2 });

  const result = await collectionStore.commitAdd(folder.id, [
    stagingItem({ scryfallId: "existing", quantity: 1 }),
    stagingItem({
      scryfallId: "brand-new",
      illustrationId: "illus-new",
      quantity: 4,
    }),
  ]);

  assertEquals(result, { applied: 2 });
  const cards = await collectionStore.getCardsByFolder(folder.id);
  assertEquals(cards.length, 2);
  const bySryfallId = Object.fromEntries(
    cards.map((c) => [c.scryfallId, c.quantity]),
  );
  assertEquals(bySryfallId, { existing: 3, "brand-new": 4 });
});

Deno.test("commitRemove: exact scryfallId match decrements quantity", async () => {
  await freshStore();
  const folder = await collectionStore.createFolder("Folder");
  await seedCard(folder.id, { scryfallId: "scry-1", quantity: 5 });

  const result = await collectionStore.commitRemove(folder.id, [
    stagingItem({ scryfallId: "scry-1", quantity: 2 }),
  ]);

  assertEquals(result, { applied: 1, skipped: 0 });
  const cards = await collectionStore.getCardsByFolder(folder.id);
  assertEquals(cards.length, 1);
  assertEquals(cards[0].quantity, 3);
});

Deno.test("commitRemove: matches via illustrationId fallback when scryfallId differs", async () => {
  await freshStore();
  const folder = await collectionStore.createFolder("Folder");
  await seedCard(folder.id, {
      scryfallId: "printing-in-folder",
      illustrationId: "illus-shared",
      quantity: 5,
    });

  const result = await collectionStore.commitRemove(folder.id, [
    stagingItem({
      scryfallId: "different-printing",
      illustrationId: "illus-shared",
      quantity: 2,
    }),
  ]);

  assertEquals(result, { applied: 1, skipped: 0 });
  const cards = await collectionStore.getCardsByFolder(folder.id);
  assertEquals(cards[0].scryfallId, "printing-in-folder");
  assertEquals(cards[0].quantity, 3);
});

Deno.test("commitRemove: removing the full quantity deletes the row", async () => {
  await freshStore();
  const folder = await collectionStore.createFolder("Folder");
  await seedCard(folder.id, { scryfallId: "scry-1", quantity: 3 });

  const result = await collectionStore.commitRemove(folder.id, [
    stagingItem({ scryfallId: "scry-1", quantity: 3 }),
  ]);

  assertEquals(result, { applied: 1, skipped: 0 });
  assertEquals(await collectionStore.getCardsByFolder(folder.id), []);
});

Deno.test("commitRemove: removing more than exists still deletes (clamped) and is not skipped", async () => {
  await freshStore();
  const folder = await collectionStore.createFolder("Folder");
  await seedCard(folder.id, { scryfallId: "scry-1", quantity: 2 });

  const result = await collectionStore.commitRemove(folder.id, [
    stagingItem({ scryfallId: "scry-1", quantity: 10 }),
  ]);

  assertEquals(result, { applied: 1, skipped: 0 });
  assertEquals(await collectionStore.getCardsByFolder(folder.id), []);
});

Deno.test("commitRemove: unmatched items are skipped and leave the folder untouched", async () => {
  await freshStore();
  const folder = await collectionStore.createFolder("Folder");
  await seedCard(folder.id, { scryfallId: "scry-1", quantity: 5 });

  const result = await collectionStore.commitRemove(folder.id, [
    stagingItem({
      scryfallId: "not-in-folder",
      illustrationId: "illus-not-in-folder",
      quantity: 1,
    }),
  ]);

  assertEquals(result, { applied: 0, skipped: 1 });
  const cards = await collectionStore.getCardsByFolder(folder.id);
  assertEquals(cards.length, 1);
  assertEquals(cards[0].quantity, 5);
});

Deno.test("commitMove: moves and clamps quantity to what's available in the source", async () => {
  await freshStore();
  const source = await collectionStore.createFolder("Source");
  const dest = await collectionStore.createFolder("Dest");
  await seedCard(source.id, { scryfallId: "scry-1", quantity: 3 });

  const result = await collectionStore.commitMove(source.id, dest.id, [
    stagingItem({ scryfallId: "scry-1", quantity: 10 }),
  ]);

  assertEquals(result, { applied: 1, skipped: 0 });
  assertEquals(await collectionStore.getCardsByFolder(source.id), []);
  const destCards = await collectionStore.getCardsByFolder(dest.id);
  assertEquals(destCards.length, 1);
  assertEquals(destCards[0].quantity, 3);
});

Deno.test("commitMove: merges into an existing entry in the destination folder", async () => {
  await freshStore();
  const source = await collectionStore.createFolder("Source");
  const dest = await collectionStore.createFolder("Dest");
  await seedCard(source.id, { scryfallId: "scry-1", quantity: 4 });
  await seedCard(dest.id, { scryfallId: "scry-1", quantity: 2 });

  await collectionStore.commitMove(source.id, dest.id, [
    stagingItem({ scryfallId: "scry-1", quantity: 4 }),
  ]);

  const destCards = await collectionStore.getCardsByFolder(dest.id);
  assertEquals(destCards.length, 1);
  assertEquals(destCards[0].quantity, 6);
  assertEquals(await collectionStore.getCardsByFolder(source.id), []);
});

Deno.test("commitMove: matches via illustrationId fallback, using the matched entry's own scryfallId", async () => {
  await freshStore();
  const source = await collectionStore.createFolder("Source");
  const dest = await collectionStore.createFolder("Dest");
  await seedCard(source.id, {
      scryfallId: "printing-in-folder",
      illustrationId: "illus-shared",
      quantity: 5,
    });

  await collectionStore.commitMove(source.id, dest.id, [
    stagingItem({
      scryfallId: "different-printing",
      illustrationId: "illus-shared",
      quantity: 2,
    }),
  ]);

  const destCards = await collectionStore.getCardsByFolder(dest.id);
  assertEquals(destCards.length, 1);
  assertEquals(destCards[0].scryfallId, "printing-in-folder");
  assertEquals(destCards[0].quantity, 2);
});

Deno.test("commitMove: unmatched items are skipped, leaving both folders untouched", async () => {
  await freshStore();
  const source = await collectionStore.createFolder("Source");
  const dest = await collectionStore.createFolder("Dest");
  await seedCard(source.id, { scryfallId: "scry-1", quantity: 5 });

  const result = await collectionStore.commitMove(source.id, dest.id, [
    stagingItem({
      scryfallId: "not-in-source",
      illustrationId: "illus-not-in-source",
      quantity: 1,
    }),
  ]);

  assertEquals(result, { applied: 0, skipped: 1 });
  const sourceCards = await collectionStore.getCardsByFolder(source.id);
  assertEquals(sourceCards.length, 1);
  assertEquals(sourceCards[0].quantity, 5);
  assertEquals(await collectionStore.getCardsByFolder(dest.id), []);
});

Deno.test("commitMove: mixed batch — partial clamp, full move, and a skip, in one call", async () => {
  await freshStore();
  const source = await collectionStore.createFolder("Source");
  const dest = await collectionStore.createFolder("Dest");
  await seedCard(source.id, { scryfallId: "partial", quantity: 2 });
  await seedCard(source.id, { scryfallId: "full", illustrationId: "illus-full", quantity: 3 });

  const result = await collectionStore.commitMove(source.id, dest.id, [
    stagingItem({ scryfallId: "partial", quantity: 10 }), // clamps to 2
    stagingItem({ scryfallId: "full", illustrationId: "illus-full", quantity: 3 }), // exact
    stagingItem({
      scryfallId: "missing",
      illustrationId: "illus-missing",
      quantity: 1,
    }), // skipped
  ]);

  assertEquals(result, { applied: 2, skipped: 1 });
  assertEquals(await collectionStore.getCardsByFolder(source.id), []);
  const destCards = await collectionStore.getCardsByFolder(dest.id);
  const byScryfallId = Object.fromEntries(
    destCards.map((c) => [c.scryfallId, c.quantity]),
  );
  assertEquals(byScryfallId, { partial: 2, full: 3 });
});
