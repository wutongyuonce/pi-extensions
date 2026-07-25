import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["ts-tests/**/*.test.ts"],
    environment: "node",
  },
});
