/// <reference lib="deno.ns" />
/**
 * CollectionStore tests, run against the Node native Turso driver
 * (`@tursodatabase/database`) instead of the WASM/OPFS driver used in the
 * browser. Both share the same `DatabasePromise` API and SQL semantics, so
 * this exercises all of the store's real SQL logic under `deno test`.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { connect } from "@tursodatabase/database";
import { collectionStore, type CardEntry } from "../src/collection/store.ts";

async function freshStore() {
  const path = await Deno.makeTempFile({ suffix: ".db" });
  await collectionStore.open(path, connect);
  return path;
}

function makeCard(overrides: Partial<CardEntry> = {}): Omit<CardEntry, "id" | "dateAdded"> {
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

Deno.test("folder CRUD + reorder", async () => {
  await freshStore();

  const a = await collectionStore.createFolder("A");
  const b = await collectionStore.createFolder("B");
  assertEquals((await collectionStore.getAllFolders()).map((f) => f.name), ["A", "B"]);

  await collectionStore.renameFolder(a.id, "A2");
  assertEquals((await collectionStore.getFolder(a.id))?.name, "A2");

  await collectionStore.reorderFolders([b.id, a.id]);
  assertEquals((await collectionStore.getAllFolders()).map((f) => f.id), [b.id, a.id]);

  // Deleting a folder ensures a default "Unsorted" folder exists to receive
  // its cards, so it's created here as a side effect.
  await collectionStore.deleteFolder(b.id);
  const remaining = (await collectionStore.getAllFolders()).map((f) => f.id);
  assertEquals(remaining.includes(a.id), true);
  assertEquals(remaining.includes(b.id), false);

  await collectionStore.close();
});

Deno.test("default folder cannot be deleted; cards move to it on folder delete", async () => {
  await freshStore();

  const def = await collectionStore.ensureDefaultFolder();
  await assertRejects(() => collectionStore.deleteFolder(def.id));

  const other = await collectionStore.createFolder("Other");
  const card = await collectionStore.addCard(makeCard({ folderId: other.id }));
  await collectionStore.deleteFolder(other.id);

  const moved = await collectionStore.getCard(card.id);
  assertEquals(moved?.folderId, def.id);

  await collectionStore.close();
});

Deno.test("addCard merges quantity for duplicate printing", async () => {
  await freshStore();

  const first = await collectionStore.addCard(makeCard({ quantity: 2 }));
  const second = await collectionStore.addCard(makeCard({ quantity: 3 }));

  assertEquals(second.id, first.id);
  assertEquals((await collectionStore.getCard(first.id))?.quantity, 5);
  assertEquals(await collectionStore.getTotalCardCount(), 5);

  await collectionStore.close();
});

Deno.test("moveCard splits and merges quantities across folders", async () => {
  await freshStore();

  const dest = await collectionStore.createFolder("Dest");
  const card = await collectionStore.addCard(makeCard({ quantity: 5 }));

  await collectionStore.moveCard(card.id, dest.id, 2);

  const source = await collectionStore.getCard(card.id);
  assertEquals(source?.quantity, 3);

  const moved = await collectionStore.findCardInFolder(dest.id, card.scryfallId);
  assertEquals(moved?.quantity, 2);

  // Moving the rest fully removes the source entry.
  await collectionStore.moveCard(card.id, dest.id);
  assertEquals(await collectionStore.getCard(card.id), undefined);
  assertEquals((await collectionStore.findCardInFolder(dest.id, card.scryfallId))?.quantity, 5);

  await collectionStore.close();
});

Deno.test("export/import round-trip", async () => {
  await freshStore();

  const folder = await collectionStore.createFolder("Export Test");
  await collectionStore.addCard(makeCard({ folderId: folder.id, quantity: 4 }));

  const exported = await collectionStore.exportCollection();

  await collectionStore.close();
  await freshStore();

  await collectionStore.importCollection(exported);
  const reimported = await collectionStore.exportCollection();

  assertEquals(reimported.folders.length, exported.folders.length);
  assertEquals(reimported.cards.length, exported.cards.length);
  assertEquals(reimported.cards[0].quantity, 4);

  await collectionStore.close();
});
