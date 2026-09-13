import { defineConfig, devices } from "@playwright/test";

// UI flows against the Vite dev server, where src/dev/mockBackend.ts stands in for the Rust core.
// The Rust side (streaming, storage, trimming) is covered by `cargo test`.
const PORT = 1430;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1100, height: 760 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1100, height: 760 } } }],
  webServer: {
    // Not 1420, so it can run next to `tauri dev`.
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
