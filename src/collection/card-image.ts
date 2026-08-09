/// <reference types="npm:vite/client" />

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

  return remoteCardImageUrl(scryfallId);
}
