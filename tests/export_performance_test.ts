/// <reference lib="deno.ns" />
/**
 * Performance guard for the driver-agnostic parts of `exportAsDB()`
 * (src/collection/export.ts): checkpointing the WAL, closing the live
 * connection, and reopening it. The actual export now reads the live db's
 * raw bytes directly off OPFS while the connection is closed — no scratch
 * connection, no per-row copy — so there's no db work left to benchmark
 * for the byte-copy step itself; that step is a plain file read and can
 * only be exercised in a real browser (OPFS is not available under Deno's
 * native-driver test setup used here for speed). See
 * docs/turso_collection_db.md for the "requires a real browser" caveat
 * that already applies to other OPFS-only behavior in this codebase.
 *
 * Runs against the Node native Turso driver — no browser postMessage/OPFS
 * overhead — so if this budget is blown here it will be worse in the real
 * WASM/OPFS browser driver.
 */

import { assert } from "@std/assert";
import { connect } from "@tursodatabase/database";
import {
  type CardCondition,
  collectionStore,
  type StagingItem,
} from "../src/collection/store.ts";

const BUDGET_MS = 1000;
const CARD_COUNT = 10000;

async function freshStore(): Promise<string> {
  const path = await Deno.makeTempFile({ suffix: ".db" });
  await collectionStore.open(path, connect);
  return path;
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

Deno.test("checkpointWal + close + reopen: 10000 cards completes within budget", async () => {
  const path = await freshStore();
  const folder = await collectionStore.createFolder("Big");

  // Bulk-insert seed data via commitAdd (single transaction, no per-row
  // round trip) instead of one putCard call per row.
  const items = Array.from({ length: CARD_COUNT }, (_, i) => stagingItem(i));
  await collectionStore.commitAdd(folder.id, items);

  const t0 = performance.now();
  await collectionStore.checkpointWal();
  await collectionStore.close();
  await collectionStore.open(path, connect);
  const elapsed = performance.now() - t0;

  await collectionStore.close();

  assert(
    elapsed < BUDGET_MS,
    `checkpointWal+close+reopen took ${
      elapsed.toFixed(0)
    }ms for ${CARD_COUNT} cards, budget is ${BUDGET_MS}ms`,
  );
});
