/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import { type DiffableCard, computeDiff } from "../src/collection/diff.ts";

function card(scryfallId: string, quantity: number): DiffableCard {
  return { scryfallId, name: scryfallId, setCode: "aaa", collectorNumber: "1", quantity };
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
