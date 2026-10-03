"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import type { TaskSnapshot } from "@/task/manager";

import { cancelTask } from "./actions";
import { ProgressViewer } from "./ProgressViewer";
import { TaskForm, type TaskFormDevice } from "./TaskForm";
import { TaskTable } from "./TaskTable";
import { Glyph, Panel } from "@/components/console";

/**
 * 抢票任务双栏作战舱面板：
 * 左侧：任务启动台 (42%)
 * 右侧：实时监控室与控制台 (58%)
 * 底部：历史任务审计与切换
 */
export function TaskPanel({
  initialTasks,
  devices = [],
  viewerPresets = [],
}: {
  initialTasks: TaskSnapshot[];
  devices?: TaskFormDevice[];
  viewerPresets?: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [cancelError, setCancelError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["tasks"],
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
  const tasks = data.tasks;

  // 默认选中：优先选中正在运行/取消中的任务；其次选中最新的任务
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const running = initialTasks.find((t) => t.status === "running" || t.status === "cancelling");
    return running?.id ?? initialTasks[0]?.id ?? null;
  });

  // 如果当前选中的任务不存在且列表有任务，兜底重设
  useEffect(() => {
    if (!selectedId && tasks.length > 0) {
      setSelectedId(tasks[0].id);
    }
  }, [selectedId, tasks]);

  const onCancel = (taskId: string): void => {
    setCancelError(null);
    startTransition(async () => {
      const result = await cancelTask({ taskId });
      if (result.serverError) {
        setCancelError(result.serverError);
        return;
      }
      router.refresh();
    });
  };

  const selectedTask = selectedId ? tasks.find((t) => t.id === selectedId) : undefined;
  const isCancellable =
    selectedTask !== undefined &&
    (selectedTask.status === "running" || selectedTask.status === "cancelling");

  return (
    <div className="space-y-6">
      {/* 顶部双栏作战舱 */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* 左侧：任务启动台 (5/12, ~42%) */}
        <section className="lg:col-span-5">
          <Panel
            title="任务启动台"
            actions={
              <span className="text-xs text-muted">
                {devices.length} 台可用设备
              </span>
            }
          >
            <TaskForm
              devices={devices}
              viewerPresets={viewerPresets}
              onStarted={(newId) => {
                setSelectedId(newId);
              }}
            />
          </Panel>
        </section>

        {/* 右侧：实时监控室与控制台 (7/12, ~58%) */}
        <section className="lg:col-span-7">
          <Panel
            title={
              selectedTask
                ? `作战监视室 · ${selectedTask.label || selectedTask.id.slice(0, 8)}`
                : "作战监视室"
            }
            actions={
              selectedTask ? (
                <div className="flex items-center gap-2">
                  {isCancellable ? (
                    <Button
                      type="button"
                      onClick={() => onCancel(selectedTask.id)}
                      disabled={isPending}
                      variant="destructive" size="xs"
                    >
                      {isPending ? "取消中…" : "中止任务"}
                    </Button>
                  ) : null}
                </div>
              ) : undefined
            }
          >
            {cancelError ? (
              <div className="mb-3 rounded border border-danger/30 bg-danger/10 p-2 text-xs text-danger">
                {cancelError}
              </div>
            ) : null}
            <ProgressViewer taskId={selectedId} />
          </Panel>
        </section>
      </div>

      {/* 底部：历史任务审计与调阅 */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">任务审计总表</h2>
            <span className="font-mono text-xs text-muted">({tasks.length} 条)</span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
            <Glyph name="refresh" className="h-3.5 w-3.5 text-muted animate-spin" />
            <span>1.5s 持续轮询</span>
          </div>
        </div>

        <div className="p-5">
          {tasks.length === 0 ? (
            <p className="text-sm text-muted">还没有任务——用上方启动台创建第一个抢票任务。</p>
          ) : (
            <div className="overflow-x-auto">
              <TaskTable tasks={tasks} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
