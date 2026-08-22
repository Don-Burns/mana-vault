/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { cardsToCsv } from "../src/collection/export.ts";
import type { CardEntry } from "../src/collection/store-core.ts";

function card(overrides: Partial<CardEntry> = {}): CardEntry {
  return {
    id: "card-1",
    folderId: "folder-1",
    scryfallId: "print-1",
    illustrationId: "illus-1",
    oracleId: "oracle-1",
    name: "Temple of Mystery",
    setCode: "znr",
    setName: "Zendikar Rising",
    collectorNumber: "123",
    quantity: 2,
    condition: "NM",
    notes: "",
    dateAdded: "2024-01-01",
    ...overrides,
  };
}

function lines(csv: string): string[] {
  return csv.trim().split(/\r\n|\n/);
}

Deno.test("cardsToCsv() writes the header and one row per card", () => {
  const rows = lines(cardsToCsv([card()]));
  assertEquals(rows[0], "quantity,name,set_code,collector_number,condition");
  assertEquals(rows[1], "2,Temple of Mystery,znr,123,NM");
});

Deno.test("cardsToCsv() quotes names containing commas", () => {
  const csv = cardsToCsv([card({ name: "Fire, Ice" })]);
  assertEquals(lines(csv)[1], '2,"Fire, Ice",znr,123,NM');
});

Deno.test("cardsToCsv() returns just the header for an empty collection", () => {
  const csv = cardsToCsv([]);
  assertEquals(csv.trim(), "quantity,name,set_code,collector_number,condition");
});
