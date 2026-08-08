/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getCardImageUrl } from "./card-image.ts";

// ponytail: fetch is stubbed globally per test since this project has no
// Vite-aware DOM/fetch test harness.

Deno.test("getCardImageUrl returns the local art path when it exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL) => {
    if (String(url).includes("scryfall")) {
      throw new Error("should not call remote");
    }
    return Promise.resolve(
      new Response(null, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
  }) as typeof fetch;
  try {
    const url = await getCardImageUrl("00000000-0000-0000-0000-000000000000");
    assertEquals(
      url,
      "/art/00000000-0000-0000-0000-000000000000.jpg",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("getCardImageUrl falls back to Scryfall when the local path 200s with non-image content (e.g. dev-server/SPA-fallback HTML)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL) => {
    if (String(url).includes("scryfall")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{
              image_uris: { normal: "https://cards.scryfall.io/x.jpg" },
            }],
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(null, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
  }) as typeof fetch;
  try {
    const url = await getCardImageUrl("spa-fallback");
    assertEquals(url, "https://cards.scryfall.io/x.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("getCardImageUrl falls back to Scryfall when local art 404s", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL) => {
    if (String(url).includes("scryfall")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{
              image_uris: { normal: "https://cards.scryfall.io/x.jpg" },
            }],
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch;
  try {
    const url = await getCardImageUrl("has-remote");
    assertEquals(url, "https://cards.scryfall.io/x.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("getCardImageUrl returns undefined when neither source has the image", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch;
  try {
    const url = await getCardImageUrl("missing-everywhere");
    assertEquals(url, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
