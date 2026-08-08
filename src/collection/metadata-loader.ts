/**
 * Shared, cached loader for the bundled card metadata (public/db/metadata.json).
 *
 * Parses the ~14 MB file in a worker (off the main thread) exactly once and
 * caches the result so every view that needs it (scanner, collection) can
 * call `loadMetadata()` without re-fetching/re-parsing.
 */

import type { CardMetadata } from "./card-search.ts";

let cached: Promise<CardMetadata | null> | null = null;

export function loadMetadata(): Promise<CardMetadata | null> {
  if (!cached) {
    cached = new Promise<CardMetadata | null>((resolve) => {
      const worker = new Worker(
        new URL("../workers/metadata-worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = (e: MessageEvent) => {
        resolve(
          e.data?.type === "ready" ? e.data.metadata as CardMetadata : null,
        );
        worker.terminate();
      };
      worker.onerror = () => {
        resolve(null);
        worker.terminate();
      };
    });
  }
  return cached;
}
