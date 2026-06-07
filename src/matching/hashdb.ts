/**
 * Hash Database Loader
 *
 * Loads and parses the binary hash database file.
 * Provides efficient access to illustration hashes via typed arrays.
 */

export interface HashDBEntry {
  illustrationId: string;
  pHash: bigint;
  dHash: bigint;
}

export class HashDB {
  private pHashes: BigUint64Array;
  private dHashes: BigUint64Array;
  private illustrationIds: string[];
  private _size: number;

  private constructor(
    pHashes: BigUint64Array,
    dHashes: BigUint64Array,
    illustrationIds: string[],
  ) {
    this.pHashes = pHashes;
    this.dHashes = dHashes;
    this.illustrationIds = illustrationIds;
    this._size = illustrationIds.length;
  }

  /**
   * Load hash database from a binary file fetched from the network or cache.
   */
  static async load(url: string): Promise<HashDB> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load hash DB: ${response.status} ${response.statusText}`);
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
    if (version !== 1) {
      throw new Error(`Unsupported hash DB version: ${version}`);
    }

    const entryCount = view.getUint32(6);
    const hashSize = view.getUint16(10);

    if (hashSize !== 8) {
      throw new Error(`Unsupported hash size: ${hashSize} (expected 8)`);
    }

    const HEADER_SIZE = 16;
    const ENTRY_SIZE = 32;

    // Parse entries
    const pHashes = new BigUint64Array(entryCount);
    const dHashes = new BigUint64Array(entryCount);
    const illustrationIds: string[] = [];

    for (let i = 0; i < entryCount; i++) {
      const offset = HEADER_SIZE + i * ENTRY_SIZE;

      // Read illustration_id (16 bytes → UUID string)
      const idBytes = bytes.slice(offset, offset + 16);
      const id = bytesToUUID(idBytes);
      illustrationIds.push(id);

      // Read pHash (8 bytes big-endian)
      pHashes[i] = readBigUint64(view, offset + 16);

      // Read dHash (8 bytes big-endian)
      dHashes[i] = readBigUint64(view, offset + 24);
    }

    return new HashDB(pHashes, dHashes, illustrationIds);
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
    };
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
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function readBigUint64(view: DataView, offset: number): bigint {
  const high = BigInt(view.getUint32(offset));
  const low = BigInt(view.getUint32(offset + 4));
  return (high << 32n) | low;
}
