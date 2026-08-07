/// <reference lib="webworker" />

/**
 * Metadata Worker
 *
 * Fetches and parses metadata.json (~14 MB) off the main thread. JSON.parse
 * for a file this size takes long enough to jank the UI if done inline, so we
 * do it here and hand back the already-parsed object once. Independent of the
 * detection worker (OpenCV + hash DB) since metadata is also needed for the
 * manual "Add Card" search, which shouldn't wait on OpenCV init.
 */
declare const self: DedicatedWorkerGlobalScope;
import { versionedDbUrl } from "./db-version.ts";

versionedDbUrl("metadata.json")
  .then((url) => fetch(url))
  .then((r) => r.json())
  .then((metadata) => self.postMessage({ type: "ready", metadata }))
  .catch((err) =>
    self.postMessage({ type: "error", error: (err as Error).message })
  );
