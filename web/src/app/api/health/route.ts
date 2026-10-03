import { NextResponse } from "next/server";

import { getTaskManager, type TaskKind, type TaskStatus } from "@/task/manager";

export const dynamic = "force-dynamic";

/** 健康检查 + TaskManager 快照（Phase 0 冒烟验收点）。 */
export function GET() {
  const manager = getTaskManager();
  const tasks = manager.list();
  // 任务计数概览（lockedDeviceIds 之外的聚合视图）：按状态/类型计数，
  // 含零值键以保证形状稳定；与 tasks 原始数组互补而非重复
  const taskCountByStatus: Record<TaskStatus, number> = {
    running: 0,
    cancelling: 0,
    cancelled: 0,
    succeeded: 0,
    failed: 0,
    interrupted: 0,
  };
  const taskCountByKind: Record<TaskKind, number> = { grab: 0, monitor: 0, custom: 0 };
  for (const task of tasks) {
    taskCountByStatus[task.status] += 1;
    taskCountByKind[task.kind] += 1;
  }
  return NextResponse.json({
    ok: true,
    taskCount: tasks.length,
    lockedDeviceIds: manager.lockedDeviceIds(),
    taskCountByStatus,
    taskCountByKind,
    tasks,
  });
}
