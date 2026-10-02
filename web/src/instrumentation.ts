/**
 * Next.js 稳定 API：`register()` 在应用代码加载前执行一次（计划 D3）。
 *
 * 职责：在进程内建立 TaskManager globalThis 单例。用 `__damaiWebBooted`
 * 守护日志输出——即使 dev 模式下 register 被再次调用，日志也只打一次。
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

  // 触发单例建立（不启动任何任务）
  const { getTaskManager } = await import("./task/manager");
  const manager = getTaskManager();
  console.log(
    `[web] TaskManager 已初始化（instrumentation.register，进程内仅此一次；当前任务数 ${manager.list().length}）`,
  );
}
