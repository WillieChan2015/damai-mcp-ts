import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@core": path.resolve(__dirname, "../src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 15000,
    // 测试里的 getTaskManager 会带持久化与锁：指到临时目录，避免污染真实运行库
    // （注意：DAMAI_WEB_LOG_DIR 不能在此预置——logPaths 的默认值用例假定它未设置）
    env: {
      DAMAI_WEB_TASK_DB: path.join(os.tmpdir(), "damai-web-vitest-tasks.db"),
      DAMAI_WEB_LOCK_FILE: path.join(os.tmpdir(), "damai-web-vitest.lock"),
    },
  },
});
