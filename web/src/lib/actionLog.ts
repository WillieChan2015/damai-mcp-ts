import { logger } from "@core/utils/logging";

/** 页面操作结束形态。流式接口在返回响应时记「已受理」，不等待流结束。 */
export type PageOperationOutcome = "ok" | "failed" | "invalid" | "accepted";

const OUTCOME_LABEL: Record<PageOperationOutcome, string> = {
  ok: "完成",
  failed: "失败",
  invalid: "校验未通过",
  accepted: "已受理",
};

/**
 * 按操作类型写一条 debug 日志（类型 + 耗时 + 结果）。
 *
 * 不记录入参：通知测试、AI 设置的请求体里有凭证。失败详情只取已对用户展示的
 * 短文案，并压成一行、截断到 200 字。
 */
export function logPageOperation(
  operation: string,
  startedAt: number,
  outcome: PageOperationOutcome,
  detail?: string,
): void {
  const ms = Math.max(0, Math.round(performance.now() - startedAt));
  const tail =
    outcome === "failed" && detail !== undefined && detail.trim() !== ""
      ? `：${detail.replace(/\s+/g, " ").trim().slice(0, 200)}`
      : "";
  logger.debug(`页面操作 ${operation} ${OUTCOME_LABEL[outcome]}，耗时 ${ms}ms${tail}`);
}
