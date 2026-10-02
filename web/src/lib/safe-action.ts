import { createSafeActionClient } from "next-safe-action";

/**
 * Server Actions 客户端（计划 §4）。
 *
 * 约定：业务错误以中文 message 形态透出为 `result.serverError`
 * （如 TaskConflictError 的「设备已有运行中的任务」）；
 * 表单校验错误走 `result.validationErrors`（由 zod schema 生成）。
 */
export const actionClient = createSafeActionClient({
  handleServerError: (error) => (error instanceof Error ? error.message : String(error)),
});
