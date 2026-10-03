import { z } from "zod";

import { logPageOperation } from "@/lib/actionLog";
import { getAiSettingsStatus, saveAiSettings } from "@/lib/aiConfig";

export const dynamic = "force-dynamic";

/**
 * AI 设置路由（设计 §8.4）。
 *
 * - GET：回 {@link getAiSettingsStatus} 掩码状态（apiKey 只回 maskedKey，
 *   原文永不出现；no-store 防中间层缓存）。
 * - POST：zod 校验 `{baseUrl, apiKey, model}` → saveAiSettings（0600 原子写）
 *   → 回最新 status；非法 body → 400 中文（逐字段点名）。
 * - 鉴权由 src/proxy.ts 的 matcher 统一覆盖，本路由不自行实现鉴权。
 */

/** POST 请求体校验：baseUrl 须为合法 URL，apiKey / model 非空（缺失与空串都给中文文案）。 */
const aiSettingsSchema = z.object({
  baseUrl: z
    .string({
      required_error: "Base URL 不能为空",
      invalid_type_error: "Base URL 必须是字符串",
    })
    .url({ message: "Base URL 必须是合法的 URL（如 https://api.example.com/v1）" }),
  apiKey: z
    .string({ required_error: "API Key 不能为空", invalid_type_error: "API Key 必须是字符串" })
    .min(1, "API Key 不能为空"),
  model: z
    .string({ required_error: "模型名不能为空", invalid_type_error: "模型名必须是字符串" })
    .min(1, "模型名不能为空"),
});

/** 把 zod 校验失败整理成中文逐字段错误行。 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}：${issue.message}`)
    .join("；");
}

/** 状态 JSON（统一 no-store；Response.json 与仓库其他 route.ts 先例一致）。 */
function statusResponse(status: number): Response {
  return Response.json(getAiSettingsStatus(), {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(): Promise<Response> {
  return statusResponse(200);
}

export async function POST(req: Request): Promise<Response> {
  const startedAt = performance.now();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    logPageOperation("保存 AI 设置", startedAt, "invalid");
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const parsed = aiSettingsSchema.safeParse(body);
  if (!parsed.success) {
    logPageOperation("保存 AI 设置", startedAt, "invalid");
    return Response.json(
      { error: `AI 设置校验失败：${formatIssues(parsed.error)}` },
      { status: 400 },
    );
  }
  try {
    await saveAiSettings(parsed.data);
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    logPageOperation("保存 AI 设置", startedAt, "failed", message);
    return Response.json({ error: message }, { status: 500 });
  }
  logPageOperation("保存 AI 设置", startedAt, "ok");
  return statusResponse(200);
}
