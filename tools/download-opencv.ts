/// <reference lib="deno.ns" />

/**
 * Download OpenCV.js
 *
 * Downloads the official OpenCV.js build from GitHub releases and
 * extracts it to vendor/opencv/. Applies patches needed for ES module
 * and Deno compatibility.
 *
 * Usage: deno task opencv:download
 *
 * Source: https://github.com/opencv/opencv/releases
 */

import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const OPENCV_VERSION = "4.13.0";
const OPENCV_URL =
  `https://github.com/opencv/opencv/releases/download/${OPENCV_VERSION}/opencv-${OPENCV_VERSION}-docs.zip`;
const ZIP_ENTRY = "js/bin/opencv.js";

const VENDOR_DIR = join(Deno.cwd(), "vendor", "opencv");
const OUTPUT_FILE = join(VENDOR_DIR, "opencv.cjs");

async function main() {
  console.log(`Downloading OpenCV.js ${OPENCV_VERSION}...`);

  // Download the zip to a temp file
  const tmpDir = await Deno.makeTempDir();
  const zipPath = join(tmpDir, "opencv-docs.zip");

  const response = await fetch(OPENCV_URL);
  if (!response.ok) {
    console.error(`Download failed: ${response.status} ${response.statusText}`);
    Deno.exit(1);
  }

  const zipData = new Uint8Array(await response.arrayBuffer());
  await Deno.writeFile(zipPath, zipData);
  console.log(`  Downloaded ${(zipData.length / 1024 / 1024).toFixed(1)} MB`);

  // Extract opencv.js using the system unzip command
  console.log(`Extracting ${ZIP_ENTRY}...`);
  const unzip = new Deno.Command("unzip", {
    args: ["-o", "-q", zipPath, ZIP_ENTRY, "-d", tmpDir],
  });
  const { code, stderr } = await unzip.output();
  if (code !== 0) {
    console.error("unzip failed:", new TextDecoder().decode(stderr));
    Deno.exit(1);
  }

  const extractedPath = join(tmpDir, ZIP_ENTRY);
  const jsSource = await Deno.readTextFile(extractedPath);

  // Apply compatibility patches
  console.log("Applying compatibility patches...");
  const patched = patchOpenCV(jsSource);

  // Write to vendor directory
  await Deno.mkdir(VENDOR_DIR, { recursive: true });
  await Deno.writeTextFile(OUTPUT_FILE, patched);

  // Cleanup temp files
  await Deno.remove(tmpDir, { recursive: true });

  const sizeMB = new TextEncoder().encode(patched).length / 1024 / 1024;
  console.log(`  Written to ${OUTPUT_FILE} (${sizeMB.toFixed(1)} MB)`);
  console.log("\nDone! OpenCV.js is ready.");
}

/**
 * Apply patches to make OpenCV.js work as an ES module and in Deno.
 *
 * Patches:
 * 1. Deno's Node.js compatibility shim makes Emscripten's environment
 *    detection think it's running in Node.js, which then fails because
 *    __dirname and require() are not available in Deno ES modules.
 *    Fix: exclude Deno from both ENVIRONMENT_HAS_NODE and
 *    ENVIRONMENT_IS_NODE checks.
 *
 * 2. The UMD wrapper's fallback `Module = {}` is an implicit global
 *    assignment that throws in strict mode (ES modules). Fix: declare
 *    the variable with `var`.
 */
function patchOpenCV(source: string): string {
  let patched = source;

  // Patch 1a: Don't detect Deno as having Node.js
  //
  // ENVIRONMENT_HAS_NODE gates require("fs") calls for NODEFS.
  // Deno has a process shim that makes it look like Node, but doesn't
  // provide require(). Adding the Deno check prevents those code paths.
  const hasNodeDetect =
    'typeof process.versions.node==="string"';
  const hasNodeDetectPatched =
    'typeof process.versions.node==="string"&&typeof Deno==="undefined"';

  if (!patched.includes(hasNodeDetect)) {
    console.error("  WARNING: Could not find ENVIRONMENT_HAS_NODE pattern to patch");
  } else {
    patched = patched.replace(hasNodeDetect, hasNodeDetectPatched);
    console.log("  Patched ENVIRONMENT_HAS_NODE to exclude Deno");
  }

  // Patch 1b: Don't detect Deno as Node.js (redundant safety)
  //
  // ENVIRONMENT_IS_NODE = ENVIRONMENT_HAS_NODE && ...
  // Already false after patch 1a, but patch explicitly for clarity.
  const nodeDetect =
    "ENVIRONMENT_IS_NODE=ENVIRONMENT_HAS_NODE&&!ENVIRONMENT_IS_WEB&&!ENVIRONMENT_IS_WORKER";
  const nodeDetectPatched =
    'ENVIRONMENT_IS_NODE=ENVIRONMENT_HAS_NODE&&!ENVIRONMENT_IS_WEB&&!ENVIRONMENT_IS_WORKER&&typeof Deno==="undefined"';

  if (!patched.includes(nodeDetect)) {
    console.error("  WARNING: Could not find ENVIRONMENT_IS_NODE pattern to patch");
  } else {
    patched = patched.replace(nodeDetect, nodeDetectPatched);
    console.log("  Patched ENVIRONMENT_IS_NODE to exclude Deno");
  }

  // Patch 2: Fix implicit global `Module` assignment
  //
  // Original (at end of UMD wrapper, inside factory return):
  //   if (typeof Module === 'undefined')
  //     Module = {};
  //
  // Patched: use `var` to make it a proper declaration
  const moduleAssign = `if (typeof Module === 'undefined')
    Module = {};`;
  const moduleAssignPatched = `if (typeof Module === 'undefined')
    var Module = {};`;

  if (!patched.includes(moduleAssign)) {
    console.error("  WARNING: Could not find Module assignment pattern to patch");
  } else {
    patched = patched.replace(moduleAssign, moduleAssignPatched);
    console.log("  Patched Module assignment for strict mode");
  }

  return patched;
}

main().catch((err) => {
  console.error("Error:", err.message);
  Deno.exit(1);
});
