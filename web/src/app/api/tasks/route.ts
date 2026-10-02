import { NextResponse } from "next/server";

import { getTaskManager } from "@/task/manager";

export const dynamic = "force-dynamic";

/** 任务列表快照（任务页 TanStack Query 轮询用）。 */
export function GET() {
  const manager = getTaskManager();
  return NextResponse.json({
    tasks: manager.list(),
    lockedDeviceIds: manager.lockedDeviceIds(),
  });
}
