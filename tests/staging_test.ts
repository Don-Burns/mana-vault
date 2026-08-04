/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { StagingList } from "../src/collection/staging.ts";

function card(overrides: Partial<Parameters<StagingList["add"]>[0]> = {}) {
  return {
    illustrationId: "illus-1",
    scryfallId: "print-1",
    oracleId: "oracle-1",
    name: "Temple of Mystery",
    setCode: "znr",
    setName: "Zendikar Rising",
    collectorNumber: "123",
    quantity: 1,
    condition: "NM" as const,
    confidence: 90,
    ...overrides,
  };
}

Deno.test("add() pushes a new entry for a new printing", () => {
  const staging = new StagingList();
  staging.add(card());

  assertEquals(staging.count, 1);
  assertEquals(staging.totalQuantity, 1);
});

Deno.test("add() merges by scryfallId and increments quantity", () => {
  const staging = new StagingList();
  staging.add(card());
  staging.add(card());

  assertEquals(staging.count, 1, "should not create a duplicate entry");
  assertEquals(staging.totalQuantity, 2, "quantity should accumulate");
});

Deno.test("add() keeps different printings as separate entries", () => {
  const staging = new StagingList();
  staging.add(card({ scryfallId: "print-1" }));
  staging.add(card({ scryfallId: "print-2" }));

  assertEquals(staging.count, 2);
  assertEquals(staging.totalQuantity, 2);
});

Deno.test("getAll() reflects insertion order, last item is the most recent", () => {
  const staging = new StagingList();
  staging.add(card({ scryfallId: "print-1", name: "First" }));
  staging.add(card({ scryfallId: "print-2", name: "Second" }));

  const items = staging.getAll();
  assertEquals(items.at(-1)!.scryfallId, "print-2");
});

Deno.test("remove() drops the entry by id", () => {
  const staging = new StagingList();
  const added = staging.add(card());
  staging.remove(added.id);

  assertEquals(staging.count, 0);
});

Deno.test("clear() empties the list", () => {
  const staging = new StagingList();
  staging.add(card({ scryfallId: "print-1" }));
  staging.add(card({ scryfallId: "print-2" }));
  staging.clear();

  assertEquals(staging.count, 0);
  assertEquals(staging.totalQuantity, 0);
});
