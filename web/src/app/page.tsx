export const metadata = {
  title: "Damai Web Console",
  description: "damai-mcp-ts 可视化控制台",
};

export default function Home() {
  const phases = [
    { id: 0, name: "工程准备（workspace / TaskManager / cli 子命令）", done: true },
    { id: 1, name: "MVP：设备管理 + 抢票任务 + 实时进度（SSE）", done: false },
    { id: 2, name: "监控面板 / 微信通知 / 截图与日志复盘 / 选择器调试器", done: false },
    { id: 3, name: "任务持久化 / 远程访问强化 / AI 对话面板", done: false },
  ];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 p-8 font-sans dark:bg-black">
      <main className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Damai Web Console
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          damai-mcp-ts 可视化控制台 · Phase 0 骨架已就绪（Next.js 16 + React 19 + Tailwind CSS 4）
        </p>

        <h2 className="mt-6 text-sm font-medium text-zinc-900 dark:text-zinc-100">实施阶段</h2>
        <ul className="mt-2 space-y-1.5">
          {phases.map((p) => (
            <li key={p.id} className="flex items-start gap-2 text-sm">
              <span className={p.done ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}>
                {p.done ? "✔" : "○"}
              </span>
              <span className="text-zinc-700 dark:text-zinc-300">
                Phase {p.id} · {p.name}
              </span>
            </li>
          ))}
        </ul>

        <h2 className="mt-6 text-sm font-medium text-zinc-900 dark:text-zinc-100">健康检查</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">
            GET /api/health
          </code>{" "}
          返回 TaskManager 快照（需携带 token，见 <code className="text-xs">GET /api/token?token=…</code> 换取 Cookie）。
        </p>
      </main>
    </div>
  );
}
