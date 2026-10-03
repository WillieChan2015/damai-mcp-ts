"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { grabTaskInputSchema } from "@core/schemas/grab";

import { actionClient } from "@/lib/safe-action";
import { getTaskManager } from "@/task/manager";
import { makeGrabRunner } from "@/task/grabRunner";

/** 启动抢票任务：立即返回 taskId，长任务由 TaskManager 承载（D3）。 */
export const startGrabTask = actionClient
  .metadata({ operation: "启动抢票" })
  .schema(grabTaskInputSchema)
  .action(async ({ parsedInput }) => {
    const snapshot = getTaskManager().start({
      kind: "grab",
      deviceId: parsedInput.deviceId,
      label: `抢票 ${parsedInput.itemId} @ ${parsedInput.deviceId}`,
      runner: makeGrabRunner(parsedInput),
    });
    revalidatePath("/tasks");
    return { taskId: snapshot.id, status: snapshot.status };
  });

/** 取消任务：置位 stopEvent；候场阶段在下一个检查点退出（D9）。 */
export const cancelTask = actionClient
  .metadata({ operation: "取消任务" })
  .schema(z.object({ taskId: z.string().min(1) }))
  .action(async ({ parsedInput }) => {
    const snapshot = getTaskManager().cancel(parsedInput.taskId, {
      forceAfterMs: 60000,
    });
    revalidatePath("/tasks");
    return { status: snapshot.status, unresponsive: snapshot.unresponsive };
  });
