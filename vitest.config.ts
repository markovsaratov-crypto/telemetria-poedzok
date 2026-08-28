// vitest.config.ts — P2-12: автотесты (юнит + интеграционные smoke).
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Юнит-тесты не должны трогать реальную БД: libsql-клиент создаётся eagerly
    // при импорте db.ts (через share.ts и др.) — отдаём in-memory.
    env: { DATABASE_URL: ":memory:" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
