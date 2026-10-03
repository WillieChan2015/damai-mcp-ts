import { z } from "zod";

import { beijingWallToUnixMs } from "@core/utils/beijingTime";

/**
 * 监控任务（kind="monitor"）的 Server Action 入参 schema（Phase 2/3 设计 §3.2）。
 *
 * 字段语义与 MCP 工具 damai_monitor_availability（server.ts:970-977）一一对齐，
 * 但两处 web 特有约束：
 * - `maxAttempts` min(1)——web 接线层不给无限轮询（core 库层 0=无限语义保留，
 *   monitor.ts TSDoc 明示接线层必须给有限值；MCP 工具侧为 min(0)）；
 * - `startAt` / `endAt` 为 datetime-local 字符串（YYYY-MM-DDTHH:mm[:ss]，北京
 *   时间），由 action 转 startAtUnixMs / deadlineUnixMs 后交给 runner。
 *
 * 单独成文件的原因：actions.ts 带 "use server"，Next 规范只允许导出异步函数，
 * schema 对象必须放在本模块（测试也直接 import 本文件做直测）。
 */

/**
 * datetime-local 值（北京时间）→ Unix 毫秒；非法格式或无效日期返回 null。
 * 不读本机时区。
 */
export function datetimeLocalToUnixMs(value: string): number | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (matched === null) {
    return null;
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const hour = Number(matched[4]);
  const minute = Number(matched[5]);
  const second = matched[6] === undefined ? 0 : Number(matched[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > dim) {
    return null;
  }
  return beijingWallToUnixMs(year, month, day, hour, minute, second);
}

/** datetime-local 字符串（可空由调用方以 optional 组合）；空串不合法。 */
const datetimeLocalSchema = z.string().refine((v) => datetimeLocalToUnixMs(v) !== null, {
  message: "时间格式应为 datetime-local（如 2026-10-03T19:00）",
});

/** 监控任务入参 schema（startMonitorTask 的校验面，monitorRunner.test.ts 直测）。 */
export const monitorTaskInputSchema = z.object({
  /** 目标设备序列号。 */
  deviceId: z.string().min(1).max(128),
  /** 大麦场次 item id。 */
  itemId: z.string().min(1).max(64),
  /** 轮询间隔毫秒（与 MCP 工具同边界 5000-3600000，server.ts:972）。 */
  intervalMs: z.number().int().min(5000).max(3600000).default(30000),
  /** 最大尝试次数；web 不给无限：min(1)（MCP 工具为 min(0)=无限），默认 720。 */
  maxAttempts: z.number().int().min(1).max(100000).default(720),
  /** 开始时是否深链打开详情页（导航非点击）；默认 true。 */
  openPage: z.boolean().default(true),
  /** 起始时刻（datetime-local，北京时间）；缺省 = 立即采样。 */
  startAt: datetimeLocalSchema.optional(),
  /** 截止时刻（datetime-local，北京时间）；缺省 = 不设截止。 */
  endAt: datetimeLocalSchema.optional(),
  /** 有序票档全文。空数组表示整页词表。 */
  priceLabels: z.array(z.string().min(1).max(80)).max(6).default([]),
});

export type MonitorTaskInput = z.infer<typeof monitorTaskInputSchema>;
