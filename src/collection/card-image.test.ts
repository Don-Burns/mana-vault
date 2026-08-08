/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getCardImageUrl } from "./card-image.ts";

// ponytail: fetch is stubbed globally per test since this project has no
// Vite-aware DOM/fetch test harness.

Deno.test("getCardImageUrl returns the local art path when it exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(null, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    )) as typeof fetch;
  try {
    const url = await getCardImageUrl("abc-123");
    assertEquals(url, "/art/abc-123.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("getCardImageUrl falls back to Scryfall when the local path 200s with non-image content (e.g. dev-server/SPA-fallback HTML)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(null, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    )) as typeof fetch;
  try {
    const url = await getCardImageUrl("abc-123");
    assertEquals(
      url,
      "https://api.scryfall.com/cards/abc-123?format=image&version=border_crop",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("getCardImageUrl falls back to Scryfall when local art 404s", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch;
  try {
    const url = await getCardImageUrl("abc-123");
    assertEquals(
      url,
      "https://api.scryfall.com/cards/abc-123?format=image&version=border_crop",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("getCardImageUrl returns undefined when there's no scryfallId", async () => {
  const url = await getCardImageUrl("");
  assertEquals(url, undefined);
});
