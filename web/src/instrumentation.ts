/**
 * Next.js 稳定 API：`register()` 在应用代码加载前执行一次（计划 D3）。
 *
 * 职责：
 * 1. 接入 core 日志文件沉降（Phase 2+3 logs 项）——`configure("INFO", logDir)`
 *    开启 pino-roll 按天 + 20MB 轮转写文件（幂等，src/utils/logging.ts:227-266），
 *    目录解析见 `./lib/logPaths`（env DAMAI_WEB_LOG_DIR > 仓库根 logs/）；
 * 2. 在进程内建立 TaskManager globalThis 单例。
 * 用 `__damaiWebBooted` 守护——即使 dev 模式下 register 被再次调用，初始化也只执行一次。
 */
export async function register(): Promise<void> {
  // instrumentation 会在 Edge 与 Node 两个运行时各求值一次；TaskManager 是
  // 纯 TS 但未来可能挂 Node 侧能力，只在 Node 运行时建立（官方推荐守卫模式）。
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const g = globalThis as unknown as { __damaiWebBooted?: boolean };
  if (g.__damaiWebBooted) {
    return;
  }
  g.__damaiWebBooted = true;

  // core 日志落盘接入：动态 import 放入 try/catch——日志沉降启用失败只告警，
  // 绝不阻断启动（全局 logger 未 configure 时仍走 stderr，logging.ts:220-222）。
  // pino/pino-roll 在 serverExternalPackages（next.config.ts:14），运行时 require 不打包。
  try {
    const { configure } = await import("@core/utils/logging");
    const { resolveLogDir } = await import("./lib/logPaths");
    await configure("INFO", resolveLogDir());
  } catch (exc) {
    console.warn("[web] 日志文件沉降启用失败（不影响运行）:", exc);
  }

  // 触发单例建立（不启动任何任务）
  const { getTaskManager } = await import("./task/manager");
  const manager = getTaskManager();
  console.log(
    `[web] TaskManager 已初始化（instrumentation.register，进程内仅此一次；当前任务数 ${manager.list().length}）`,
  );
}
