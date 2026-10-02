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
    </div>
  );
}
