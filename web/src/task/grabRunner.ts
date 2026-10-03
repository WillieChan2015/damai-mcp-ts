import { runChecklist } from "@core/damai/checklist";
import type { GrabTaskInput } from "@core/schemas/grab";

import type { TaskRunner } from "./manager";
import { appendNotification, shouldNotifyGrab, type TaskNotifyConfig } from "./taskNotify";

/**
 * 把共享 schema 的抢票参数包装成 TaskManager 任务执行体（Phase 1）。
 *
 * 取消语义（D3/D9）：stopEvent 穿线进 runChecklist——候场（countdownLoop /
 * waitForSaleStart）在下一个检查点提前返回，Phase 4 fire 不再执行；已进入
 * grab_fire 的流程无法中断（checklist 内部 60s 硬停止兜底）。
 * 安全语义（D5）：不向 core 传 confirmOrder（core 默认 false）——取消的流程
 * 即使跑到选人完成，也只会停在 ready_for_human，绝不提交订单、绝不碰支付。
 */
export function makeGrabRunner(
  input: GrabTaskInput,
  notify: TaskNotifyConfig | null = null,
  deps?: {
    send?: (config: TaskNotifyConfig, text: string) => Promise<{ status: string; error: string | null }>;
  },
): TaskRunner {
  return async ({ stopEvent, onProgress }) => {
    onProgress(
      `任务启动 device=${input.deviceId} item=${input.itemId} ` +
        `场次=${input.sessionLabel || input.sessionIndex} 票档=${input.priceLabel || input.priceIndex} ` +
        `观演人=${input.viewerNames?.length ?? 0} 人 open_time=${input.openTime || "立即抢"}`,
    );
    const result = await runChecklist(input.deviceId, input.itemId, {
      openTime: input.openTime,
      sessionIndex: input.sessionIndex,
      sessionLabel: input.sessionLabel,
      priceIndex: input.priceIndex,
      priceLabel: input.priceLabel,
      priceFallbacks: input.priceFallbacks,
      viewerNames: input.viewerNames ?? null,
      ticketNum: input.ticketNum,
      preheatSeconds: input.preheatSeconds,
      clockOffsetMs: input.clockOffsetMs,
      stopEvent,
      onPhase: (phase) => onProgress(`阶段 → ${phase}`),
      onClock: (fix) =>
        onProgress(
          `校时 source=${fix.source} offset=${fix.offsetMs}ms uncertainty=${fix.uncertaintyMs ?? "n/a"}ms`,
        ),
      onProgress: (secondsLeft, elapsedS) =>
        onProgress(`开票倒计时 ${secondsLeft}s（已候场 ${elapsedS}s）`),
    });
    onProgress(
      `任务结束 status=${result.status}${result.error ? ` error=${result.error}` : ""}`,
    );
    const dict = result.toDict();
    const notice = await appendNotification({
      config: notify,
      shouldSend: shouldNotifyGrab(dict.status) || shouldNotifyGrab(dict.grab_result?.status),
      text: `抢票${dict.status === "submitted" ? "已提交" : "待人工确认"} item=${input.itemId}`,
      onProgress,
      send: deps?.send,
    });
    return { ...dict, ...notice };
  };
}
