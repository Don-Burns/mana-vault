/// <reference types="npm:vite/client" />

/**
 * Local, offline-only card art path.
 *
 * No network hotlink to any external CDN — this only ever resolves to an
 * asset the app itself would ship (a future downloadable offline art pack,
 * see docs/plans/github_pages_deploy.md Phase 4, option B — not built yet).
 * Keyed by `illustrationId` to match `tools/build-hashdb.ts`'s art filenames.
 * Until that pack exists this always 404s, which is intentional: callers
 * must handle the missing-image case (e.g. an `<img onerror>` swap to a
 * blank placeholder) rather than assume the art is present.
 */
export function localCardImageUrl(illustrationId: string): string {
  return `${import.meta.env.BASE_URL}art/${illustrationId}.jpg`;
}
