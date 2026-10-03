/**
 * 通知凭证（origin / token / context_token）来源解析——通知页与测试发送共用。
 *
 * 回落顺序与 MCP 工具 notify_send 一致（src/server.ts:1044-1046）并扩展文件回落：
 *   手填（仅测试发送）> 环境变量 DAMAI_CLAWBOT_* > 本地凭证文件 > 未配置。
 * 文件回落走 loadNotifyCredentials（缺失/损坏返回 null 不抛，credentials.ts:140）。
 *
 * 安全语义：token / context_token 对外只给 redactToken 掩码（credentials.ts:204）；
 * origin 非敏感，明文展示。本模块不发任何网络请求、不写凭证文件、不打日志。
 */

import { loadNotifyCredentials, redactToken } from "@core/notify/credentials";

/** 单个凭证字段的来源。 */
export type NotifyFieldSource = "env" | "file" | "none";

/** 单个凭证字段的展示状态（通知页「配置完整性检查」的逐字段结果）。 */
export interface NotifyFieldStatus {
  /** 是否已配置（env 或文件任一来源有值）。 */
  configured: boolean;
  /** 来源：环境变量 / 本地凭证文件 / 未配置。 */
  source: NotifyFieldSource;
  /** 展示值：origin 非敏感明文；token / context_token 为掩码；未配置为 null。 */
  display: string | null;
}

/** 通知页配置完整性检查快照（三要素逐字段 + 总体就绪位）。 */
export interface NotifyStatusSnapshot {
  origin: NotifyFieldStatus;
  token: NotifyFieldStatus;
  contextToken: NotifyFieldStatus;
  /** 三要素齐备——满足时才建议直接点「发送测试通知」。 */
  ready: boolean;
}

/** 解析出的完整三要素（仅在齐备时返回，供 ClawBotClient 构造）。 */
export interface ResolvedNotifyCredentials {
  origin: string;
  token: string;
  contextToken: string;
}

/** 读取环境变量；未设置或空串一律视为未配置。 */
function envOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** 手填 > env > 文件 的单字段回落：返回第一个非 undefined 的值。 */
function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** 组装字段展示状态：mask=true 时 token/context_token 只留掩码。 */
function fieldStatus(
  value: string | undefined,
  fromEnv: boolean,
  mask: boolean,
): NotifyFieldStatus {
  if (value === undefined) {
    return { configured: false, source: "none", display: null };
  }
  return {
    configured: true,
    source: fromEnv ? "env" : "file",
    display: mask ? redactToken(value) : value,
  };
}

/**
 * 通知页（RSC）用：逐字段快照。origin 明文、token/context_token 掩码；
 * 每字段来源标注 env / file / none，供页面渲染「已配置（来源：…）或 未配置」。
 */
export async function loadNotifyStatusSnapshot(): Promise<NotifyStatusSnapshot> {
  const file = await loadNotifyCredentials();
  const originEnv = envOrUndefined("DAMAI_CLAWBOT_ORIGIN");
  const tokenEnv = envOrUndefined("DAMAI_CLAWBOT_TOKEN");
  const contextTokenEnv = envOrUndefined("DAMAI_CLAWBOT_CONTEXT_TOKEN");
  const origin = firstDefined(originEnv, file?.origin);
  const token = firstDefined(tokenEnv, file?.token);
  const contextToken = firstDefined(contextTokenEnv, file?.contextToken);
  return {
    origin: fieldStatus(origin, originEnv !== undefined, false),
    token: fieldStatus(token, tokenEnv !== undefined, true),
    contextToken: fieldStatus(contextToken, contextTokenEnv !== undefined, true),
    ready: origin !== undefined && token !== undefined && contextToken !== undefined,
  };
}

/**
 * 测试发送（Server Action）用：按 手填 > env > 文件 逐字段解析三要素。
 *
 * @param manual 高级折叠区手填的凭证（均可缺省 = 用已配置凭证）。
 * @returns credentials 三要素齐备时的完整凭证；missingLines 非空时的中文缺项清单
 *          （每项点名字段与对应环境变量名）。二者互斥。
 */
export async function resolveNotifyCredentials(
  manual: { origin?: string; token?: string; contextToken?: string },
): Promise<{ credentials: ResolvedNotifyCredentials | null; missingLines: string[] }> {
  const file = await loadNotifyCredentials();
  const origin = firstDefined(manual.origin, envOrUndefined("DAMAI_CLAWBOT_ORIGIN"), file?.origin);
  const token = firstDefined(manual.token, envOrUndefined("DAMAI_CLAWBOT_TOKEN"), file?.token);
  const contextToken = firstDefined(
    manual.contextToken,
    envOrUndefined("DAMAI_CLAWBOT_CONTEXT_TOKEN"),
    file?.contextToken,
  );
  const missingLines: string[] = [];
  if (origin === undefined) {
    missingLines.push("缺少 origin：请设置环境变量 DAMAI_CLAWBOT_ORIGIN 或在高级选项中填写");
  }
  if (token === undefined) {
    missingLines.push("缺少 token：请设置环境变量 DAMAI_CLAWBOT_TOKEN 或在高级选项中填写");
  }
  if (contextToken === undefined) {
    missingLines.push(
      "缺少 context_token：请设置环境变量 DAMAI_CLAWBOT_CONTEXT_TOKEN 或在高级选项中填写",
    );
  }
  if (origin === undefined || token === undefined || contextToken === undefined) {
    return { credentials: null, missingLines };
  }
  return { credentials: { origin, token, contextToken }, missingLines: [] };
}

/** 缺项清单 → serverError 中文文案（首行汇总 + 逐项点名）。 */
export function missingCredentialsMessage(missingLines: string[]): string {
  return `通知凭证配置不完整，缺少 ${missingLines.length} 项：${missingLines.join("；")}。`;
}
