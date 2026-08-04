# OpenCV.js Vendoring

This project vendors OpenCV.js under `vendor/opencv/` instead of installing it
from npm.

## Why vendor OpenCV

- We need a fixed, known OpenCV.js build for reproducible detection behavior.
- The upstream browser bundle includes the WASM payload inline and works fully
  offline once cached.
- We apply small runtime patches for Deno compatibility during download.

## How it is generated

Run:

```sh
deno task opencv:download
```

That task runs `tools/download-opencv.ts`, which:

1. Downloads OpenCV docs zip for version 4.13.0 from GitHub releases.
2. Extracts `js/bin/opencv.js` (the official UMD build).
3. Patches Emscripten environment detection so Deno is not treated as Node.
4. Patches implicit global `Module = {}` to `var Module = {}` for strict-mode
   safety.
5. Wraps the UMD source as an ES module and writes
   `vendor/opencv/opencv.mjs`.

`opencv.mjs` is intentionally gitignored and should be regenerated locally.

## Why `opencv.mjs` (not `opencv.cjs`)

Vite dev serves source files directly. Local CommonJS/UMD files outside
`node_modules` are not guaranteed to receive CommonJS-to-ESM transforms in that
path. That can produce errors like:

`does not provide an export named 'default'`

By emitting a real ESM file (`opencv.mjs`) with an explicit default export,
OpenCV loads consistently in:

- Vite dev (module workers)
- Vite production build
- Deno tests

## Runtime usage

- App code imports only from `vendor/opencv/mod.ts`.
- `vendor/opencv/mod.ts` imports `opencv.mjs`, waits for
  `onRuntimeInitialized`, and exports a ready-to-use `cv` object.
- Worker entrypoint `src/workers/detection-worker.ts` dynamically imports
  `vendor/opencv/mod.ts` during startup.

## Troubleshooting

- If OpenCV fails to load after switching branches or updating tool code:

```sh
deno task opencv:download
```

- If dev still serves stale modules, restart the dev server and hard-refresh the
  page.
