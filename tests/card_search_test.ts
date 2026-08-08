/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import {
  groupedCardSearch,
  printingsForName,
} from "../src/collection/card-search.ts";

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
      // Same name as illus-1 (a reprint with new art) — should collapse to
      // one result in groupedCardSearch, and contribute a second printing
      // to printingsForName.
      "illus-1-reprint": {
        oracle_id: "oracle-1",
        name: "Lightning Bolt",
        cmc: 1,
        colors: ["R"],
        printings: [{
          id: "print-1b",
          set: "m10",
          set_name: "Magic 2010",
          collector_number: "146",
          lang: "en",
          released_at: "2009-07-17",
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

Deno.test("groupedCardSearch() matches by case-insensitive substring", () => {
  const results = groupedCardSearch(metadata(), "lightning");
  assertEquals(results.map((r) => r.name).sort(), [
    "Lightning Bolt",
    "Lightning Strike",
  ]);
});

Deno.test("groupedCardSearch() dedupes same-name results across illustrations", () => {
  const results = groupedCardSearch(metadata(), "bolt");
  assertEquals(results.length, 1);
  assertEquals(results[0].name, "Lightning Bolt");
});

Deno.test("groupedCardSearch() returns empty array for empty query", () => {
  assertEquals(groupedCardSearch(metadata(), ""), []);
  assertEquals(groupedCardSearch(metadata(), "   "), []);
});

Deno.test("groupedCardSearch() respects the limit", () => {
  const results = groupedCardSearch(metadata(), "e", 1);
  assertEquals(results.length, 1);
});

Deno.test("groupedCardSearch() finds no matches", () => {
  assertEquals(groupedCardSearch(metadata(), "nonexistent card"), []);
});

Deno.test("printingsForName() collects printings across illustration IDs sharing a name, most recent first", () => {
  const results = printingsForName(metadata(), "Lightning Bolt");
  assertEquals(results.map((p) => p.id), ["print-1b", "print-1"]);
  assertEquals(results.map((p) => p.illustrationId), [
    "illus-1-reprint",
    "illus-1",
  ]);
});

Deno.test("printingsForName() returns empty array for unknown name", () => {
  assertEquals(printingsForName(metadata(), "Nonexistent Card"), []);
});
