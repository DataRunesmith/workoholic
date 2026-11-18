import { defineConfig } from "vitest/config";

// Let tests import the dashboard stylesheet as text (?raw) instead of an empty stub.
export default defineConfig({
  test: {
    css: true,
    reporters: [
      "default",
      ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
      "@mergifyio/vitest",
    ],
  },
});
