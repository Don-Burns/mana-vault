/// <reference lib="deno.ns" />
/**
 * StoreCore tests, run against an in-memory sqlite3-wasm db (see
 * tests/test-store.ts) instead of the browser's OPFS-backed worker. Same
 * SQL/business logic either way — see docs/turso_wasm_hang_and_alternatives.md.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { type CardEntry, TestStore } from "./test-store.ts";

async function freshStore(): Promise<TestStore> {
  const store = new TestStore();
  await store.open();
  return store;
}

function makeCard(
  overrides: Partial<CardEntry> = {},
): Omit<CardEntry, "id" | "dateAdded"> {
  return {
    folderId: "folder-1",
    scryfallId: "scry-1",
    illustrationId: "illus-1",
    oracleId: "oracle-1",
    name: "Lightning Bolt",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "1",
    quantity: 1,
    condition: "NM",
    notes: "",
    ...overrides,
  };
}

/** Seed a card directly via `putCard` (a single INSERT, no merge-by-printing). */
async function seedCard(
  store: TestStore,
  overrides: Partial<CardEntry> = {},
): Promise<CardEntry> {
  const card: CardEntry = {
    id: crypto.randomUUID(),
    dateAdded: new Date().toISOString(),
    ...makeCard(overrides),
  };
  await store.putCard(card);
  return card;
}

Deno.test("folder CRUD + reorder", async () => {
  const store = await freshStore();

  const a = await store.createFolder("A");
  const b = await store.createFolder("B");
  assertEquals((await store.getAllFolders()).map((f) => f.name), ["A", "B"]);

  await store.renameFolder(a.id, "A2");
  assertEquals((await store.getFolder(a.id))?.name, "A2");

  await store.reorderFolders([b.id, a.id]);
  assertEquals((await store.getAllFolders()).map((f) => f.id), [b.id, a.id]);

  // b has no cards, so it can be deleted freely.
  await store.deleteFolder(b.id);
  const remaining = (await store.getAllFolders()).map((f) => f.id);
  assertEquals(remaining.includes(a.id), true);
  assertEquals(remaining.includes(b.id), false);

  await store.close();
});

Deno.test("deleteFolder throws if the folder still contains cards", async () => {
  const store = await freshStore();

  const folder = await store.createFolder("Has Cards");
  await seedCard(store, { folderId: folder.id });

  await assertRejects(() => store.deleteFolder(folder.id));

  await store.close();
});

Deno.test("deleteFolder succeeds once the folder is empty", async () => {
  const store = await freshStore();

  const folder = await store.createFolder("Empty");
  await store.deleteFolder(folder.id);

  assertEquals(await store.getFolder(folder.id), undefined);

  await store.close();
});

Deno.test("snapshot/loadSnapshot round-trip preserves folders and cards", async () => {
  const store = await freshStore();

  const folder = await store.createFolder("Scratch Test");
  await seedCard(store, { folderId: folder.id, quantity: 7 });
  const before = await store.snapshot();

  const restored = new TestStore();
  await restored.open();
  await restored.loadSnapshot(before);

  const after = await restored.snapshot();
  assertEquals(after.folders.length, before.folders.length);
  assertEquals(after.cards.length, before.cards.length);
  assertEquals(after.cards[0].quantity, 7);

  await store.close();
  await restored.close();
});

Deno.test("export a folder's cards, wipe the collection, then restore from the snapshot", async () => {
  const store = await freshStore();

  const main = await store.createFolder("main");
  await seedCard(store, {
    folderId: main.id,
    scryfallId: "temple-garden",
    illustrationId: "illus-temple-garden",
    oracleId: "oracle-temple-garden",
    name: "Temple Garden",
    setCode: "rna",
    setName: "Ravnica Allegiance",
    collectorNumber: "246",
  });
  await seedCard(store, {
    folderId: main.id,
    scryfallId: "orcish-bowmasters",
    illustrationId: "illus-orcish-bowmasters",
    oracleId: "oracle-orcish-bowmasters",
    name: "Orcish Bowmasters",
    setCode: "lci",
    setName: "The Lost Caverns of Ixalan",
    collectorNumber: "134",
  });
  await seedCard(store, {
    folderId: main.id,
    scryfallId: "scalding-tarn",
    illustrationId: "illus-scalding-tarn",
    oracleId: "oracle-scalding-tarn",
    name: "Scalding Tarn",
    setCode: "mh2",
    setName: "Modern Horizons 2",
    collectorNumber: "247",
  });

  const snapshot = await store.snapshot();

  // Reset the current store: remove all cards in `main`, then the folder itself.
  const mainCards = await store.getCardsByFolder(main.id);
  for (const card of mainCards) {
    await store.deleteCard(card.id);
  }
  await store.deleteFolder(main.id);
  assertEquals(await store.getTotalCardCount(), 0);

  // Restore from the snapshot.
  await store.loadSnapshot(snapshot);
  assertEquals((await store.getAllFolders()).length, 1); // just "main"
  assertEquals(await store.getTotalCardCount(), 3);

  const restoredMain = (await store.getAllFolders()).find((f) => f.name === "main");
  assertEquals(restoredMain !== undefined, true);

  const restoredCards = await store.getCardsByFolder(restoredMain!.id);
  assertEquals(
    restoredCards.map((c) => c.name).sort(),
    ["Orcish Bowmasters", "Scalding Tarn", "Temple Garden"],
  );

  await store.close();
});
