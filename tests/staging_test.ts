/// <reference lib="deno.ns" />

import { assertEquals, assertThrows } from "@std/assert";
import {
  importToStagingListFromCsv as importToStagingListFromCsv,
  StagingList,
} from "../src/collection/staging.ts";

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

const METADATA = {
  illustrations: {
    "illus-1": {
      oracle_id: "oracle-1",
      name: "Temple of Mystery",
      cmc: 2,
      colors: ["G", "U"],
      printings: [{
        id: "print-1",
        set: "znr",
        set_name: "Zendikar Rising",
        collector_number: "123",
        lang: "en",
        released_at: "2020-09-25",
        rarity: "uncommon",
      }],
    },
    "illus-2": {
      oracle_id: "oracle-2",
      name: "Lightning Strike",
      cmc: 2,
      colors: ["R"],
      printings: [{
        id: "print-2",
        set: "m19",
        set_name: "Core Set 2019",
        collector_number: "2",
        lang: "en",
        released_at: "2018-07-13",
        rarity: "common",
      }],
    },
    "illus-3": {
      oracle_id: "oracle-3",
      name: "Muldrotha, the Gravetide",
      cmc: 6,
      colors: ["B", "G", "U"],
      printings: [{
        id: "print-3",
        set: "dom",
        set_name: "Dominaria",
        collector_number: "199",
        lang: "en",
        released_at: "2018-04-27",
        rarity: "mythic",
      }],
    },
  },
};

Deno.test("importToStagingListFromCsv() imports cards from CSV data", async () => {
  const staging = freshStagingList();
  const csvData = `name,set_code,collector_number,quantity
Lightning Strike,m19,2,1`;

  await importToStagingListFromCsv(csvData, staging, METADATA);

  assertEquals(staging.count, 1);
  assertEquals(staging.totalQuantity, 1);
});

Deno.test("importToStagingListFromCsv() merges quantities for duplicate rows", async () => {
  const staging = freshStagingList();
  const csvData = `name,set_code,collector_number,quantity
Lightning Strike,m19,2,1
Lightning Strike,m19,2,2`;

  await importToStagingListFromCsv(csvData, staging, METADATA);

  assertEquals(staging.count, 1);
  assertEquals(staging.totalQuantity, 3);
});

Deno.test("importToStagingListFromCsv() handles columns in arbitrary order", async () => {
  const staging = freshStagingList();
  const csvData = `quantity,name,set_code,collector_number
1,Lightning Strike,m19,2`;

  await importToStagingListFromCsv(csvData, staging, METADATA);

  assertEquals(staging.count, 1);
  assertEquals(staging.totalQuantity, 1);
});

Deno.test("importToStagingListFromCsv() throws an error for missing required columns", async () => {
  const staging = freshStagingList();
  const csvData = `name,set_code,collector_number
Lightning Strike,m19,2`;

  assertThrows(
    () => {
      importToStagingListFromCsv(csvData, staging, METADATA);
    },
    Error,
    "CSV is missing required columns. Expected: quantity, name, set_code, collector_number.",
  );
});

Deno.test("importToStagingListFromCsv() throws an error for rows with unknown cards", async () => {
  const staging = freshStagingList();
  const csvData = `name,set_code,collector_number,quantity
Unknown Card,m19,1,1`;

  assertThrows(
    () => {
      importToStagingListFromCsv(csvData, staging, METADATA);
    },
    Error,
    "Couldn't find card: Unknown Card (m19 1)",
  );
});

Deno.test("importToStagingListFromCsv() handles quoted fields containing commas", () => {
  const staging = freshStagingList();
  // The quoted name below contains a comma; a naive comma-split would treat
  // it as two extra columns and shift set/collector_number/quantity out of
  // place. Asserting the full, un-split name shows up in the error message
  // proves the parser actually respects the quoting.
  const csvData = `name,set_code,collector_number,quantity
"Unknown, Comma Card",m19,1,1`;

  assertThrows(
    () => {
      importToStagingListFromCsv(csvData, staging, METADATA);
    },
    Error,
    "Couldn't find card: Unknown, Comma Card (m19 1)",
  );
});

Deno.test("importToStagingListFromCsv() imports a found card whose name needs quote escaping", () => {
  const staging = freshStagingList();
  const csvData = `name,set_code,collector_number,quantity
"Muldrotha, the Gravetide",dom,199,1`;

  importToStagingListFromCsv(csvData, staging, METADATA);

  assertEquals(staging.count, 1);
  assertEquals(staging.getAll()[0].name, "Muldrotha, the Gravetide");
});
