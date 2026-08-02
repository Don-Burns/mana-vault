# Matcher Benchmark Tool

This project includes a microbenchmark for the hash matcher:

- Script: `tools/bench-matcher.ts`
- Task: `deno task bench:matcher`

It compares two Hamming-distance implementations on the real hash DB:

1. Legacy BigInt + Kernighan loop (baseline)
2. Current 32-bit popcount path (production)

It runs both on the same generated query set and verifies they produce the same
hit count for the matcher threshold (`combined < 25`). If counts differ, the
benchmark fails.

## Usage

```sh
# default: 64 queries, 5 rounds, both hash spaces
deno task bench:matcher

# custom run
deno task bench:matcher --queries=16 --rounds=2 --space=both

# choose one space
deno task bench:matcher --space=art
deno task bench:matcher --space=full

# use a custom DB file
deno task bench:matcher --db=/path/to/hash-db.bin
```

## Flags

- `--queries=N`: number of query hashes sampled from DB (min 1)
- `--rounds=N`: number of repeated sweeps (min 1)
- `--space=art|full|both`: which hash space(s) to benchmark
- `--db=PATH`: hash DB file path (default `data/output/hash-db.bin`)

## Output

For each hash space, it prints:

- Baseline time (`legacy`)
- Optimized time (`popcount`)
- Throughput in comparisons/second
- Speedup ratio (`legacy / popcount`)

Example:

```text
ART space:
  legacy   1128.0 ms  (1.46M comparisons/s)
  popcount   11.2 ms  (147.07M comparisons/s)
  speedup   100.91x
```

## Notes

- This is a microbenchmark: it isolates the matcher's tight loop, not full
  camera-to-match latency.
- Full-pipeline timings should still be measured in app/test flows.
