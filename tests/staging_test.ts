/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { StagingList } from "../src/collection/staging.ts";

// localStorage persists across tests in the same Deno process; each test
// gets a fresh StagingList, so start with a clean slate every time.
function freshStagingList(): StagingList {
  localStorage.clear();
  return new StagingList();
}

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
  const staging = freshStagingList();
  staging.add(card());

  assertEquals(staging.count, 1);
  assertEquals(staging.totalQuantity, 1);
});

Deno.test("add() merges by scryfallId and increments quantity", () => {
  const staging = freshStagingList();
  staging.add(card());
  staging.add(card());

  assertEquals(staging.count, 1, "should not create a duplicate entry");
  assertEquals(staging.totalQuantity, 2, "quantity should accumulate");
});

Deno.test("add() keeps different printings as separate entries", () => {
  const staging = freshStagingList();
  staging.add(card({ scryfallId: "print-1" }));
  staging.add(card({ scryfallId: "print-2" }));

  assertEquals(staging.count, 2);
  assertEquals(staging.totalQuantity, 2);
});

Deno.test("getAll() reflects insertion order, last item is the most recent", () => {
  const staging = freshStagingList();
  staging.add(card({ scryfallId: "print-1", name: "First" }));
  staging.add(card({ scryfallId: "print-2", name: "Second" }));

  const items = staging.getAll();
  assertEquals(items.at(-1)!.scryfallId, "print-2");
});

Deno.test("remove() drops the entry by id", () => {
  const staging = freshStagingList();
  const added = staging.add(card());
  staging.remove(added.id);

  assertEquals(staging.count, 0);
});

Deno.test("clear() empties the list", () => {
  const staging = freshStagingList();
  staging.add(card({ scryfallId: "print-1" }));
  staging.add(card({ scryfallId: "print-2" }));
  staging.clear();

  assertEquals(staging.count, 0);
  assertEquals(staging.totalQuantity, 0);
});

Deno.test("changePrinting() swaps the selected printing's fields, including across illustrations", () => {
  const staging = freshStagingList();
  const added = staging.add(card());

  staging.changePrinting(added.id, {
    id: "print-2",
    illustrationId: "illus-2",
    set: "m19",
    set_name: "Core Set 2019",
    collector_number: "42",
    lang: "en",
    released_at: "2018-07-13",
    rarity: "common",
  });

  const item = staging.getAll().find((i) => i.id === added.id)!;
  assertEquals(item.scryfallId, "print-2");
  assertEquals(item.illustrationId, "illus-2");
  assertEquals(item.setCode, "m19");
  assertEquals(item.setName, "Core Set 2019");
  assertEquals(item.collectorNumber, "42");
});

Deno.test("persists across instances via localStorage", () => {
  try {
    const staging = freshStagingList();
    staging.add(card());

    const rehydrated = new StagingList();
    assertEquals(rehydrated.count, 1);
    assertEquals(rehydrated.getAll()[0].scryfallId, "print-1");
  } finally {
    localStorage.clear();
  }
});

Deno.test("recovers from corrupt localStorage data", () => {
  localStorage.clear();
  localStorage.setItem("mana-vault:staging", "{not json");
  try {
    const staging = new StagingList();
    assertEquals(staging.count, 0);
  } finally {
    localStorage.clear();
  }
});
