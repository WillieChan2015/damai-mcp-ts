"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { damaiReadPurchaseSheet } from "@core/damai/actions";
import type { PurchaseSheetOptions } from "@core/damai/purchaseSheet";
import { grabTaskInputSchema, type GrabTaskInput } from "@core/schemas/grab";
import { parseBeijingDateTime } from "@core/utils/beijingTime";

import { actionClient } from "@/lib/safe-action";
import { prepareViewerPresets } from "@/lib/viewerPresetRules";
import { saveViewerPresetsStore } from "@/lib/viewerPresets";
import { getTaskManager } from "@/task/manager";
import { makeGrabRunner } from "@/task/grabRunner";
import { loadTaskNotifyConfig } from "@/task/taskNotify";

/** 开票时刻减去预热。已经到点则立即占锁。 */
function grabLockAtUnixMs(input: GrabTaskInput): number | undefined {
  if (input.openTime === "") {
    return undefined;
  }
  const at = parseBeijingDateTime(input.openTime).getTime() - input.preheatSeconds * 1000;
  return at > Date.now() ? at : undefined;
}

/** 启动抢票任务：立即返回 taskId，长任务由 TaskManager 承载（D3）。 */
export const startGrabTask = actionClient
  .metadata({ operation: "启动抢票" })
  .schema(grabTaskInputSchema)
  .action(async ({ parsedInput }) => {
    const notify = await loadTaskNotifyConfig();
    const snapshot = getTaskManager().start({
      kind: "grab",
      deviceId: parsedInput.deviceId,
      label: `抢票 ${parsedInput.itemId} @ ${parsedInput.deviceId}`,
      lockAtUnixMs: grabLockAtUnixMs(parsedInput),
      runner: makeGrabRunner(parsedInput, notify),
    });
    revalidatePath("/tasks");
    return { taskId: snapshot.id, status: snapshot.status };
  });

/** 覆盖保存观演人快捷姓名。不 revalidate：避免刷新任务表单丢掉尚未提交的输入。 */
export const saveViewerPresets = actionClient
  .metadata({ operation: "保存观演人快捷项" })
  .schema(
    z.object({
      names: z.array(z.string()),
    }),
  )
  .action(async ({ parsedInput }) => {
    const prepared = prepareViewerPresets(parsedInput.names);
    if (!prepared.ok) {
      throw new Error(prepared.error);
    }
    const names = saveViewerPresetsStore(prepared.names);
    return { names };
  });

/** 打开购买弹层，读出场次和票档。不点「确定」。设备上已有任务时拒绝。 */
export const readPurchaseSheet = actionClient
  .metadata({ operation: "读取场次与票档" })
  .schema(
    z.object({
      deviceId: z.string().min(1),
      itemId: z.string().min(1),
    }),
  )
  .action(async ({ parsedInput }): Promise<PurchaseSheetOptions> => {
    if (getTaskManager().lockedDeviceIds().includes(parsedInput.deviceId)) {
      throw new Error(`设备 ${parsedInput.deviceId} 已有运行中的任务，请先停止后再读取场次与票档`);
    }
    return damaiReadPurchaseSheet(parsedInput.deviceId, parsedInput.itemId);
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
