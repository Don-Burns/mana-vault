import { defineConfig } from "npm:vite";
import { VitePWA } from "npm:vite-plugin-pwa";

// Baked in at build time for the footer's version/published-at display.
function gitInfo(format: string): string {
  const cmd = new Deno.Command("git", { args: ["log", "-1", `--format=${format}`] });
  const { stdout } = cmd.outputSync();
  return new TextDecoder().decode(stdout).trim();
}

export default defineConfig({
  root: ".",
  publicDir: "public",
  // Root site by default; CI sets BASE_PATH based on the GitHub repo name
  // for the Pages project-site build.
  base: Deno.env.get("BASE_PATH") ?? "/",
  define: {
    __COMMIT_HASH__: JSON.stringify(gitInfo("%H")),
    __COMMIT_DATE__: JSON.stringify(gitInfo("%cI")),
  },
  resolve: {
    // Deno resolves "@std/csv" via its own import map (deno.json) to the
    // npm-compat tarball vendored at node_modules/@jsr/std__csv (see JSR's
    // npm compatibility docs: https://jsr.io/docs/npm-compatibility). Vite
    // doesn't read Deno's import map, so it needs the same redirect spelled
    // out here.
    alias: {
      "@std/csv": "@jsr/std__csv",
    },
  },
  plugins: [
    VitePWA({
      // We ship a hand-written service worker (src/sw.ts) with custom caching
      // strategies, so use injectManifest mode: the plugin bundles our SW and
      // injects the precache manifest (self.__WB_MANIFEST) rather than
      // generating a SW for us.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // Emit the built worker as sw.js at the site root (matches the
      // navigator.serviceWorker.register("/sw.js") call in main.ts).
      injectManifest: {
        rollupFormat: "es",
        // The OpenCV WASM/JS bundle (~11 MB) and the hash DB / metadata under
        // /db (~15 MB) are cached lazily at runtime by our SW (cache-first),
        // so keep them out of the install-time precache manifest. Only
        // precache the small app-shell assets.
        globPatterns: ["**/*.{html,css,svg}", "manifest.json", "assets/index-*.js"],
        globIgnores: ["db/**", "**/mod-*.js"],
      },
      // Serve the service worker from the dev server too, so offline/caching
      // behaviour can be tested without a production build.
      devOptions: {
        enabled: true,
        type: "module",
      },
      // We already maintain public/manifest.json ourselves.
      manifest: false,
      // Let the plugin inject the registration script. It knows the correct
      // worker URL in both dev (dev-sw.js?dev-sw) and production (/sw.js), so
      // we don't hard-code the path in app code.
      injectRegister: "auto",
    }),
  ],
  build: {
    outDir: "dist",
    target: "es2022",
  },
  worker: {
    format: "es",
  },
  // Some deps (e.g. the sqlite-wasm package) use modern syntax like
  // top-level await, which the dep pre-bundler's default esbuild target (an
  // older browser baseline) rejects. Raise it to esnext to match
  // `build.target` above.
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
  server: {
    port: 3000,
    host: true,
  },
});
