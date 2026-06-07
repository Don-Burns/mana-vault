import { defineConfig } from "npm:vite";

export default defineConfig({
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      input: {
        main: "index.html",
        sw: "src/sw.ts",
      },
      output: {
        // Service worker must be at root with a fixed name
        entryFileNames: (chunk) => {
          if (chunk.name === "sw") return "sw.js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ["@techstark/opencv-js"],
  },
  worker: {
    format: "es",
  },
  server: {
    port: 3000,
    host: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
