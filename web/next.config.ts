import path from "node:path";
import type { NextConfig } from "next";

import { SILENT_INCOMING_REQUESTS } from "./src/lib/silentRequests";

// web/ 通过 tsconfig paths 引用仓库根的 core TS 源码（../src/*），
// 需要把 Turbopack 的 workspace 根指到仓库根，避免越界访问被裁剪。
const repoRoot = path.resolve(__dirname, "..");

const nextConfig: NextConfig = {
  turbopack: {
    root: repoRoot,
  },
  // core 的服务端依赖含 worker_threads / 原生资源，交给 Node 运行时 require，
  // 不参与打包（pino 的 thread-stream 打进 bundle 会崩；better-sqlite3 是原生模块）。
  serverExternalPackages: ["pino", "pino-roll", "jimp", "better-sqlite3"],
  // 开发态请求日志：丢掉导航栏对 /api/health 的 3 秒轮询。页面操作的耗时在
  // action 中间件里按类型写入 debug，不靠这条访问日志。
  logging: {
    incomingRequests: {
      ignore: [...SILENT_INCOMING_REQUESTS],
    },
  },
};

export default nextConfig;
