/// <reference lib="deno.ns" />
/**
 * CollectionStore tests, run against the Node native Turso driver
 * (`@tursodatabase/database`) instead of the WASM/OPFS driver used in the
 * browser. Both share the same `DatabasePromise` API and SQL semantics, so
 * this exercises all of the store's real SQL logic under `deno test`.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { connect } from "@tursodatabase/database";
import { type CardEntry, collectionStore } from "../src/collection/store.ts";

async function freshStore() {
  const path = await Deno.makeTempFile({ suffix: ".db" });
  await collectionStore.open(path, connect);
  return path;
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

Deno.test("folder CRUD + reorder", async () => {
  await freshStore();

  const a = await collectionStore.createFolder("A");
  const b = await collectionStore.createFolder("B");
  assertEquals((await collectionStore.getAllFolders()).map((f) => f.name), [
    "A",
    "B",
  ]);

  await collectionStore.renameFolder(a.id, "A2");
  assertEquals((await collectionStore.getFolder(a.id))?.name, "A2");

  await collectionStore.reorderFolders([b.id, a.id]);
  assertEquals((await collectionStore.getAllFolders()).map((f) => f.id), [
    b.id,
    a.id,
  ]);

  // b has no cards, so it can be deleted freely.
  await collectionStore.deleteFolder(b.id);
  const remaining = (await collectionStore.getAllFolders()).map((f) => f.id);
  assertEquals(remaining.includes(a.id), true);
  assertEquals(remaining.includes(b.id), false);

  await collectionStore.close();
});

Deno.test("deleteFolder throws if the folder still contains cards", async () => {
  await freshStore();

  const folder = await collectionStore.createFolder("Has Cards");
  await collectionStore.addCard(makeCard({ folderId: folder.id }));

  await assertRejects(() => collectionStore.deleteFolder(folder.id));

  await collectionStore.close();
});

Deno.test("deleteFolder succeeds once the folder is empty", async () => {
  await freshStore();

  const folder = await collectionStore.createFolder("Empty");
  await collectionStore.deleteFolder(folder.id);

  assertEquals(await collectionStore.getFolder(folder.id), undefined);

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

  const moved = await collectionStore.findCardInFolder(
    dest.id,
    card.scryfallId,
  );
  assertEquals(moved?.quantity, 2);

  // Moving the rest fully removes the source entry.
  await collectionStore.moveCard(card.id, dest.id);
  assertEquals(await collectionStore.getCard(card.id), undefined);
  assertEquals(
    (await collectionStore.findCardInFolder(dest.id, card.scryfallId))
      ?.quantity,
    5,
  );

  await collectionStore.close();
});

/**
 * Mimics `importFromDB` in src/collection/export.ts (which uses OPFS APIs
 * browser-side): validate `sourcePath` on a scratch connection, then close
 * the live store, overwrite `livePath`'s bytes with the source file, drop
 * any stale WAL, and reopen.
 */
async function importFileIntoLiveStore(livePath: string, sourcePath: string) {
  const data = await collectionStore.readCollectionFromFile(sourcePath);
  await collectionStore.close();
  await Deno.copyFile(sourcePath, livePath);
  await Deno.remove(`${livePath}-wal`).catch(() => {});
  await collectionStore.open(livePath, connect);
  await collectionStore.ensureDefaultFolder();
  return { folders: data.folders.length, cards: data.cards.length };
}

Deno.test("exportToScratch/readCollectionFromFile round-trip via a standalone db file", async () => {
  const livePath = await freshStore();

  const folder = await collectionStore.createFolder("Scratch Test");
  await collectionStore.addCard(makeCard({ folderId: folder.id, quantity: 7 }));
  const before = await collectionStore.exportCollection();

  const scratchPath = await Deno.makeTempFile({ suffix: ".db" });
  await Deno.remove(scratchPath); // exportToScratch must create it fresh
  await collectionStore.exportToScratch(scratchPath);

  const result = await importFileIntoLiveStore(livePath, scratchPath);
  assertEquals(result.folders, before.folders.length);
  assertEquals(result.cards, before.cards.length);

  const after = await collectionStore.exportCollection();
  assertEquals(after.folders.length, before.folders.length);
  assertEquals(after.cards.length, before.cards.length);
  assertEquals(after.cards[0].quantity, 7);

  await collectionStore.close();
  await Deno.remove(scratchPath);
});

