import { NextResponse } from "next/server";

import { getTaskManager } from "@/task/manager";

export const dynamic = "force-dynamic";

/** 健康检查 + TaskManager 快照（Phase 0 冒烟验收点）。 */
export function GET() {
  const manager = getTaskManager();
  return NextResponse.json({
    ok: true,
    taskCount: manager.list().length,
    lockedDeviceIds: manager.lockedDeviceIds(),
    tasks: manager.list(),
  });
}
