/**
 * Hash Database Loader
 *
 * Loads and parses the binary hash database file.
 * Provides efficient access to illustration hashes via typed arrays.
 *
 * Each illustration carries two hash pairs, which the matcher searches
 * independently because they fail in different ways:
 *
 *   - ART hashes (from Scryfall's art_crop) are invariant to frame treatment,
 *     set symbol and language, so they match a printing whose frame differs
 *     from the one captured in the bulk data.
 *   - FULL-CARD hashes (from the whole card image) need no art-region crop, so
 *     they handle showcase / borderless / extended-art layouts where no fixed
 *     percentage rectangle reliably frames the art.
 *
 * Version 1 files carry only the art hashes; they still load, and
 * `hasFullCardHashes` reports false so callers can skip the full-card space.
 */

export interface HashDBEntry {
  illustrationId: string;
  pHash: bigint;
  dHash: bigint;
  fullPHash: bigint;
  fullDHash: bigint;
}

export class HashDB {
  private pHashes: BigUint64Array;
  private dHashes: BigUint64Array;
  private fullPHashes: BigUint64Array;
  private fullDHashes: BigUint64Array;
  private illustrationIds: string[];
  private _size: number;
  private _hasFullCardHashes: boolean;

  private constructor(
    pHashes: BigUint64Array,
    dHashes: BigUint64Array,
    fullPHashes: BigUint64Array,
    fullDHashes: BigUint64Array,
    illustrationIds: string[],
    hasFullCardHashes: boolean,
  ) {
    this.pHashes = pHashes;
    this.dHashes = dHashes;
    this.fullPHashes = fullPHashes;
    this.fullDHashes = fullDHashes;
    this.illustrationIds = illustrationIds;
    this._size = illustrationIds.length;
    this._hasFullCardHashes = hasFullCardHashes;
  }

  /**
   * Load hash database from a binary file fetched from the network or cache.
   */
  static async load(url: string): Promise<HashDB> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to load hash DB: ${response.status} ${response.statusText}`,
      );
    }

    const buffer = await response.arrayBuffer();
    return HashDB.fromBuffer(buffer);
  }

  /**
   * Parse a hash database from an ArrayBuffer.
   */
  static fromBuffer(buffer: ArrayBuffer): HashDB {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Verify magic
    const magic = new TextDecoder().decode(bytes.slice(0, 4));
    if (magic !== "MTGH") {
      throw new Error(`Invalid hash DB magic: "${magic}" (expected "MTGH")`);
    }

    // Read header
    const version = view.getUint16(4);
    if (version !== 1 && version !== 2) {
      throw new Error(`Unsupported hash DB version: ${version}`);
    }

    const entryCount = view.getUint32(6);
    const hashSize = view.getUint16(10);

    if (hashSize !== 8) {
      throw new Error(`Unsupported hash size: ${hashSize} (expected 8)`);
    }

    const HEADER_SIZE = 16;
    // v1 stored only the art hash pair; v2 appends the full-card pair.
    const hasFullCardHashes = version >= 2;
    const ENTRY_SIZE = hasFullCardHashes ? 48 : 32;

    // Parse entries
    const pHashes = new BigUint64Array(entryCount);
    const dHashes = new BigUint64Array(entryCount);
    const fullPHashes = new BigUint64Array(entryCount);
    const fullDHashes = new BigUint64Array(entryCount);
    const illustrationIds: string[] = [];

    for (let i = 0; i < entryCount; i++) {
      const offset = HEADER_SIZE + i * ENTRY_SIZE;

      // Read illustration_id (16 bytes → UUID string)
      const idBytes = bytes.slice(offset, offset + 16);
      const id = bytesToUUID(idBytes);
      illustrationIds.push(id);

      // Art hash pair (8 bytes each, big-endian)
      pHashes[i] = readBigUint64(view, offset + 16);
      dHashes[i] = readBigUint64(view, offset + 24);

      // Full-card hash pair. Left at zero for v1 files, and also zero for v2
      // entries whose full card image was unavailable at build time.
      if (hasFullCardHashes) {
        fullPHashes[i] = readBigUint64(view, offset + 32);
        fullDHashes[i] = readBigUint64(view, offset + 40);
      }
    }

    return new HashDB(
      pHashes,
      dHashes,
      fullPHashes,
      fullDHashes,
      illustrationIds,
      hasFullCardHashes,
    );
  }

  /**
   * Get the number of entries in the database.
   */
  get size(): number {
    return this._size;
  }

  /**
   * Get hashes for a specific index.
   */
  getEntry(index: number): HashDBEntry {
    return {
      illustrationId: this.illustrationIds[index],
      pHash: this.pHashes[index],
      dHash: this.dHashes[index],
      fullPHash: this.fullPHashes[index],
      fullDHash: this.fullDHashes[index],
    };
  }

  /**
   * Whether this database carries full-card hashes (format version 2+).
   * When false, callers should search the art hash space only.
   */
  get hasFullCardHashes(): boolean {
    return this._hasFullCardHashes;
  }

  /**
   * Get the pHash array for bulk operations.
   */
  getPHashes(): BigUint64Array {
    return this.pHashes;
  }

  /**
   * Get the dHash array for bulk operations.
   */
  getDHashes(): BigUint64Array {
    return this.dHashes;
  }

  /**
   * Get the full-card pHash array for bulk operations.
   * All zero when {@link hasFullCardHashes} is false.
   */
  getFullPHashes(): BigUint64Array {
    return this.fullPHashes;
  }

  /**
   * Get the full-card dHash array for bulk operations.
   * All zero when {@link hasFullCardHashes} is false.
   */
  getFullDHashes(): BigUint64Array {
    return this.fullDHashes;
  }

  /**
   * Get illustration ID by index.
   */
  getIllustrationId(index: number): string {
    return this.illustrationIds[index];
  }

  /**
   * Find entries matching a specific illustration_id.
   * Returns the index or -1 if not found.
   */
  findByIllustrationId(id: string): number {
    return this.illustrationIds.indexOf(id);
  }
}

// Utility functions

function bytesToUUID(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Format as UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20, 32)}`;
}

function readBigUint64(view: DataView, offset: number): bigint {
  const high = BigInt(view.getUint32(offset));
  const low = BigInt(view.getUint32(offset + 4));
  return (high << 32n) | low;
}
