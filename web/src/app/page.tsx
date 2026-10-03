import Link from "next/link";

export const metadata = {
  title: "Damai Web Console",
};

export default function Home() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Link
        href="/devices"
        className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">📱 设备管理</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          查看已连接的设备/模拟器，通过 ADB 无线地址连接新设备。
        </p>
      </Link>
      <Link
        href="/tasks"
        className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">🎯 抢票任务</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          配置场次/票档/观演人，启动抢票任务并实时查看进度（NTP 校时 + 开票去抖门）。
        </p>
      </Link>
      <Link
        href="/monitor"
        className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">📈 余票监控</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          只读轮询票档可用性（四态判定），按间隔采样，发现有票立即停止并给出详情页外链。
        </p>
      </Link>
      <Link
        href="/notify"
        className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">🔔 通知</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          ClawBot 通知凭证完整性检查与测试发送，附绑定指引（本页面不保存凭证）。
        </p>
      </Link>
      <Link
        href="/logs"
        className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">📜 日志</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          core 日志按天轮转落盘的实时尾随视图（SSE + 虚拟滚动）。
        </p>
      </Link>
      <Link
        href="/probe"
        className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">🛠️ 选择器调试器</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Dump 设备 UI 树、按文本试查元素，大麦改版后排查选择器失效的自救入口。
        </p>
      </Link>
      <Link
        href="/ai"
        className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">🤖 AI 助手</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          只读 AI 探查对话与 provider 设置（工具集只读，绝不暴露下单/支付）。
        </p>
      </Link>
    </div>
  );
}
