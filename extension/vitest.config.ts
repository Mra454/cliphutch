import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/lib/**/*.test.ts", "src/workers/**/*.test.ts"],
    environment: "node",
  },
});
