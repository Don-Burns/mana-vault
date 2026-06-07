/**
 * Service Worker
 *
 * Caching strategy:
 * - App shell (HTML, CSS, JS): Cache-first, update in background
 * - OpenCV WASM: Cache-first (rarely changes)
 * - Hash DB: Cache-first with manual update check
 * - API calls: Network-first with cache fallback
 */

const CACHE_NAME = "mtg-scanner-v1";
const DB_CACHE_NAME = "mtg-scanner-db-v1";

// App shell files to pre-cache on install
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon.svg",
];

// Install: pre-cache app shell
self.addEventListener("install", (event: any) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    }),
  );
  // Activate immediately
  (self as any).skipWaiting();
});

// Activate: clean up old caches
self.addEventListener("activate", (event: any) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== DB_CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
    }),
  );
  // Take control of all pages immediately
  (self as any).clients.claim();
});

// Fetch: routing strategy
self.addEventListener("fetch", (event: any) => {
  const url = new URL(event.request.url);

  // Hash DB and metadata: cache-first (large, rarely changes)
  if (url.pathname.startsWith("/db/")) {
    event.respondWith(cacheFirst(event.request, DB_CACHE_NAME));
    return;
  }

  // OpenCV WASM: cache-first
  if (url.pathname.includes("opencv") || url.pathname.endsWith(".wasm")) {
    event.respondWith(cacheFirst(event.request, CACHE_NAME));
    return;
  }

  // App assets (JS, CSS): stale-while-revalidate
  if (
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".svg")
  ) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // HTML: network-first (get latest app version)
  if (event.request.mode === "navigate") {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Everything else: network-first
  event.respondWith(networkFirst(event.request));
});

// ─── Caching Strategies ───────────────────────────────────────────

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
  }
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Fetch in background to update cache
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => undefined);

  // Return cached immediately if available, otherwise wait for network
  if (cached) return cached;

  const response = await fetchPromise;
  if (response) return response;

  return new Response("Offline", { status: 503 });
}
