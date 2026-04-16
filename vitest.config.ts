import { defineConfig } from "vitest/config";
import { join } from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    env: {
      MCP_BRAIN_DB: join(import.meta.dirname!, "src", ".test-brain.db"),
    },
  },
});
