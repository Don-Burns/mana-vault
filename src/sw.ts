/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/**
 * Service Worker
 *
 * Caching strategy:
 * - App shell (HTML, CSS, JS): Cache-first, update in background
 * - OpenCV WASM: Cache-first (rarely changes)
 * - Hash DB: Cache-first with manual update check
 * - API calls: Network-first with cache fallback
 *
 * Built via vite-plugin-pwa in `injectManifest` mode: the plugin replaces the
 * `self.__WB_MANIFEST` reference below with the list of build-time precache
 * entries. In dev, that list is effectively empty and we fall back to the
 * static APP_SHELL list.
 */

// Injected at build time by vite-plugin-pwa (empty array in dev).
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const CACHE_NAME = "mana-vault-v1";
const DB_CACHE_NAME = "mana-vault-db-v1";

// Base path the SW is scoped to ("/" at the root, "/mtg_scanner_js/" on a
// GitHub Pages project site). Derived from the registration scope so this
// works under any base without a build-time constant.
const BASE_PATH = new URL(self.registration.scope).pathname;

// Static app shell entries always pre-cached on install.
const APP_SHELL = [
  BASE_PATH,
  `${BASE_PATH}index.html`,
  `${BASE_PATH}manifest.json`,
  `${BASE_PATH}icon.svg`,
];

// Build-time precache manifest (hashed JS/CSS assets). Reference it here so
// vite-plugin-pwa's injectManifest step is satisfied; we merge its URLs into
// the app-shell precache.
const WB_MANIFEST = self.__WB_MANIFEST;

// Resolve to absolute URLs before deduping: APP_SHELL entries are already
// base-prefixed absolute paths, but WB_MANIFEST entries are bare relative
// filenames (e.g. "icon.svg"). Deduping the raw strings misses that both
// forms resolve to the same URL, which makes cache.addAll() throw
// InvalidStateError on duplicate requests.
const toAbsoluteUrl = (url: string) => new URL(url, self.registration.scope).href;
const PRECACHE_URLS = [
  ...new Set(
    [...APP_SHELL, ...WB_MANIFEST.map((entry) => entry.url)].map(toAbsoluteUrl),
  ),
];

// In the Vite dev server there is no real precache manifest, so it is empty.
// We use this to switch the SW into a transparent pass-through mode: caching
// Vite's on-the-fly transformed modules / HMR assets / OpenCV WASM would serve
// stale or broken content and break the app (e.g. the OpenCV worker fails to
// initialise). In dev we therefore never intercept fetches.
const IS_DEV = WB_MANIFEST.length === 0;

// Install: pre-cache app shell
self.addEventListener("install", (event: ExtendableEvent) => {
  // Skip precaching entirely in dev (URLs are Vite-transformed, not stable).
  if (!IS_DEV) {
    event.waitUntil(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.addAll(PRECACHE_URLS))
        .catch((err) => {
          console.error("Precache failed:", err);
        }),
    );
  }
  // Activate immediately
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener("activate", (event: ExtendableEvent) => {
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
  self.clients.claim();
});

// Fetch: routing strategy
self.addEventListener("fetch", (event: FetchEvent) => {
  // In dev, stay completely out of the way: let every request hit the Vite
  // dev server directly. Caching dev modules / HMR / OpenCV WASM here would
  // break the app.
  if (IS_DEV) return;

  const url = new URL(event.request.url);

  // Only handle same-origin GET requests; let everything else (cross-origin
  // APIs, non-GET) go straight to the network.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Hash DB and metadata: cache-first (large, rarely changes). The DB build
  // stamps a content hash into version.json and the app requests these with
  // a `?v=<hash>` query string (see fetchVersioned in the app code), so a
  // rebuilt DB is a new cache key rather than silently stuck stale forever.
  // version.json itself must always be fetched fresh — it's how the app
  // discovers that a new hash exists.
  if (
    url.pathname.startsWith(`${BASE_PATH}db/`) &&
    !url.pathname.endsWith("version.json")
  ) {
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

async function cacheFirst(
  request: Request,
  cacheName: string,
): Promise<Response> {
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
    return new Response("Offline", {
      status: 503,
      statusText: "Service Unavailable",
    });
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
