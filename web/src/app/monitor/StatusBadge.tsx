"use client";

import type { Availability } from "@core/damai/monitor";

import { Badge } from "@/components/ui/badge";
import type { TaskStatus } from "@/task/manager";

/**
 * 监控面板的状态徽标（Phase 2/3 设计 §3.2）。
 *
 * 四态余票徽标复用 classifyAvailability 的词表语义（monitor.ts:106）：
 * available 绿 / not_on_sale 蓝 / sold_out 红 / unknown 灰；
 * 任务态徽标 running 旋转、cancelling 黄、unresponsive 紫虚线、终态常规色。
 */

const AVAILABILITY_CLS: Record<Availability, string> = {
  available: "border-ok/30 bg-ok/10 text-ok font-semibold",
  not_on_sale: "border-info/30 bg-info/10 text-info",
  sold_out: "border-danger/30 bg-danger/10 text-danger",
  unknown: "border-line bg-surface-raised text-muted",
};

const AVAILABILITY_TEXT: Record<Availability, string> = {
  available: "有票 (available)",
  not_on_sale: "未开售 (not_on_sale)",
  sold_out: "已售罄 (sold_out)",
  unknown: "未知 (unknown)",
};

/** 四态余票徽标；status=null 表示尚未产生任何采样（运行中但 SSE 还没报数）。 */
export function AvailabilityBadge({ status }: { status: Availability | null }) {
  if (status === null) {
    return (
      <Badge variant="outline" className="border-line bg-secondary text-muted">
        待采样
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={AVAILABILITY_CLS[status]}>
      {AVAILABILITY_TEXT[status]}
    </Badge>
  );
}

const TASK_STATUS_CLS: Record<TaskStatus, string> = {
  running: "border-info/30 bg-info/10 text-info font-medium",
  cancelling: "border-warn/30 bg-warn/10 text-warn font-medium",
  cancelled: "border-line bg-surface-raised text-muted",
  succeeded: "border-ok/30 bg-ok/10 text-ok font-medium",
  failed: "border-danger/30 bg-danger/10 text-danger font-medium",
  interrupted: "border-line bg-surface-raised text-muted",
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
    ? "border border-dashed border-warn bg-warn/10 text-warn"
    : TASK_STATUS_CLS[status];
  return (
    <Badge variant="outline" className={`gap-1.5 ${cls}`}>
      {status === "running" ? <span aria-hidden className="live-dot" /> : null}
      {TASK_STATUS_TEXT[status]}
    </Badge>
  );
}
