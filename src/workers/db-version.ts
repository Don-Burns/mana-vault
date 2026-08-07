/// <reference types="npm:vite/client" />

/**
 * Resolve a DB asset URL with a cache-busting `?v=<hash>` query param, read
 * from public/db/version.json (written by tools/build-hashdb.ts). Falls back
 * to the bare path if version.json is missing (e.g. no DB built yet) so
 * `hash-db.bin` / `metadata.json` fetches still get their own "not found"
 * error rather than failing on the version lookup.
 */
export async function versionedDbUrl(path: string): Promise<string> {
  const base = import.meta.env.BASE_URL;
  try {
    const res = await fetch(`${base}db/version.json`);
    const { v } = await res.json() as { v: string };
    return `${base}db/${path}?v=${v}`;
  } catch {
    return `${base}db/${path}`;
  }
}
