/// <reference lib="deno.ns" />

/**
 * Matcher Microbenchmark
 *
 * Compares the legacy BigInt/Kernighan Hamming loop against the current
 * 32-bit popcount implementation on the real hash database.
 *
 * Usage:
 *   deno run -A tools/bench-matcher.ts
 *   deno run -A tools/bench-matcher.ts --queries=64 --rounds=5 --space=both
 */

import { HashDB } from "../src/matching/hashdb.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

type Space = "art" | "full" | "both";

interface Config {
  queries: number;
  rounds: number;
  space: Space;
  dbPath: string;
}

interface Query {
  pHash: bigint;
  dHash: bigint;
  pHigh: number;
  pLow: number;
  dHigh: number;
  dLow: number;
}

interface HashView {
  label: "art" | "full";
  pHashes: BigUint64Array;
  dHashes: BigUint64Array;
  pHashHighs: Uint32Array;
  pHashLows: Uint32Array;
  dHashHighs: Uint32Array;
  dHashLows: Uint32Array;
}

function parseArgs(): Config {
  const cfg: Config = {
    queries: 64,
    rounds: 5,
    space: "both",
    dbPath: join(Deno.cwd(), "data", "output", "hash-db.bin"),
  };

  for (const arg of Deno.args) {
    const [k, v] = arg.split("=", 2);
    if (!v) continue;
    if (k === "--queries") cfg.queries = Math.max(1, Number(v) | 0);
    if (k === "--rounds") cfg.rounds = Math.max(1, Number(v) | 0);
    if (k === "--db") cfg.dbPath = v;
    if (k === "--space" && (v === "art" || v === "full" || v === "both")) {
      cfg.space = v;
    }
  }

  return cfg;
}

function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x5555_5555);
  x = (x & 0x3333_3333) + ((x >>> 2) & 0x3333_3333);
  x = (x + (x >>> 4)) & 0x0F0F_0F0F;
  x = x + (x >>> 8);
  x = x + (x >>> 16);
  return x & 0x3F;
}

function hammingDistance64(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor !== 0n) {
    xor &= xor - 1n;
    count++;
  }
  return count;
}

function buildQueries(
  view: HashView,
  count: number,
): Query[] {
  const usable: number[] = [];
  for (let i = 0; i < view.pHashes.length; i++) {
    if (view.pHashes[i] !== 0n || view.dHashes[i] !== 0n) usable.push(i);
  }

  if (usable.length === 0) {
    throw new Error(`No usable ${view.label} hashes in DB.`);
  }

  const out: Query[] = [];
  let seed = 0x9E37_79B9;
  for (let i = 0; i < count; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const idx = usable[seed % usable.length];
    const pHash = view.pHashes[idx];
    const dHash = view.dHashes[idx];
    out.push({
      pHash,
      dHash,
      pHigh: Number(pHash >> 32n) >>> 0,
      pLow: Number(pHash & 0xFFFF_FFFFn) >>> 0,
      dHigh: Number(dHash >> 32n) >>> 0,
      dLow: Number(dHash & 0xFFFF_FFFFn) >>> 0,
    });
  }
  return out;
}

function scanLegacy(view: HashView, query: Query): number {
  let hits = 0;
  for (let i = 0; i < view.pHashes.length; i++) {
    const p = view.pHashes[i];
    const d = view.dHashes[i];
    if (p === 0n && d === 0n) continue;

    const pDist = hammingDistance64(query.pHash, p);
    const dDist = hammingDistance64(query.dHash, d);
    const combined = pDist * 0.6 + dDist * 0.4;
    if (combined < 25) hits++;
  }
  return hits;
}

function scanPopcount(view: HashView, query: Query): number {
  let hits = 0;
  for (let i = 0; i < view.pHashHighs.length; i++) {
    const p = view.pHashes[i];
    const d = view.dHashes[i];
    if (p === 0n && d === 0n) continue;

    const pDist = popcount32(query.pHigh ^ view.pHashHighs[i]) +
      popcount32(query.pLow ^ view.pHashLows[i]);
    const dDist = popcount32(query.dHigh ^ view.dHashHighs[i]) +
      popcount32(query.dLow ^ view.dHashLows[i]);
    const combined = pDist * 0.6 + dDist * 0.4;
    if (combined < 25) hits++;
  }
  return hits;
}

function bench(
  label: string,
  fn: (view: HashView, query: Query) => number,
  view: HashView,
  queries: Query[],
  rounds: number,
): { ms: number; hits: number } {
  let hits = 0;
  const t0 = performance.now();
  for (let r = 0; r < rounds; r++) {
    for (const q of queries) hits += fn(view, q);
  }
  return { ms: performance.now() - t0, hits };
}

function hashView(db: HashDB, label: "art" | "full"): HashView {
  if (label === "full") {
    return {
      label,
      pHashes: db.getFullPHashes(),
      dHashes: db.getFullDHashes(),
      pHashHighs: db.getFullPHashHighs(),
      pHashLows: db.getFullPHashLows(),
      dHashHighs: db.getFullDHashHighs(),
      dHashLows: db.getFullDHashLows(),
    };
  }

  return {
    label,
    pHashes: db.getPHashes(),
    dHashes: db.getDHashes(),
    pHashHighs: db.getPHashHighs(),
    pHashLows: db.getPHashLows(),
    dHashHighs: db.getDHashHighs(),
    dHashLows: db.getDHashLows(),
  };
}

function formatRate(comparisons: number, ms: number): string {
  const perSec = (comparisons / ms) * 1000;
  return `${(perSec / 1_000_000).toFixed(2)}M comparisons/s`;
}

async function main() {
  const cfg = parseArgs();
  const buf = await Deno.readFile(cfg.dbPath);
  const db = HashDB.fromBuffer(buf.buffer);

  const spaces: ("art" | "full")[] = cfg.space === "both"
    ? ["art", "full"]
    : [cfg.space];

  console.log(`DB: ${cfg.dbPath}`);
  console.log(`entries: ${db.size}  queries: ${cfg.queries}  rounds: ${cfg.rounds}`);
  console.log("");

  for (const space of spaces) {
    if (space === "full" && !db.hasFullCardHashes) {
      console.log("full: skipped (DB has no full-card hashes)");
      continue;
    }

    const view = hashView(db, space);
    const queries = buildQueries(view, cfg.queries);
    const comparisons = db.size * cfg.queries * cfg.rounds;

    // Warm-up to stabilize JIT.
    bench("warmup-legacy", scanLegacy, view, queries, 1);
    bench("warmup-popcount", scanPopcount, view, queries, 1);

    const legacy = bench("legacy", scanLegacy, view, queries, cfg.rounds);
    const fast = bench("popcount", scanPopcount, view, queries, cfg.rounds);

    // Safety check: both algorithms must classify hits identically.
    if (legacy.hits !== fast.hits) {
      throw new Error(
        `${space}: mismatch in hit counts (legacy=${legacy.hits}, popcount=${fast.hits})`,
      );
    }

    const speedup = legacy.ms / fast.ms;
    console.log(`${space.toUpperCase()} space:`);
    console.log(
      `  legacy   ${legacy.ms.toFixed(1)} ms  (${formatRate(comparisons, legacy.ms)})`,
    );
    console.log(
      `  popcount ${fast.ms.toFixed(1)} ms  (${formatRate(comparisons, fast.ms)})`,
    );
    console.log(`  speedup  ${speedup.toFixed(2)}x`);
    console.log("");
  }
}

if (import.meta.main) {
  await main();
}
