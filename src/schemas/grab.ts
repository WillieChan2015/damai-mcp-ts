import { z } from "zod";

/**
 * Web 控制台与 MCP 工具共享的任务参数 schema（计划 Phase 1）。
 *
 * 字段语义与 `src/server.ts` 的 `damai_grab` / `connect_device` 工具一一对齐：
 * - `priceIndex` 1-based 票档序号；
 * - `openTime` 为 'YYYY-MM-DD HH:MM:SS'（按本地时区解析，MIGRATION_NOTES §2.3），
 *   空串表示「立即抢」；
 * - `confirmOrder` **不出现在 web 表单**：web runner 恒以 false 调用 core（D5，
 *   永不自动提交/支付）；此处的字段集仅覆盖 web 流程实际使用的参数。
 */

/** 连接设备（connect_device 语义：'127.0.0.1:5555'、序列号或 'ip:port'）。 */
export const deviceConnectSchema = z.object({
  hostPort: z.string().min(1).max(128),
});

export type DeviceConnectInput = z.infer<typeof deviceConnectSchema>;

/** 断开设备。 */
export const deviceDisconnectSchema = z.object({
  deviceId: z.string().min(1).max(128),
});

export type DeviceDisconnectInput = z.infer<typeof deviceDisconnectSchema>;

/** 抢票任务参数（runChecklist / damaiGrab 链路的 web 表面）。 */
export const grabTaskInputSchema = z.object({
  /** 目标设备序列号。 */
  deviceId: z.string().min(1).max(128),
  /** 大麦 item id。网页端可由当前页或分享内容填入。 */
  itemId: z.string().min(1, "请先读取手机上的演出，或粘贴分享内容").max(64),
  /** 票档序号（1-based）。 */
  priceIndex: z.number().int().min(1).max(50).default(1),
  /** 观演人姓名列表（大麦实名制）；null = 不选择（App 自动带入）。 */
  viewerNames: z.array(z.string().min(1)).max(20).nullable().default(null),
  /** 购票张数（与 core 一致：签名保留，张数逻辑未实现）。 */
  ticketNum: z.number().int().min(1).max(50).default(1),
  /** 开票时间 'YYYY-MM-DD HH:MM:SS'（本地时区）；空串 = 立即抢。 */
  openTime: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)])
    .default(""),
  /** 开票前多少秒开始预热（详情页 + warm dump）。 */
  preheatSeconds: z.number().min(0).max(3600).default(30),
});

export type GrabTaskInput = z.infer<typeof grabTaskInputSchema>;
