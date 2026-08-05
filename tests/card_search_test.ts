/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { searchCards } from "../src/collection/card-search.ts";

function metadata() {
  return {
    illustrations: {
      "illus-1": {
        oracle_id: "oracle-1",
        name: "Lightning Bolt",
        cmc: 1,
        colors: ["R"],
        printings: [{
          id: "print-1",
          set: "lea",
          set_name: "Limited Edition Alpha",
          collector_number: "1",
          lang: "en",
          released_at: "1993-08-05",
          rarity: "common",
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
        name: "Counterspell",
        cmc: 2,
        colors: ["U"],
        printings: [{
          id: "print-3",
          set: "leb",
          set_name: "Limited Edition Beta",
          collector_number: "3",
          lang: "en",
          released_at: "1993-10-01",
          rarity: "common",
        }],
      },
    },
  };
}

Deno.test("searchCards() matches by case-insensitive substring", () => {
  const results = searchCards(metadata(), "lightning");
  assertEquals(results.length, 2);
  assertEquals(results.map((r) => r.name).sort(), [
    "Lightning Bolt",
    "Lightning Strike",
  ]);
});

Deno.test("searchCards() returns empty array for empty query", () => {
  assertEquals(searchCards(metadata(), ""), []);
  assertEquals(searchCards(metadata(), "   "), []);
});

Deno.test("searchCards() respects the limit", () => {
  const results = searchCards(metadata(), "e", 1);
  assertEquals(results.length, 1);
});

Deno.test("searchCards() finds no matches", () => {
  assertEquals(searchCards(metadata(), "nonexistent card"), []);
});
