import { z } from "zod";

/**
 * Web 控制台与 MCP 工具共享的任务参数 schema（计划 Phase 1）。
 *
 * 字段语义与 `src/server.ts` 的 `damai_grab` / `connect_device` 工具一一对齐：
 * - `sessionLabel` / `priceLabel` 为购买弹层上的卡片全文；非空时按文字点选。
 *   为空时才用 `sessionIndex` / `priceIndex`（均为 1-based）；
 * - `openTime` 为 'YYYY-MM-DD HH:MM:SS'（按北京时间解析，不读本机时区），
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
  /** 场次序号（1-based）。`sessionLabel` 非空时忽略。 */
  sessionIndex: z.number().int().min(1).max(20).default(1),
  /** 场次卡片全文。空串表示改用序号。 */
  sessionLabel: z.string().max(80).default(""),
  /** 票档序号（1-based）。`priceLabel` 非空时忽略。 */
  priceIndex: z.number().int().min(1).max(50).default(1),
  /** 票档卡片全文，例如「内场988元」。空串表示改用序号。 */
  priceLabel: z.string().max(80).default(""),
  /** 主档之后按顺序尝试的票档全文。不含主档，最多 5 个。 */
  priceFallbacks: z.array(z.string().min(1).max(80)).max(5).default([]),
  /** 观演人姓名列表（大麦实名制）；null = 不选择（App 自动带入）。 */
  viewerNames: z.array(z.string().min(1)).max(6).nullable().default(null),
  /** 购票张数。大于 1 时在购买弹层里点增加并读回。 */
  ticketNum: z.number().int().min(1).max(6).default(1),
  /** 开票时间 'YYYY-MM-DD HH:MM:SS'（北京时间）；空串 = 立即抢。 */
  openTime: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)])
    .default(""),
  /** 开票前多少秒开始预热（详情页 + warm dump）。 */
  preheatSeconds: z.number().min(0).max(3600).default(30),
  /**
   * 手动时钟修正（毫秒）。null 表示自动校时。
   * 填了数字（含 0）就跳过 NTP 和公共时间接口。
   */
  clockOffsetMs: z.number().finite().nullable().default(null),
}).superRefine((value, ctx) => {
  const names = (value.viewerNames ?? []).map((name) => name.trim()).filter((name) => name !== "");
  if (names.length > 0 && names.length !== value.ticketNum) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `观演人数（${names.length}）必须等于购票张数（${value.ticketNum}）`,
      path: ["viewerNames"],
    });
  }
  const primary = value.priceLabel.trim();
  if (primary !== "" && value.priceFallbacks.some((label) => label.trim() === primary)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "主档不能重复进备选",
      path: ["priceFallbacks"],
    });
  }
});

export type GrabTaskInput = z.infer<typeof grabTaskInputSchema>;
