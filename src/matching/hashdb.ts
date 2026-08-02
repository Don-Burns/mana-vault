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
  private pHashHighs: Uint32Array;
  private pHashLows: Uint32Array;
  private dHashHighs: Uint32Array;
  private dHashLows: Uint32Array;
  private fullPHashHighs: Uint32Array;
  private fullPHashLows: Uint32Array;
  private fullDHashHighs: Uint32Array;
  private fullDHashLows: Uint32Array;
  private illustrationIds: string[];
  private _size: number;
  private _hasFullCardHashes: boolean;

  private constructor(
    pHashes: BigUint64Array,
    dHashes: BigUint64Array,
    fullPHashes: BigUint64Array,
    fullDHashes: BigUint64Array,
    pHashHighs: Uint32Array,
    pHashLows: Uint32Array,
    dHashHighs: Uint32Array,
    dHashLows: Uint32Array,
    fullPHashHighs: Uint32Array,
    fullPHashLows: Uint32Array,
    fullDHashHighs: Uint32Array,
    fullDHashLows: Uint32Array,
    illustrationIds: string[],
    hasFullCardHashes: boolean,
  ) {
    this.pHashes = pHashes;
    this.dHashes = dHashes;
    this.fullPHashes = fullPHashes;
    this.fullDHashes = fullDHashes;
    this.pHashHighs = pHashHighs;
    this.pHashLows = pHashLows;
    this.dHashHighs = dHashHighs;
    this.dHashLows = dHashLows;
    this.fullPHashHighs = fullPHashHighs;
    this.fullPHashLows = fullPHashLows;
    this.fullDHashHighs = fullDHashHighs;
    this.fullDHashLows = fullDHashLows;
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
    const pHashHighs = new Uint32Array(entryCount);
    const pHashLows = new Uint32Array(entryCount);
    const dHashHighs = new Uint32Array(entryCount);
    const dHashLows = new Uint32Array(entryCount);
    const fullPHashHighs = new Uint32Array(entryCount);
    const fullPHashLows = new Uint32Array(entryCount);
    const fullDHashHighs = new Uint32Array(entryCount);
    const fullDHashLows = new Uint32Array(entryCount);
    const illustrationIds: string[] = [];

    for (let i = 0; i < entryCount; i++) {
      const offset = HEADER_SIZE + i * ENTRY_SIZE;

      // Read illustration_id (16 bytes → UUID string)
      const idBytes = bytes.slice(offset, offset + 16);
      const id = bytesToUUID(idBytes);
      illustrationIds.push(id);

      // Art hash pair (8 bytes each, big-endian)
      const pHigh = view.getUint32(offset + 16);
      const pLow = view.getUint32(offset + 20);
      const dHigh = view.getUint32(offset + 24);
      const dLow = view.getUint32(offset + 28);

      pHashHighs[i] = pHigh;
      pHashLows[i] = pLow;
      dHashHighs[i] = dHigh;
      dHashLows[i] = dLow;

      pHashes[i] = combineToBigUint64(pHigh, pLow);
      dHashes[i] = combineToBigUint64(dHigh, dLow);

      // Full-card hash pair. Left at zero for v1 files, and also zero for v2
      // entries whose full card image was unavailable at build time.
      if (hasFullCardHashes) {
        const fullPHigh = view.getUint32(offset + 32);
        const fullPLow = view.getUint32(offset + 36);
        const fullDHigh = view.getUint32(offset + 40);
        const fullDLow = view.getUint32(offset + 44);

        fullPHashHighs[i] = fullPHigh;
        fullPHashLows[i] = fullPLow;
        fullDHashHighs[i] = fullDHigh;
        fullDHashLows[i] = fullDLow;

        fullPHashes[i] = combineToBigUint64(fullPHigh, fullPLow);
        fullDHashes[i] = combineToBigUint64(fullDHigh, fullDLow);
      }
    }

    return new HashDB(
      pHashes,
      dHashes,
      fullPHashes,
      fullDHashes,
      pHashHighs,
      pHashLows,
      dHashHighs,
      dHashLows,
      fullPHashHighs,
      fullPHashLows,
      fullDHashHighs,
      fullDHashLows,
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
   * Get art pHash upper 32-bit words for fast popcount matching.
   */
  getPHashHighs(): Uint32Array {
    return this.pHashHighs;
  }

  /**
   * Get art pHash lower 32-bit words for fast popcount matching.
   */
  getPHashLows(): Uint32Array {
    return this.pHashLows;
  }

  /**
   * Get art dHash upper 32-bit words for fast popcount matching.
   */
  getDHashHighs(): Uint32Array {
    return this.dHashHighs;
  }

  /**
   * Get art dHash lower 32-bit words for fast popcount matching.
   */
  getDHashLows(): Uint32Array {
    return this.dHashLows;
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
   * Get full-card pHash upper 32-bit words for fast popcount matching.
   */
  getFullPHashHighs(): Uint32Array {
    return this.fullPHashHighs;
  }

  /**
   * Get full-card pHash lower 32-bit words for fast popcount matching.
   */
  getFullPHashLows(): Uint32Array {
    return this.fullPHashLows;
  }

  /**
   * Get full-card dHash upper 32-bit words for fast popcount matching.
   */
  getFullDHashHighs(): Uint32Array {
    return this.fullDHashHighs;
  }

  /**
   * Get full-card dHash lower 32-bit words for fast popcount matching.
   */
  getFullDHashLows(): Uint32Array {
    return this.fullDHashLows;
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

function combineToBigUint64(high: number, low: number): bigint {
  return (BigInt(high) << 32n) | BigInt(low);
}
