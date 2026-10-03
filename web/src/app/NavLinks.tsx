"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

interface TelemetrySnapshot {
  runningTasks: number;
  lockedDevices: number;
}

const CORE_LINKS: Array<[string, string]> = [
  ["/tasks", "抢票任务"],
  ["/devices", "设备机架"],
  ["/monitor", "余票监控"],
];

const DIAG_LINKS: Array<[string, string]> = [
  ["/screenshots", "现场截图"],
  ["/probe", "选择器调试"],
  ["/ai", "AI 助手"],
  ["/notify", "通知配置"],
];

/** 顶部主导航栏与遥测信息。 */
export function NavLinks() {
  const pathname = usePathname();
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>({
    runningTasks: 0,
    lockedDevices: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const fetchTelemetry = async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data) {
          const running =
            (data.taskCountByStatus?.running ?? 0) +
            (data.taskCountByStatus?.cancelling ?? 0);
          const locked = Array.isArray(data.lockedDeviceIds)
            ? data.lockedDeviceIds.length
            : 0;
          setTelemetry({ runningTasks: running, lockedDevices: locked });
        }
      } catch {
        // 静默容错
      }
    };

    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const renderLink = (href: string, label: string) => {
    const active = pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
    return (
      <Link
        key={href}
        href={href}
        data-active={active}
        className="rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap text-muted transition-colors hover:bg-surface-raised hover:text-ink data-[active=true]:bg-surface-raised data-[active=true]:font-semibold data-[active=true]:text-ink"
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="flex flex-1 items-center justify-between gap-4 overflow-x-auto">
      <div className="flex items-center gap-1 sm:gap-2">
        <div className="flex items-center gap-0.5">
          {CORE_LINKS.map(([href, label]) => renderLink(href, label))}
        </div>

        <span className="h-3.5 w-px bg-line" aria-hidden />

        <div className="flex items-center gap-0.5">
          {DIAG_LINKS.map(([href, label]) => renderLink(href, label))}
        </div>
      </div>

      <div className="hidden items-center gap-3 font-mono text-xs text-muted sm:flex">
        {telemetry.runningTasks > 0 ? (
          <span className="flex items-center gap-1.5 text-accent font-semibold">
            <span className="live-dot" />
            <span>{telemetry.runningTasks} 任务运行中</span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-muted">
            <span className="h-2 w-2 rounded-full bg-line-strong" />
            <span>待命</span>
          </span>
        )}

        {telemetry.lockedDevices > 0 ? (
          <span className="text-muted">
            {telemetry.lockedDevices} 设备占用
          </span>
        ) : null}

        <span className="border-l border-line pl-3 text-[11px] text-muted">
          NTP 准点
        </span>
      </div>
    </div>
  );
}
