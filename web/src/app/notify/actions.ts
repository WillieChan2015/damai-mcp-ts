"use server";

import { ClawBotClient } from "@core/notify/wechat";

import { actionClient } from "@/lib/safe-action";

import { missingCredentialsMessage, resolveNotifyCredentials } from "./notifyConfig";
import { DEFAULT_TEST_TEXT, describeSendOutcome, notifyTransport, sendTestSchema } from "./testSend";

/** 测试发送单次请求的超时（设计 §4.3：timeoutMs 10_000）。 */
const SEND_TIMEOUT_MS = 10_000;

/**
 * 发送测试通知（通知页「测试发送」）。
 *
 * 行为：凭证 = 手填（高级折叠区）> env（DAMAI_CLAWBOT_*）> 本地凭证文件；
 * 缺项 → serverError 中文缺项清单（逐项点名字段与环境变量名）。
 * 发送失败不抛错——sendText 返回 SendOutcome（wechat.ts:203-215）原样回传并附
 * describeSendOutcome 的中文释义；origin 非法等由 constructor 抛中文错走 serverError。
 *
 * 安全：服务端不回传完整 token；不调用 saveNotifyCredentials（web 不写凭证文件）；
 * 本模块不打任何日志。
 */
export const sendTestNotification = actionClient
  .schema(sendTestSchema)
  .action(async ({ parsedInput }) => {
    const { credentials, missingLines } = await resolveNotifyCredentials({
      origin: parsedInput.origin,
      token: parsedInput.token,
      contextToken: parsedInput.contextToken,
    });
    if (credentials === null) {
      throw new Error(missingCredentialsMessage(missingLines));
    }
    const client = new ClawBotClient(
      { origin: credentials.origin, token: credentials.token, timeoutMs: SEND_TIMEOUT_MS },
      notifyTransport(),
    );
    const outcome = await client.sendText(
      parsedInput.target,
      credentials.contextToken,
      parsedInput.text ?? DEFAULT_TEST_TEXT,
    );
    return {
      status: outcome.status,
      clientId: outcome.clientId,
      error: outcome.error,
      httpStatus: outcome.httpStatus,
      elapsedMs: outcome.elapsedMs,
      hint: describeSendOutcome(outcome),
    };
  });
