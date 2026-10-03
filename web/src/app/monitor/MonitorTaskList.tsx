"use client";

import { Button } from "@/components/ui/button";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { cancelTask } from "@/app/tasks/actions";
import type { Availability } from "@core/damai/monitor";
import type { TaskSnapshot } from "@/task/manager";
import {
  isMonitorResultDict,
  parseMonitorProgressLine,
  type MonitorProgressSample,
  type MonitorResultDict,
} from "@/task/monitorParse";

import { AvailabilityBadge, TaskStatusBadge } from "./StatusBadge";

/**
 * 监控任务列表（Phase 2/3 设计 §3.2）。
 *
 * 数据面：1.5s TanStack Query 轮询 GET /api/tasks 过滤 kind==="monitor"；
 * 徽标数据来源 = 终局取 result.final_status（MonitorResult.toDict），
 * 运行中取 SSE（既有 /api/tasks/[id]/events）最后一条可被
 * parseMonitorProgressLine 解析的采样行。found=true 时渲染 detail_url 外链。
 * 取消复用 @/app/tasks/actions 的既有 cancelTask，不重复实现。
 */

/** 订阅运行中任务的 SSE，返回最后一条可解析的采样行（任务终结/失活即停订）。 */
function useLatestSample(taskId: string, live: boolean): MonitorProgressSample | null {
  const [sample, setSample] = useState<MonitorProgressSample | null>(null);
  useEffect(() => {
    setSample(null);
    if (!live) {
      return;
    }
    const es = new EventSource(`/api/tasks/${taskId}/events`);
    es.addEventListener("progress", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { line: string };
        const parsed = parseMonitorProgressLine(data.line);
        if (parsed !== null) {
          setSample(parsed);
        }
      } catch {
        // 心跳/杂音行忽略
      }
    });
    es.addEventListener("status", () => {
      es.close();
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        es.close();
      }
    };
    return () => {
      es.close();
    };
  }, [taskId, live]);
  return sample;
}

function MonitorTaskRow({ task }: { task: TaskSnapshot }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const live = task.status === "running" || task.status === "cancelling";
  const sample = useLatestSample(task.id, live);
  const result: MonitorResultDict | null = isMonitorResultDict(task.result) ? task.result : null;

  // 徽标数据源：运行中取 SSE 最后一条采样行；终局取 result.final_status
  const availability: Availability | null = live
    ? (sample?.status ?? null)
    : (result?.final_status ?? null);

  const onCancel = (): void => {
    setCancelError(null);
    startTransition(async () => {
      const res = await cancelTask({ taskId: task.id });
      if (res.serverError) {
        setCancelError(res.serverError);
        return;
      }
      router.refresh();
    });
  };

  const evidence = live
    ? sample !== null
      ? `第 ${sample.attempt} 次采样`
      : "等待采样…"
    : result !== null
      ? `attempts=${result.attempts} stop_reason=${result.stop_reason}`
      : (task.error ?? "—");

  return (
    <tr className="border-b border-line hover:bg-surface-raised transition-colors">
      <td className="py-2 pr-4 font-mono text-xs">{task.id.slice(0, 8)}</td>
      <td className="py-2 pr-4">{task.label}</td>
      <td className="py-2 pr-4 font-mono text-xs">{task.deviceId}</td>
      <td className="py-2 pr-4">
        <TaskStatusBadge status={task.status} unresponsive={task.unresponsive} />
      </td>
      <td className="py-2 pr-4">
        <AvailabilityBadge status={availability} />
      </td>
      <td className="py-2 pr-4 text-xs text-muted">{evidence}</td>
      <td className="py-2 pr-4 text-xs">
        {result?.found ? (
          <a
            href={result.detail_url}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 underline dark:text-blue-400"
          >
            详情页
          </a>
        ) : null}
      </td>
      <td className="py-2">
        {live ? (
          <>
            <Button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              variant="destructive" size="xs"
            >
              取消
            </Button>
            {cancelError ? <p className="mt-1 text-xs text-red-600">{cancelError}</p> : null}
          </>
        ) : null}
      </td>
    </tr>
  );
}

/** 监控任务列表：1.5s 轮询 + 运行中任务 SSE 采样徽标。 */
export function MonitorTaskList({ initialTasks }: { initialTasks: TaskSnapshot[] }) {
  const { data } = useQuery({
    queryKey: ["monitor-tasks"],
    queryFn: async () => {
      const res = await fetch("/api/tasks");
      if (!res.ok) {
        throw new Error(`加载任务列表失败：HTTP ${res.status}`);
      }
      return (await res.json()) as { tasks: TaskSnapshot[] };
    },
    refetchInterval: 1500,
    initialData: { tasks: initialTasks },
  });
  // 新任务在前，便于刚启动的任务立即可见
  const tasks = data.tasks.filter((t) => t.kind === "monitor").reverse();

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-zinc-400">共 {tasks.length} 个监控任务</span>
        <span className="text-xs text-zinc-400">1.5s 自动刷新</span>
      </div>
      {tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
          还没有监控任务——用上方表单启动一个余票监控。
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="py-2 pr-4 font-medium">任务</th>
              <th className="py-2 pr-4 font-medium">描述</th>
              <th className="py-2 pr-4 font-medium">设备</th>
              <th className="py-2 pr-4 font-medium">任务态</th>
              <th className="py-2 pr-4 font-medium">余票</th>
              <th className="py-2 pr-4 font-medium">采样/结果</th>
              <th className="py-2 pr-4 font-medium" />
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <MonitorTaskRow key={task.id} task={task} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
