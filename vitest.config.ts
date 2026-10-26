import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 套件内大量真实定时器时序用例（SSE 静默/核查/探活），文件级并行会互相争用 CPU 致偶发超时抖动
    fileParallelism: false,
  },
});
