"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { TaskSnapshot } from "@/task/manager";

import { cancelTask } from "./actions";
import { ProgressViewer } from "./ProgressViewer";
import { TaskForm } from "./TaskForm";
import { TaskTable } from "./TaskTable";

/** 任务页主面板：表单 + 任务列表（轮询）+ 选中任务的实时进度（SSE）。 */
export function TaskPanel({ initialTasks }: { initialTasks: TaskSnapshot[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const cancellable = (t: TaskSnapshot | undefined): boolean =>
    t !== undefined && (t.status === "running" || t.status === "cancelling");
  const selectedTask = selectedId ? tasks.find((t) => t.id === selectedId) : undefined;

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">新建抢票任务</h2>
        <div className="mt-4">
          <TaskForm onStarted={(taskId) => setSelectedId(taskId)} />
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">任务列表</h2>
          <span className="text-xs text-zinc-400">1.5s 自动刷新</span>
        </div>
        <div className="mt-3">
          {tasks.length === 0 ? (
            <p className="text-sm text-zinc-400">还没有任务——用上方表单启动一个。</p>
          ) : (
            <TaskTable tasks={tasks} selectedId={selectedId} onSelect={setSelectedId} />
          )}
        </div>
        {cancelError ? <p className="mt-2 text-xs text-red-600">{cancelError}</p> : null}
        {selectedId ? (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => onCancel(selectedId)}
              disabled={isPending || !cancellable(selectedTask)}
              className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:hover:bg-red-950"
            >
              取消选中任务
            </button>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">实时进度</h2>
        <div className="mt-3">
          <ProgressViewer taskId={selectedId} />
        </div>
      </section>
    </div>
  );
}
