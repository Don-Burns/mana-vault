/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import { buildMergeSlots, type MergeCard, type MergePanel } from "../src/ui/merge-view.ts";
import { DEFAULT_SORT_CRITERIA } from "../src/collection/sort.ts";

function card(id: string, name: string, quantity: number): MergeCard {
  return {
    scryfallId: id,
    name,
    setCode: "aaa",
    collectorNumber: "1",
    quantity,
    cmc: 0,
    colors: [],
    rarity: "common",
  };
}

// Names sorted alphabetically match ids a..j for predictable ordering.
function folder(cards: MergeCard[]) {
  return cards;
}

Deno.test("buildMergeSlots: staging rows and target rows share the same slot for a match", () => {
  const staging = [card("b", "b", 1)];
  const before = folder([card("a", "a", 1), card("b", "b", 0), card("c", "c", 1)]);
  const after = folder([card("a", "a", 1), card("b", "b", 1), card("c", "c", 1)]);
  const panels: MergePanel[] = [{ title: "Folder", before, after }];

  const { slots, masterKeys } = buildMergeSlots(staging, panels, DEFAULT_SORT_CRITERIA);

  // b is changed (added), a and c are within CONTEXT_SIZE (2) so all three kept, no ellipsis.
  assertEquals(slots.every((s) => s.type === "row"), true);
  const bSlotIndex = slots.findIndex((s) => s.type === "row" && masterKeys[s.index] === "b");
  assertEquals(bSlotIndex, 1); // a, b, c alphabetical -> b is index 1
});

Deno.test("buildMergeSlots: far unchanged rows collapse into a single shared ellipsis slot", () => {
  const staging = [card("a", "a", 5)];
  // a..h unchanged padding, only "a" changes; i is far (>2) from "a" in sorted order.
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const before = ids.map((id) => card(id, id, 1));
  const after = ids.map((id) => id === "a" ? card(id, id, 5) : card(id, id, 1));
  const panels: MergePanel[] = [{ title: "Folder", before, after }];

  const { slots, masterKeys } = buildMergeSlots(staging, panels, DEFAULT_SORT_CRITERIA);

  // Expect: a,b,c kept (change + 2 context), then a single ellipsis for d..i.
  const rowKeys = slots.filter((s) => s.type === "row").map((s) => masterKeys[(s as { index: number }).index]);
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
  const { slots, masterKeys } = buildMergeSlots(staging, panels, DEFAULT_SORT_CRITERIA);
  const rowKeys = slots.filter((s) => s.type === "row").map((s) => masterKeys[(s as { index: number }).index]);
  assertEquals(rowKeys.includes("z"), true);
});
