"use server";

import { revalidatePath } from "next/cache";

import { actionClient } from "@/lib/safe-action";
import { getTaskManager } from "@/task/manager";
import { makeMonitorRunner } from "@/task/monitorRunner";
import { loadTaskNotifyConfig } from "@/task/taskNotify";

import { datetimeLocalToUnixMs, monitorTaskInputSchema } from "./schema";

/**
 * 启动余票监控任务：立即返回 taskId，长任务由 TaskManager 承载（D3）。
 *
 * kind="monitor" 已在 TaskKind（manager.ts:21）⇒ 同设备互斥与 SSE 进度订阅
 * 免费获得；取消不在此重复实现——前端直接复用 @/app/tasks/actions 的 cancelTask。
 */
export const startMonitorTask = actionClient
  .metadata({ operation: "启动监控" })
  .schema(monitorTaskInputSchema)
  .action(async ({ parsedInput }) => {
    const notify = await loadTaskNotifyConfig();
    const snapshot = getTaskManager().start({
      kind: "monitor",
      deviceId: parsedInput.deviceId,
      label: `监控 ${parsedInput.itemId} @ ${parsedInput.deviceId}`,
      runner: makeMonitorRunner(
        {
          deviceId: parsedInput.deviceId,
          itemId: parsedInput.itemId,
          intervalMs: parsedInput.intervalMs,
          maxAttempts: parsedInput.maxAttempts,
          openPage: parsedInput.openPage,
          startAtUnixMs: parsedInput.startAt ? datetimeLocalToUnixMs(parsedInput.startAt) : null,
          deadlineUnixMs: parsedInput.endAt ? datetimeLocalToUnixMs(parsedInput.endAt) : null,
          priceLabels: parsedInput.priceLabels,
        },
        { notify },
      ),
    });
    revalidatePath("/monitor");
    return { taskId: snapshot.id, status: snapshot.status };
  });
