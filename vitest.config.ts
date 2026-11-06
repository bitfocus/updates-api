import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The app logs liberally to the console; only show that output for failing tests
    silent: "passed-only",
  },
});
