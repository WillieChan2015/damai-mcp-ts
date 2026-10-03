import Link from "next/link";

import { DeviceManager } from "@core/device/manager";
import { Glyph, MetricCard, type GlyphName } from "@/components/ui";
import { getTaskManager } from "@/task/manager";
import { loadNotifyStatusSnapshot } from "@/app/notify/notifyConfig";

import { ClockHero } from "./ClockHero";

export const dynamic = "force-dynamic";

export const metadata = { title: "抢票指挥台" };

interface StageEntry {
  href: string;
  glyph: GlyphName;
  title: string;
  desc: string;
  badge?: string;
  statusVariant?: "ok" | "warn" | "neutral" | "info";
}

export default async function Home() {
  const manager = getTaskManager();
  const tasks = manager.list();
  const liveTasks = tasks.filter((t) => t.status === "running" || t.status === "cancelling");
  const grabTasks = tasks.filter((t) => t.kind === "grab");
  const monitorTasks = tasks.filter((t) => t.kind === "monitor");

  let deviceCount = 0;
  try {
    const devices = await DeviceManager.shared().listDevices(true);
    deviceCount = devices.length;
  } catch {
    deviceCount = 0;
  }

  let notifyReady = false;
  try {
    const notifySnapshot = await loadNotifyStatusSnapshot();
    notifyReady = notifySnapshot.ready;
  } catch {
    notifyReady = false;
  }

  const coreEntries: StageEntry[] = [
    {
      href: "/tasks",
      glyph: "tasks",
      title: "抢票任务",
      desc: "配置场次与票档，倒计时到点自动开抢；流程止步于人工核验与支付",
      badge: liveTasks.length > 0 ? `${liveTasks.length} 个运行中` : `${grabTasks.length} 条记录`,
      statusVariant: liveTasks.length > 0 ? "warn" : "neutral",
    },
    {
      href: "/devices",
      glyph: "devices",
      title: "设备机架",
      desc: "管理 USB 真机与网络模拟器 ADB 连通状态，支持快捷一键断开与重连",
      badge: deviceCount > 0 ? `${deviceCount} 台在线` : "未检测到设备",
      statusVariant: deviceCount > 0 ? "ok" : "warn",
    },
    {
      href: "/monitor",
      glyph: "monitor",
      title: "余票监控",
      desc: "只读轮询详情页 Dump 节点，四态判定票档；发现有票即刻推送通知",
      badge: monitorTasks.length > 0 ? `${monitorTasks.length} 项监控` : "无监控",
      statusVariant: monitorTasks.length > 0 ? "info" : "neutral",
    },
  ];

  const diagEntries: StageEntry[] = [
    {
      href: "/screenshots",
      glyph: "shots",
      title: "现场截图与证据库",
      desc: "设备实时 2s 轮询取景，以及历史抢票失败现场现场存档与回溯",
    },
    {
      href: "/probe",
      glyph: "probe",
      title: "选择器调试器",
      desc: "大麦改版后解析 UI 树层级，按文本搜索控件并提取最新属性与坐标",
    },
    {
      href: "/ai",
      glyph: "ai",
      title: "AI 助手",
      desc: "接入 OpenAI 兼容大模型，支持自然语言只读探查设备与票面控件",
    },
    {
      href: "/notify",
      glyph: "notify",
      title: "微信通知通道",
      desc: "微信 ClawBot 机器人三要素连通性检查与测试发送",
      badge: notifyReady ? "通道就绪" : "待配置",
      statusVariant: notifyReady ? "ok" : "warn",
    },
  ];

  return (
    <div className="space-y-8">
      {/* 顶部时钟基准与战备指示 */}
      <section className="panel p-6 sm:p-8">
        <ClockHero />
      </section>

      {/* 战备四态看板 */}
      <section aria-label="战备四态看板" className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <MetricCard
          title="在线设备"
          value={deviceCount}
          subtext={deviceCount > 0 ? "ADB 通路就绪" : "请先连接设备"}
          glyph="devices"
          active={deviceCount > 0}
          href="/devices"
        />
        <MetricCard
          title="活动任务"
          value={liveTasks.length}
          subtext={liveTasks.length > 0 ? "正在抢票/候场中" : "待命中"}
          glyph="tasks"
          active={liveTasks.length > 0}
          href="/tasks"
        />
        <MetricCard
          title="余票监控"
          value={monitorTasks.length}
          subtext={monitorTasks.length > 0 ? "后台轮询中" : "暂无监控项"}
          glyph="monitor"
          active={monitorTasks.length > 0}
          href="/monitor"
        />
        <MetricCard
          title="微信通知"
          value={notifyReady ? "已连接" : "未就绪"}
          subtext={notifyReady ? "ClawBot 随时可推" : "需配置三要素"}
          glyph="notify"
          active={notifyReady}
          href="/notify"
        />
      </section>

      <hr className="perforation" aria-hidden />

      {/* 核心作战与现场诊断分栏入口 */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="核心作战舱" className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="font-display text-base font-semibold text-ink">核心作战舱</h2>
            <span className="text-xs text-muted">开票准备与执行</span>
          </div>
          <div className="space-y-2">
            {coreEntries.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="group flex items-start gap-4 rounded-lg border border-line bg-surface p-4 transition-all hover:border-ink/30 hover:bg-surface-raised"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-paper text-ink transition-colors group-hover:border-ink/20 group-hover:text-accent">
                  <Glyph name={item.glyph} className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-ink group-hover:text-accent">
                      {item.title}
                    </span>
                    {item.badge ? (
                      <span className="rounded border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-muted">
                        {item.badge}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted line-clamp-2">
                    {item.desc}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section aria-label="现场诊断与排障" className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="font-display text-base font-semibold text-ink">现场诊断与排障</h2>
            <span className="text-xs text-muted">改版排查与现场留痕</span>
          </div>
          <div className="space-y-2">
            {diagEntries.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="group flex items-start gap-4 rounded-lg border border-line bg-surface p-4 transition-all hover:border-ink/30 hover:bg-surface-raised"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-paper text-ink transition-colors group-hover:border-ink/20 group-hover:text-accent">
                  <Glyph name={item.glyph} className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-ink group-hover:text-accent">
                      {item.title}
                    </span>
                    {item.badge ? (
                      <span className="rounded border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-muted">
                        {item.badge}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted line-clamp-2">
                    {item.desc}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
