import { defineConfig, devices } from "@playwright/test";

// Chromium flags that make a deterministic fake camera available to every
// test without touching app code: no real camera/permission prompt needed.
const FAKE_CAMERA_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  `--use-file-for-fake-video-capture=${process.cwd()}/e2e/fixtures/card.mjpeg`,
];

// Two projects because the exact bug this suite guards against (a URL-dedup
// mismatch in the service worker's precache list) only reproduces when the
// app is served from a non-root base path, matching the real GitHub Pages
// deployment (BASE_PATH=/<repo-name>/). Testing only at "/" would have
// silently passed while production stayed broken. Each project gets its own
// build (separate --outDir) and preview server (separate port) so both can
// run concurrently without racing on shared build output.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    trace: "on-first-retry",
    permissions: ["camera"],
    launchOptions: { args: FAKE_CAMERA_ARGS },
  },
  webServer: [
    {
      command:
        "deno task build --outDir dist-root && deno task preview --outDir dist-root --port 4173 --strictPort",
      url: "http://localhost:4173/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command:
        "deno task build --outDir dist-subpath && deno task preview --outDir dist-subpath --port 4174 --strictPort",
      url: "http://localhost:4174/mana-vault/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { BASE_PATH: "/mana-vault/" },
    },
  ],
  projects: [
    {
      name: "root",
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4173/" },
    },
    {
      name: "subpath",
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4174/mana-vault/" },
    },
  ],
});
