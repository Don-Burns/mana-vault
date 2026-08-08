/// <reference types="npm:vite/client" />

/**
 * Local, offline-only card art path.
 *
 * Resolves to an asset the app itself would ship (a future downloadable
 * offline art pack, see docs/plans/github_pages_deploy.md Phase 4, option B
 * — not built yet). Keyed by `illustrationId` to match
 * `tools/build-hashdb.ts`'s art filenames.
 */
function localCardImageUrl(illustrationId: string): string {
  return `${import.meta.env?.BASE_URL ?? "/"}art/${illustrationId}.jpg`;
}

// Scryfall sends `Cache-Control: public, max-age=...` on this response, so
// the browser's own HTTP cache persists it across calls/reloads — no
// in-memory cache needed here.
async function fetchRemoteCardImageUrl(
  illustrationId: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://api.scryfall.com/cards/search?q=illustration_id%3A${illustrationId}`,
    );
    if (!res.ok) return undefined;
    const { data } = await res.json();
    return data?.[0]?.image_uris?.normal;
  } catch {
    return undefined;
  }
}

/**
 * Returns the URL for a card's image, either local or from a remote source.
 * Prefers the local offline art pack if it exists, falling back to
 * Scryfall's CDN (normal resolution) looked up by `illustrationId`. Returns
 * `undefined` if neither is available, so callers can show a blank
 * placeholder.
 */
export async function getCardImageUrl(
  illustrationId: string,
): Promise<string | undefined> {
  const localUrl = localCardImageUrl(illustrationId);
  try {
    const res = await fetch(localUrl, { method: "HEAD" });
    // `res.ok` alone isn't enough: Vite's dev server (and many static hosts
    // with SPA fallback rewrites) return a 200 `index.html` for *any*
    // unmatched path, including a nonexistent art file. Require an actual
    // image content-type so a missing file correctly falls through to the
    // Scryfall lookup below instead of being treated as "found".
    if (
      res.ok && (res.headers.get("content-type") ?? "").startsWith("image/")
    ) {
      return localUrl;
    }
  } catch {
    // fall through to remote
  }

  return await fetchRemoteCardImageUrl(illustrationId);
}