Deno.test("importing an invalid file rejects and leaves the live collection untouched", async () => {
  const livePath = await freshStore();

  const folder = await collectionStore.createFolder("Keep Me");
  await collectionStore.addCard(makeCard({ folderId: folder.id, quantity: 1 }));

  const garbagePath = await Deno.makeTempFile({ suffix: ".db" });
  await Deno.writeTextFile(garbagePath, "not a sqlite database");

  await assertRejects(() => collectionStore.readCollectionFromFile(garbagePath));

  // Live store connection/data survive the failed validation untouched.
  const after = await collectionStore.exportCollection();
  assertEquals(after.folders.length, 1);
  assertEquals(after.folders[0].name, "Keep Me");
  assertEquals(after.cards.length, 1);

  await collectionStore.close();
  await Deno.remove(garbagePath);
});

Deno.test("export a folder's cards to a db file, wipe the collection, then import restores them", async () => {
  const livePath = await freshStore();

  const main = await collectionStore.createFolder("main");
  await collectionStore.addCard(
    makeCard({
      folderId: main.id,
      scryfallId: "temple-garden",
      illustrationId: "illus-temple-garden",
      oracleId: "oracle-temple-garden",
      name: "Temple Garden",
      setCode: "rna",
      setName: "Ravnica Allegiance",
      collectorNumber: "246",
    }),
  );
  await collectionStore.addCard(
    makeCard({
      folderId: main.id,
      scryfallId: "orcish-bowmasters",
      illustrationId: "illus-orcish-bowmasters",
      oracleId: "oracle-orcish-bowmasters",
      name: "Orcish Bowmasters",
      setCode: "lci",
      setName: "The Lost Caverns of Ixalan",
      collectorNumber: "134",
    }),
  );
  await collectionStore.addCard(
    makeCard({
      folderId: main.id,
      scryfallId: "scalding-tarn",
      illustrationId: "illus-scalding-tarn",
      oracleId: "oracle-scalding-tarn",
      name: "Scalding Tarn",
      setCode: "mh2",
      setName: "Modern Horizons 2",
      collectorNumber: "247",
    }),
  );

  const scratchPath = await Deno.makeTempFile({ suffix: ".db" });
  await Deno.remove(scratchPath); // exportToScratch must create it fresh
  await collectionStore.exportToScratch(scratchPath);

  // Reset the current DB: remove all cards in `main`, then the folder itself.
  const mainCards = await collectionStore.getCardsByFolder(main.id);
  for (const card of mainCards) {
    await collectionStore.deleteCard(card.id);
  }
  await collectionStore.deleteFolder(main.id);
  assertEquals(await collectionStore.getTotalCardCount(), 0);

  // Import the exported db back in.
  const result = await importFileIntoLiveStore(livePath, scratchPath);
  assertEquals(result.folders, 1); // just "main" — no default folder was ever created
  assertEquals(result.cards, 3);

  const restoredMain = (await collectionStore.getAllFolders()).find((f) =>
    f.name === "main"
  );
  assertEquals(restoredMain !== undefined, true);

  const restoredCards = await collectionStore.getCardsByFolder(
    restoredMain!.id,
  );
  assertEquals(
    restoredCards.map((c) => c.name).sort(),
    ["Orcish Bowmasters", "Scalding Tarn", "Temple Garden"],
  );

  await collectionStore.close();
  await Deno.remove(scratchPath);
});
