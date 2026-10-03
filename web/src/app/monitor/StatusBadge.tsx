"use client";

import type { Availability } from "@core/damai/monitor";
import type { TaskStatus } from "@/task/manager";

/**
 * 监控面板的状态徽标（Phase 2/3 设计 §3.2）。
 *
 * 四态余票徽标复用 classifyAvailability 的词表语义（monitor.ts:106）：
 * available 绿 / not_on_sale 蓝 / sold_out 红 / unknown 灰；
 * 任务态徽标 running 旋转、cancelling 黄、unresponsive 紫虚线、终态常规色。
 */

const AVAILABILITY_CLS: Record<Availability, string> = {
  available: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  not_on_sale: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  sold_out: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  unknown: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

const AVAILABILITY_TEXT: Record<Availability, string> = {
  available: "有票",
  not_on_sale: "未开售",
  sold_out: "已售罄",
  unknown: "未知",
};

/** 四态余票徽标；status=null 表示尚未产生任何采样（运行中但 SSE 还没报数）。 */
export function AvailabilityBadge({ status }: { status: Availability | null }) {
  if (status === null) {
    return (
      <span className="inline-block rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
        待采样
      </span>
    );
  }
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${AVAILABILITY_CLS[status]}`}
    >
      {AVAILABILITY_TEXT[status]}
    </span>
  );
}

const TASK_STATUS_CLS: Record<TaskStatus, string> = {
  running: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  cancelling: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  cancelled: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  succeeded: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  // interrupted（persistence 项 additive 状态）：上个进程遗留、启动恢复时改标的只读历史
  interrupted: "bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300",
};

const TASK_STATUS_TEXT: Record<TaskStatus, string> = {
  running: "运行中",
  cancelling: "取消中",
  cancelled: "已取消",
  succeeded: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

/** 任务态徽标：unresponsive 时以紫色虚线样式覆盖（仅标注，任务无法强杀）。 */
export function TaskStatusBadge({
  status,
  unresponsive = false,
}: {
  status: TaskStatus;
  unresponsive?: boolean;
}) {
  const cls = unresponsive
    ? "border border-dashed border-purple-500 bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
    : TASK_STATUS_CLS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {status === "running" ? (
        <span
          aria-hidden
          className="h-2 w-2 animate-spin rounded-full border border-current border-t-transparent"
        />
      ) : null}
      {TASK_STATUS_TEXT[status]}
    </span>
  );
}
