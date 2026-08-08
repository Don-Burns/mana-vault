/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import {
  buildMergeSlots,
  type MergeCard,
  type MergePanel,
} from "../src/ui/merge-view.ts";
import { DEFAULT_SORT_CRITERIA } from "../src/collection/sort.ts";

function card(
  id: string,
  name: string,
  quantity: number,
  cmc: number = 0,
  colors: string[] | null = null,
): MergeCard {
  return {
    scryfallId: id,
    name,
    setCode: "aaa",
    collectorNumber: "1",
    quantity,
    cmc: cmc,
    colors: colors || [],
    rarity: "common",
  };
}

// Names sorted alphabetically match ids a..j for predictable ordering.
function folder(cards: MergeCard[]) {
  return cards;
}

Deno.test("buildMergeSlots: staging rows and target rows share the same slot for a match", () => {
  const staging = [card("b", "b", 1)];
  const before = folder([
    card("a", "a", 1),
    card("b", "b", 0),
    card("c", "c", 1),
  ]);
  const after = folder([
    card("a", "a", 1),
    card("b", "b", 1),
    card("c", "c", 1),
  ]);
  const panels: MergePanel[] = [{ title: "Folder", before, after }];

  const { slots, masterKeys } = buildMergeSlots(
    staging,
    panels,
    DEFAULT_SORT_CRITERIA,
  );

  // b is changed (added), a and c are within CONTEXT_SIZE (2) so all three kept, no ellipsis.
  assertEquals(slots.every((s) => s.type === "row"), true);
  const bSlotIndex = slots.findIndex((s) =>
    s.type === "row" && masterKeys[s.index] === "b"
  );
  assertEquals(bSlotIndex, 1); // a, b, c alphabetical -> b is index 1
});

Deno.test("buildMergeSlots: far unchanged rows collapse into a single shared ellipsis slot", () => {
  const staging = [card("a", "a", 5)];
  // a..h unchanged padding, only "a" changes; i is far (>2) from "a" in sorted order.
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const before = ids.map((id) => card(id, id, 1));
  const after = ids.map((id) => id === "a" ? card(id, id, 5) : card(id, id, 1));
  const panels: MergePanel[] = [{ title: "Folder", before, after }];

  const { slots, masterKeys } = buildMergeSlots(
    staging,
    panels,
    DEFAULT_SORT_CRITERIA,
  );

  // Expect: a,b,c kept (change + 2 context), then a single ellipsis for d..i.
  const rowKeys = slots.filter((s) => s.type === "row").map((s) =>
    masterKeys[(s as { index: number }).index]
  );
  assertEquals(rowKeys, ["a", "b", "c"]);
  const ellipsisCount = slots.filter((s) => s.type === "ellipsis").length;
  assertEquals(ellipsisCount, 1);
});

Deno.test("buildMergeSlots: staging-only card keeps its row even if unchanged everywhere else", () => {
  const staging = [card("z", "z", 3)];
  const panels: MergePanel[] = [{
    title: "Folder",
    before: [card("a", "a", 1)],
    after: [card("a", "a", 1)],
  }];
  const { slots, masterKeys } = buildMergeSlots(
    staging,
    panels,
    DEFAULT_SORT_CRITERIA,
  );
  const rowKeys = slots.filter((s) => s.type === "row").map((s) =>
    masterKeys[(s as { index: number }).index]
  );
  assertEquals(rowKeys.includes("z"), true);
});

Deno.test("buildMergeSlots: hideContext drops context rows, keeping only cards in staging", () => {
  const staging = [card("a", "a", 5)];
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const before = ids.map((id) => card(id, id, 1));
  const after = ids.map((id) => id === "a" ? card(id, id, 5) : card(id, id, 1));
  const panels: MergePanel[] = [{ title: "Folder", before, after }];

  const { slots, masterKeys } = buildMergeSlots(
    staging,
    panels,
    DEFAULT_SORT_CRITERIA,
    true,
  );

  const rowKeys = slots.filter((s) => s.type === "row").map((s) =>
    masterKeys[(s as { index: number }).index]
  );
  assertEquals(rowKeys, ["a"]); // b, c context rows dropped, only staging card "a" kept
  assertEquals(slots.some((s) => s.type === "ellipsis"), false); // no "..." placeholder either
});

Deno.test("default merge as expected", () => {
  // default sort should be by colour, cmc then name
  const staging = [
    card("colourless card", "colourless", 1, 1, []),
    card("green card", "green", 1, 1, ["G"]),
    card("in middle", "b", 1, 1, ["W"]),
  ];
  const before = folder([
    card("blue card", "blue", 1, 1, ["U"]),
    card("a", "a", 1, 1, ["W"]),
    card("c", "c", 1, 1, ["W"]),
    card("less cmc", "z", 1, 0, ["W"]),
    card("more cmc", "y", 1, 2, ["W"]),
    card("more cmc", "y", 1, 2, ["W"]),
  ]);
  const after = folder([
    card("less cmc", "z", 1, 0, ["W"]),
    card("d", "d", 1, 1, ["W"]),
    card("c", "c", 1, 1, ["W"]),
    card("blue card", "blue", 1, 1, ["U"]),
    card("more cmc", "y", 1, 2, ["W"]),
    card("a", "a", 1, 1, ["W"]),
    card("in middle", "b", 1, 1, ["W"]),
  ]);

  const expectedFullOrder = [
    "less cmc",
    "a",
    "in middle",
    "c",
    "d",
    "more cmc",
    "blue card",
    "green card",
    "colourless card",
  ];
  const panels: MergePanel[] = [{ title: "Folder", before, after }];

  const { slots, masterKeys } = buildMergeSlots(
    staging,
    panels,
    DEFAULT_SORT_CRITERIA,
  );

  assertEquals(slots.every((s) => s.type === "row"), true);
  const bSlotIndex = slots.findIndex((s) =>
    s.type === "row" && masterKeys[s.index] === "in middle"
  );
  for (const [i, key] of masterKeys.entries()) {
    assertEquals(key, expectedFullOrder[i]);
  }
});
