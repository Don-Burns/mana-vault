/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getCardImageUrl } from "./card-image.ts";

Deno.test("getCardImageUrl builds a direct Scryfall CDN URL", async () => {
  const url = await getCardImageUrl("abc-123");
  assertEquals(
    url,
    "https://cards.scryfall.io/border_crop/front/a/b/abc-123.jpg",
  );
});

Deno.test("getCardImageUrl returns undefined when there's no scryfallId", async () => {
  const url = await getCardImageUrl("");
  assertEquals(url, undefined);
});
