import { getTaskManager } from "@/task/manager";

import { TaskPanel } from "./TaskPanel";

export const dynamic = "force-dynamic";

export const metadata = { title: "抢票任务 · Damai Console" };

export default function TasksPage() {
  const manager = getTaskManager();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">抢票任务</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          NTP 校时 → 详情页预热 → 开票判定（去抖门）→ 抢档 → 选人；取消在候场阶段即时生效。
        </p>
      </div>
      <TaskPanel initialTasks={manager.list()} />
    </div>
  );
}
