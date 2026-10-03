import path from "node:path";
import type { NextConfig } from "next";

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
};

export default nextConfig;
