/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import {
  clampToSource,
  computeDiff,
  type DiffableCard,
  findMatch,
  type MatchableCard,
  simulateAdd,
  simulateRemove,
} from "../src/collection/diff.ts";

function card(scryfallId: string, quantity: number): DiffableCard {
  return { scryfallId, name: scryfallId, setCode: "aaa", collectorNumber: "1", quantity };
}

function matchableCard(
  scryfallId: string,
  illustrationId: string,
  quantity: number,
): MatchableCard {
  return { ...card(scryfallId, quantity), illustrationId };
}

Deno.test("computeDiff: full add", () => {
  const rows = computeDiff([], [card("a", 2)]);
  assertEquals(rows, [{ card: card("a", 2), before: 0, after: 2, kind: "added" }]);
});

Deno.test("computeDiff: full remove", () => {
  const rows = computeDiff([card("a", 2)], []);
  assertEquals(rows, [{ card: card("a", 2), before: 2, after: 0, kind: "removed" }]);
});

Deno.test("computeDiff: quantity increase", () => {
  const rows = computeDiff([card("a", 2)], [card("a", 5)]);
  assertEquals(rows, [{ card: card("a", 5), before: 2, after: 5, kind: "increased" }]);
});

Deno.test("computeDiff: quantity decrease", () => {
  const rows = computeDiff([card("a", 5)], [card("a", 2)]);
  assertEquals(rows, [{ card: card("a", 2), before: 5, after: 2, kind: "decreased" }]);
});

Deno.test("computeDiff: unchanged", () => {
  const rows = computeDiff([card("a", 2)], [card("a", 2)]);
  assertEquals(rows, [{ card: card("a", 2), before: 2, after: 2, kind: "unchanged" }]);
});

Deno.test("computeDiff: mixed set", () => {
  const rows = computeDiff(
    [card("a", 2), card("b", 3), card("c", 1)],
    [card("a", 2), card("b", 5), card("d", 1)],
  );
  const byId = Object.fromEntries(rows.map((r) => [r.card.scryfallId, r.kind]));
  assertEquals(byId, { a: "unchanged", b: "increased", c: "removed", d: "added" });
});

Deno.test("findMatch: exact scryfallId match", () => {
  const cards = [matchableCard("a", "illus-a", 2), matchableCard("b", "illus-b", 3)];
  const found = findMatch(cards, { scryfallId: "b", illustrationId: "illus-b" });
  assertEquals(found, cards[1]);
});

Deno.test("findMatch: falls back to illustrationId when scryfallId doesn't match", () => {
  const cards = [matchableCard("a", "illus-a", 2)];
  const found = findMatch(cards, { scryfallId: "different-printing", illustrationId: "illus-a" });
  assertEquals(found, cards[0]);
});

Deno.test("findMatch: no match returns undefined", () => {
  const cards = [matchableCard("a", "illus-a", 2)];
  const found = findMatch(cards, { scryfallId: "x", illustrationId: "illus-x" });
  assertEquals(found, undefined);
});

Deno.test("simulateAdd: merges quantity into an existing scryfallId match", () => {
  const cards = [matchableCard("a", "illus-a", 2)];
  const after = simulateAdd(cards, [{ scryfallId: "a", quantity: 3 }], () => {
    throw new Error("makeNew should not be called for a match");
  });
  assertEquals(after, [matchableCard("a", "illus-a", 5)]);
});

Deno.test("simulateAdd: calls makeNew for an unmatched item", () => {
  const after = simulateAdd(
    [] as MatchableCard[],
    [{ scryfallId: "new", quantity: 4 }],
    (item) => matchableCard(item.scryfallId, "illus-new", item.quantity),
  );
  assertEquals(after, [matchableCard("new", "illus-new", 4)]);
});

Deno.test("simulateAdd: does not mutate the input card list", () => {
  const cards = [matchableCard("a", "illus-a", 2)];
  simulateAdd(cards, [{ scryfallId: "a", quantity: 3 }], () => {
    throw new Error("unreachable");
  });
  assertEquals(cards[0].quantity, 2);
});

Deno.test("simulateRemove: decrements a matched entry", () => {
  const cards = [matchableCard("a", "illus-a", 5)];
  const after = simulateRemove(cards, [
    { scryfallId: "a", illustrationId: "illus-a", quantity: 2 },
  ]);
  assertEquals(after, [matchableCard("a", "illus-a", 3)]);
});

Deno.test("simulateRemove: drops a row that reaches zero", () => {
  const cards = [matchableCard("a", "illus-a", 2)];
  const after = simulateRemove(cards, [
    { scryfallId: "a", illustrationId: "illus-a", quantity: 2 },
  ]);
  assertEquals(after, []);
});

Deno.test("simulateRemove: clamps at zero rather than going negative", () => {
  const cards = [matchableCard("a", "illus-a", 2)];
  const after = simulateRemove(cards, [
    { scryfallId: "a", illustrationId: "illus-a", quantity: 10 },
  ]);
  assertEquals(after, []);
});

Deno.test("simulateRemove: matches via illustrationId fallback", () => {
  const cards = [matchableCard("printing-in-folder", "illus-a", 5)];
  const after = simulateRemove(cards, [
    { scryfallId: "different-printing", illustrationId: "illus-a", quantity: 2 },
  ]);
  assertEquals(after, [matchableCard("printing-in-folder", "illus-a", 3)]);
});

Deno.test("simulateRemove: silently skips an unmatched item, leaving cards untouched", () => {
  const cards = [matchableCard("a", "illus-a", 5)];
  const after = simulateRemove(cards, [
    { scryfallId: "x", illustrationId: "illus-x", quantity: 2 },
  ]);
  assertEquals(after, cards);
});

Deno.test("clampToSource: caps quantity at what's available", () => {
  const source = [matchableCard("a", "illus-a", 3)];
  const result = clampToSource(source, [
    { scryfallId: "a", illustrationId: "illus-a", quantity: 10 },
  ]);
  assertEquals(result, [matchableCard("a", "illus-a", 3)]);
});

Deno.test("clampToSource: passes through quantity unchanged when enough is available", () => {
  const source = [matchableCard("a", "illus-a", 10)];
  const result = clampToSource(source, [
    { scryfallId: "a", illustrationId: "illus-a", quantity: 3 },
  ]);
  assertEquals(result, [matchableCard("a", "illus-a", 3)]);
});

Deno.test("clampToSource: drops items with no match in the source", () => {
  const source = [matchableCard("a", "illus-a", 10)];
  const result = clampToSource(source, [
    { scryfallId: "x", illustrationId: "illus-x", quantity: 3 },
  ]);
  assertEquals(result, []);
});

Deno.test("clampToSource: uses the matched entry's own fields, not the item's", () => {
  // Item references a different (unowned) printing of the same illustration;
  // the folder actually holds `printing-in-folder`.
  const source = [matchableCard("printing-in-folder", "illus-a", 10)];
  const result = clampToSource(source, [
    { scryfallId: "different-printing", illustrationId: "illus-a", quantity: 3 },
  ]);
  assertEquals(result, [matchableCard("printing-in-folder", "illus-a", 3)]);
});

