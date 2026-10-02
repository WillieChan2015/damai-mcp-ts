/**
 * damai-mcp-ts: Android Emulator MCP for ticket-grabbing automation.
 *
 * 对应 Python `damai_mcp/__init__.py` 的公共面：
 *     __all__ = ["mcp", "main", "__version__"]
 * （`__version__` 在 TS 里以 {@link VERSION} 具名导出。）
 */

export { mcp, VERSION } from "./server";
export { main } from "./cli";

// ---- 本轮新增模块的公共 API（docs/improvements-from-competitors.md §7.1） ----

// 只读余票监控（src/damai/monitor.ts）
export { classifyAvailability, monitorAvailability, MonitorResult } from "./damai/monitor";
export type {
  Availability,
  ClassifyAvailabilityOptions,
  MonitorJudge,
  MonitorOptions,
  MonitorReportCallback,
  MonitorReportSnapshot,
  MonitorResultInit,
  MonitorStopReason,
} from "./damai/monitor";

// 微信 ClawBot 文本通知（src/notify/wechat.ts）
export { ClawBotBodyTooLargeError, ClawBotClient, createFetchTransport } from "./notify/wechat";
export type {
  ClawBotConfig,
  ClawBotRequest,
  ClawBotResponse,
  ClawBotTransport,
  SendOutcome,
  SendStatus,
} from "./notify/wechat";
