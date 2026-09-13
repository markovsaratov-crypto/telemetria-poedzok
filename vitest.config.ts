import { defineConfig } from "vitest/config";
import path from "path";

// Unit-тесты чистых вычислительных ядер (метрики, restore, дедуп алертов):
// без БД и сети. Путь-алиас "@" — как в tsconfig (kpi.ts и др. импортируют
// "@/lib/geo").
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
