/// <reference types="npm:vite/client" />

// Direct hit on Scryfall's image CDN (no api.scryfall.com round-trip/redirect),
// per https://scryfall.com/docs/api/images — sharded by the id's first two
// hex chars. The existing onerror handler already blanks the thumbnail on 404.
function remoteCardImageUrl(scryfallId: string): string {
  const [a, b] = scryfallId;
  return `https://cards.scryfall.io/border_crop/front/${a}/${b}/${scryfallId}.jpg`;
}

/**
 * Returns the URL for a card's image from Scryfall's CDN for the exact
 * printing, keyed by `scryfallId` so the image always matches the exact
 * set/collector number, even after a user correction. Returns `undefined`
 * if `scryfallId` is missing, so callers can show a blank placeholder.
 */
export async function getCardImageUrl(
  scryfallId: string,
): Promise<string | undefined> {
  if (!scryfallId) return undefined;

  return remoteCardImageUrl(scryfallId);
}
