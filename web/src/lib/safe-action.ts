import { createSafeActionClient } from "next-safe-action";
import { z } from "zod";

import { logPageOperation } from "./actionLog";

/**
 * Server Actions 客户端（计划 §4）。
 *
 * 约定：业务错误以中文 message 形态透出为 `result.serverError`
 * （如 TaskConflictError 的「设备已有运行中的任务」）；
 * 表单校验错误走 `result.validationErrors`（由 zod schema 生成）。
 *
 * 每个 action 用 `.metadata({ operation })` 声明操作类型。中间件只把类型、
 * 耗时和结果写入 debug 日志，不记录 clientInput。
 */
export const actionClient = createSafeActionClient({
  defineMetadataSchema() {
    return z.object({
      operation: z.string().min(1),
    });
  },
  handleServerError: (error) => (error instanceof Error ? error.message : String(error)),
}).use(async ({ next, metadata }) => {
  const startedAt = performance.now();
  const result = await next();
  if (result.serverError !== undefined) {
    logPageOperation(metadata.operation, startedAt, "failed", String(result.serverError));
  } else if (result.validationErrors !== undefined) {
    logPageOperation(metadata.operation, startedAt, "invalid");
  } else {
    logPageOperation(metadata.operation, startedAt, "ok");
  }
  return result;
});
