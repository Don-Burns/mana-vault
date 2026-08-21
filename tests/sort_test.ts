/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import {
  type SortableCard,
  sortCards,
  type SortCriterion,
} from "../src/collection/sort.ts";

function card(
  overrides: Partial<SortableCard> & { name: string },
): SortableCard {
  return {
    setCode: "aaa",
    collectorNumber: "1",
    quantity: 1,
    ...overrides,
  };
}

function crit(
  method: SortCriterion["method"],
  direction: SortCriterion["direction"] = "asc",
): SortCriterion[] {
  return [{ method, direction }];
}

Deno.test("sortCards: name asc", () => {
  const cards = [card({ name: "Zebra" }), card({ name: "Apple" })];
  assertEquals(sortCards(cards, crit("name")).map((c) => c.name), [
    "Apple",
    "Zebra",
  ]);
});

Deno.test("sortCards: name desc", () => {
  const cards = [card({ name: "Apple" }), card({ name: "Zebra" })];
  assertEquals(sortCards(cards, crit("name", "desc")).map((c) => c.name), [
    "Zebra",
    "Apple",
  ]);
});

Deno.test("sortCards: set + collector number", () => {
  const cards = [
    card({ name: "B", setCode: "aaa", collectorNumber: "10" }),
    card({ name: "A", setCode: "aaa", collectorNumber: "2" }),
  ];
  assertEquals(sortCards(cards, crit("set")).map((c) => c.name), ["A", "B"]);
});

Deno.test("sortCards: quantity asc (new default direction)", () => {
  const cards = [
    card({ name: "High", quantity: 5 }),
    card({ name: "Low", quantity: 1 }),
  ];
  assertEquals(sortCards(cards, crit("quantity")).map((c) => c.name), [
    "Low",
    "High",
  ]);
});

Deno.test("sortCards: quantity desc", () => {
  const cards = [
    card({ name: "Low", quantity: 1 }),
    card({ name: "High", quantity: 5 }),
  ];
  assertEquals(sortCards(cards, crit("quantity", "desc")).map((c) => c.name), [
    "High",
    "Low",
  ]);
});

Deno.test("sortCards: cmc, missing pushed to end regardless of direction", () => {
  const cards = [
    card({ name: "NoCmc" }),
    card({ name: "Three", cmc: 3 }),
    card({ name: "One", cmc: 1 }),
  ];
  assertEquals(sortCards(cards, crit("cmc")).map((c) => c.name), [
    "One",
    "Three",
    "NoCmc",
  ]);
  assertEquals(
    sortCards(cards, crit("cmc", "desc")).map((c) => c.name),
    ["Three", "One", "NoCmc"],
  );
});

Deno.test("sortCards: color WUBRG, colorless, multicolor", () => {
  const cards = [
    card({ name: "Multi-WG", colors: ["W", "G"] }),
    card({ name: "zMulti-UW", colors: ["U", "W"] }),
    card({ name: "Multi-WU", colors: ["W", "U"] }),
    card({ name: "Colorless", colors: [] }),
    card({ name: "Blue", colors: ["U"] }),
    card({ name: "White", colors: ["W"] }),
    card({ name: "a multi-pip BUG", colors: ["B", "U", "G"] }),
    card({ name: "a multi-pip WBG", colors: ["W", "B", "G"] }),
    card({ name: "a multi-pip", colors: ["W", "W"] }),
    card({ name: "a multi-pip BBW", colors: ["B", "B", "W"] }),
    card({ name: "z multi-pip WBB", colors: ["W", "B", "B"] }),
  ];
  assertEquals(sortCards(cards, crit("color")).map((c) => c.name), [
    "a multi-pip",
    "White",
    "Blue",
    "Colorless",
    "Multi-WU",
    "zMulti-UW",
    "a multi-pip BBW",
    "z multi-pip WBB",
    "Multi-WG",
    "a multi-pip WBG",
    "a multi-pip BUG",
  ]);
});

Deno.test("sortCards: rarity common to mythic, missing pushed to end", () => {
  const cards = [
    card({ name: "NoRarity" }),
    card({ name: "Mythic", rarity: "mythic" }),
    card({ name: "Common", rarity: "common" }),
  ];
  assertEquals(sortCards(cards, crit("rarity")).map((c) => c.name), [
    "Common",
    "Mythic",
    "NoRarity",
  ]);
});

Deno.test("sortCards: multi-criteria color, then cmc, then name tiebreak", () => {
  const cards = [
    card({ name: "Zeta", colors: ["W"], cmc: 2 }),
    card({ name: "Alpha", colors: ["W"], cmc: 2 }),
    card({ name: "Beta", colors: ["W"], cmc: 1 }),
    card({ name: "Gamma", colors: ["U"], cmc: 1 }),
  ];
  const criteria: SortCriterion[] = [
    { method: "color", direction: "asc" },
    { method: "cmc", direction: "asc" },
    { method: "name", direction: "asc" },
  ];
  assertEquals(sortCards(cards, criteria).map((c) => c.name), [
    "Beta", // W, cmc 1
    "Alpha", // W, cmc 2, name tiebreak
    "Zeta",
    "Gamma", // U sorts after W in WUBRG order
  ]);
});

Deno.test("sortCards: empty criteria falls back to name tiebreak", () => {
  const cards = [card({ name: "Zebra" }), card({ name: "Apple" })];
  assertEquals(sortCards(cards, []).map((c) => c.name), ["Apple", "Zebra"]);
});

Deno.test("sortCards: does not mutate input array", () => {
  const cards = [card({ name: "B" }), card({ name: "A" })];
  const original = [...cards];
  sortCards(cards, crit("name"));
  assertEquals(cards, original);
});
