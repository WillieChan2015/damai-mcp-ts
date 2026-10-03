/**
 * 把 core 的只读余票监控包装成 TaskManager 任务执行体（Phase 2/3 设计 §3.1）。
 *
 * 取消语义（D3/D9）：stopEvent 直传给 {@link monitorAvailability}——其
 * `SimpleStopEvent` 结构兼容 monitor 的 `{ isSet(): boolean }`（stopEvent.ts:4-7
 * 已固化该承诺），轮询循环在每个检查点退出；候场（startAt 在未来）阶段以
 * `Promise.race([stopEvent.wait(), sleep(delay)])` 竞速，取消即提前返回。
 * 安全语义（D5）：monitorAvailability 为只读监控（仅一次深链导航 + dump 采样），
 * 绝不点击、绝不提交订单，本包装层不引入任何写入指令。
 */
import { setTimeout as sleep } from "node:timers/promises";

import {
  monitorAvailability,
  type MonitorResult,
} from "@core/damai/monitor";

import type { TaskRunner } from "./manager";
import { appendNotification, shouldNotifyMonitor, type TaskNotifyConfig } from "./taskNotify";

/** 监控任务的参数（app/monitor 的 action schema 负责业务边界校验后透传）。 */
export interface MonitorRunnerInput {
  /** 目标设备序列号。 */
  deviceId: string;
  /** 大麦场次 item id。 */
  itemId: string;
  /** 轮询间隔毫秒（表单 zod 已限 5000-3600000；库层只要求 > 0）。 */
  intervalMs: number;
  /**
   * 最大尝试次数。web 接线层必须给有限值（core 默认 0=无限，monitor.ts
   * TSDoc 明示接线层责任）；web schema 默认 720 且 min(1)。
   */
  maxAttempts: number;
  /** dump 连续失败多少次后停止；缺省走 core 默认（MONITOR_MAX_CONSECUTIVE_ERRORS=5）。 */
  maxConsecutiveErrors?: number;
  /** 开始时是否深链打开详情页（导航非点击）；缺省走 core 默认（true）。 */
  openPage?: boolean;
  /** 起始时刻（Unix 毫秒）；null/undefined/过去 = 立即采样。 */
  startAtUnixMs?: number | null;
  /** 墙钟截止（Unix 毫秒）；null/undefined = 不设截止（到达即停 "timeout"）。 */
  deadlineUnixMs?: number | null;
  /** 有序票档全文。空则整页词表。 */
  priceLabels?: readonly string[];
}

/** 北京时间 HH:mm。 */
function formatBeijingHHmm(unixMs: number): string {
  const at = new Date(unixMs + 8 * 60 * 60 * 1000);
  return `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 构造监控任务执行体。
 *
 * 进度行契约：采样行的行首格式固定为 `第 <n> 次采样: <status>`（reason /
 * nextDelayMs 为后缀），{@link parseMonitorProgressLine} 依赖该稳定性解析徽标；
 * 与 MCP 工具 damai_monitor_availability 的上报文案同构（server.ts:997-1003）。
 * 返回值 = `MonitorResult.toDict()`（全 snake_case，monitor.ts:238-260），
 * 存入 TaskSnapshot.result 供前端渲染终局徽标与 detail_url 外链。
 *
 * @param input 监控参数。
 * @param deps 测试注入点：替换底层 monitorAvailability（默认 @core 真实现）。
 */
export function makeMonitorRunner(
  input: MonitorRunnerInput,
  deps?: {
    monitor?: typeof monitorAvailability;
    notify?: TaskNotifyConfig | null;
    send?: (config: TaskNotifyConfig, text: string) => Promise<{ status: string; error: string | null }>;
  },
): TaskRunner {
  const monitor = deps?.monitor ?? monitorAvailability;
  return async ({ stopEvent, onProgress }) => {
    onProgress(
      `监控启动 device=${input.deviceId} item=${input.itemId} interval=${input.intervalMs}ms ` +
        `max_attempts=${input.maxAttempts}` +
        (input.deadlineUnixMs != null
          ? ` deadline=${new Date(input.deadlineUnixMs).toLocaleString()}`
          : ""),
    );

    // 候场：startAt 在未来时先竞速等待，取消即提前退出（不惊动设备）
    const startAtUnixMs = input.startAtUnixMs ?? null;
    if (startAtUnixMs !== null) {
      const delayMs = startAtUnixMs - Date.now();
      if (delayMs > 0) {
        onProgress(`候场至 ${formatBeijingHHmm(startAtUnixMs)}（北京时间），到点开始采样`);
        const abort = new AbortController();
        try {
          const cancelledBeforeDue = await Promise.race([
            stopEvent.wait().then(() => true as const),
            sleep(delayMs, undefined, { signal: abort.signal }).then(() => false as const),
          ]);
          if (cancelledBeforeDue) {
            // 直接 return：manager 依 stopEvent.isSet() 收敛为 cancelled，不调 monitor
            return;
          }
        } finally {
          // 输家分支（被取消）及时中止挂起的候场定时器，不留长睡任务
          abort.abort();
        }
      }
    }

    const result: MonitorResult = await monitor(input.deviceId, input.itemId, {
      intervalMs: input.intervalMs,
      maxAttempts: input.maxAttempts,
      maxConsecutiveErrors: input.maxConsecutiveErrors,
      openPage: input.openPage,
      deadlineUnixMs: input.deadlineUnixMs ?? null,
      priceLabels: input.priceLabels ?? [],
      stopEvent,
      onReport: (snapshot) => {
        const reasonText = snapshot.reason === null ? "" : `（${snapshot.reason}）`;
        const nextText =
          snapshot.nextDelayMs === null
            ? ""
            : `，${Math.round(snapshot.nextDelayMs / 1000)}s 后继续`;
        onProgress(`第 ${snapshot.attempt} 次采样: ${snapshot.status}${reasonText}${nextText}`);
      },
    });

    onProgress(
      `监控结束 stop_reason=${result.stopReason} attempts=${result.attempts} ` +
        `final_status=${result.finalStatus}`,
    );
    const dict = result.toDict();
    const notice = await appendNotification({
      config: deps?.notify ?? null,
      shouldSend: shouldNotifyMonitor(dict.found),
      text: `监控发现余票 item=${input.itemId} ${result.lastReason ?? ""}`.trim(),
      onProgress,
      send: deps?.send,
    });
    return { ...dict, ...notice };
  };
}

// 解析辅助实现在 ./monitorParse（客户端组件只从这里取，避免把 core 依赖链
// 打进浏览器 bundle）；此处 re-export 保持既有导入路径兼容。
export {
  parseMonitorProgressLine,
  isMonitorResultDict,
  type MonitorProgressSample,
  type MonitorResultDict,
} from "./monitorParse";
