/// <reference lib="deno.ns" />
/**
 * Performance guard for committing a staging batch into the collection.
 * Runs against an in-memory sqlite-wasm db (fastest case — no browser
 * postMessage/OPFS overhead at all), so if this budget is blown here it
 * will be considerably worse in the real WASM/OPFS browser driver.
 *
 * Expected to FAIL against the current naive per-item commitAdd/commitRemove/
 * commitMove (each item does its own separate SELECT-then-write, unbatched)
 * and PASS once they're rewritten to apply the whole batch as a single
 * transaction.
 */

import { assert } from "@std/assert";
import { type CardCondition, type StagingItem, TestStore } from "./test-store.ts";

const BUDGET_MS = 500;
const FOLDER_SIZE = 1000;
const STAGED_SIZE = 300;

async function freshStore(): Promise<TestStore> {
  const store = new TestStore();
  await store.open();
  return store;
}

function stagingItem(i: number): StagingItem {
  return {
    scryfallId: `scry-${i}`,
    illustrationId: `illus-${i}`,
    oracleId: `oracle-${i}`,
    name: `Card ${i}`,
    setCode: "tst",
    setName: "Test Set",
    collectorNumber: String(i),
    quantity: 1,
    condition: "NM" as CardCondition,
    cmc: 1,
    colors: ["U"],
    rarity: "common",
  };
}

/** Fast seed: bulk insert via commitAdd (single transaction), no per-row round trip. */
async function seedFolder(store: TestStore, folderId: string, count: number): Promise<void> {
  const items = Array.from({ length: count }, (_, i) => stagingItem(i));
  await store.commitAdd(folderId, items);
}

Deno.test("commitAdd: 300 new staged cards into a 1000-card folder completes within budget", async () => {
  const store = await freshStore();
  const folder = await store.createFolder("Big");
  await seedFolder(store, folder.id, FOLDER_SIZE);

  // All new printings — none match the seeded rows.
  const items = Array.from(
    { length: STAGED_SIZE },
    (_, i) => stagingItem(FOLDER_SIZE + i),
  );

  const t0 = performance.now();
  await store.commitAdd(folder.id, items);
  const elapsed = performance.now() - t0;

  await store.close();
  assert(
    elapsed < BUDGET_MS,
    `commitAdd took ${elapsed.toFixed(0)}ms, budget is ${BUDGET_MS}ms`,
  );
});

Deno.test("commitRemove: 300 staged cards removed from a 1000-card folder completes within budget", async () => {
  const store = await freshStore();
  const folder = await store.createFolder("Big");
  await seedFolder(store, folder.id, FOLDER_SIZE);

  // Matches the first 300 seeded rows exactly.
  const items = Array.from({ length: STAGED_SIZE }, (_, i) => stagingItem(i));

  const t0 = performance.now();
  await store.commitRemove(folder.id, items);
  const elapsed = performance.now() - t0;

  await store.close();
  assert(
    elapsed < BUDGET_MS,
    `commitRemove took ${elapsed.toFixed(0)}ms, budget is ${BUDGET_MS}ms`,
  );
});

Deno.test("commitMove: 300 staged cards moved from a 1000-card folder completes within budget", async () => {
  const store = await freshStore();
  const source = await store.createFolder("Source");
  const dest = await store.createFolder("Dest");
  await seedFolder(store, source.id, FOLDER_SIZE);
  await seedFolder(store, dest.id, FOLDER_SIZE);

  const items = Array.from({ length: STAGED_SIZE }, (_, i) => stagingItem(i));

  const t0 = performance.now();
  await store.commitMove(source.id, dest.id, items);
  const elapsed = performance.now() - t0;

  await store.close();
  assert(
    elapsed < BUDGET_MS,
    `commitMove took ${elapsed.toFixed(0)}ms, budget is ${BUDGET_MS}ms`,
  );
});
