/// <reference types="npm:vite/client" />

/**
 * Local, offline-only card art path.
 *
 * Resolves to an asset the app itself would ship (a future downloadable
 * offline art pack, see docs/plans/github_pages_deploy.md Phase 4, option B
 * — not built yet). Keyed by `scryfallId` so it points at the exact
 * printing, matching the remote fallback below.
 */
function localCardImageUrl(scryfallId: string): string {
  return `${import.meta.env?.BASE_URL ?? "/"}art/${scryfallId}.jpg`;
}

// Direct redirect to the exact printing's image — no fetch/JSON round-trip
// needed, the browser's <img> request follows the 302 itself, and the
// existing onerror handler already blanks the thumbnail if it 404s.
function remoteCardImageUrl(scryfallId: string): string {
  return `https://api.scryfall.com/cards/${scryfallId}?format=image&version=border_crop`;
}

/**
 * Returns the URL for a card's image, either local or from a remote source.
 * Prefers the local offline art pack if it exists, falling back to
 * Scryfall's CDN for the exact printing. Both are keyed by `scryfallId` so
 * the image always matches the exact set/collector number, even after a
 * user correction. Returns `undefined` if `scryfallId` is missing, so
 * callers can show a blank placeholder.
 */
export async function getCardImageUrl(
  scryfallId: string,
): Promise<string | undefined> {
  if (!scryfallId) return undefined;

  const localUrl = localCardImageUrl(scryfallId);
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

  return remoteCardImageUrl(scryfallId);
}
