/**
 * 测试发送的共享契约（普通模块，非 "use server"：供 Server Action、客户端表单与
 * 测试共用）。
 *
 * 拆出本文件的原因：Next 的 "use server" 模块只允许导出异步函数——zod schema、
 * 纯函数 describeSendOutcome 与 transport 注入开关必须放在普通模块里。
 *
 * transport 注入与 core 的 setNotifyCredentialsDirForTests（src/notify/credentials.ts:72）
 * 同一模式：测试先注入 fake transport 再调用 action，用后传 null 复位。
 * 缺省 transport 为 createFetchTransport（wechat.ts:122）——显式调用才会出网。
 */

import { z } from "zod";

import { createFetchTransport, type ClawBotTransport, type SendOutcome } from "@core/notify/wechat";

/** 缺省测试文案：表单 text 留空时使用（schema 层已限制手填 ≤ 2000 字）。 */
export const DEFAULT_TEST_TEXT =
  "Damai Web 控制台测试通知：这是一条验证 ClawBot 通知通道配置的测试消息。";

/** sendTestNotification 的输入 schema（设计文档 §4.3；错误信息一律中文）。 */
export const sendTestSchema = z.object({
  /** 接收人（ClawBot 载荷 to_user_id），必填。 */
  target: z.string({ required_error: "缺少 target：请填写接收人" }).min(1, "target 不能为空"),
  /** 文本内容，可选；留空用 {@link DEFAULT_TEST_TEXT}。 */
  text: z.string().min(1, "text 不能为空").max(2000, "text 长度不能超过 2000 字").optional(),
  /** 高级折叠区：手填 origin；留空用已配置凭证（env > 文件）。 */
  origin: z.string().url("origin 必须是合法 URL（https://…）").optional(),
  /** 高级折叠区：手填 token；留空用已配置凭证。 */
  token: z.string().min(1, "token 不能为空").optional(),
  /** 高级折叠区：手填 context_token；留空用已配置凭证。 */
  contextToken: z.string().min(1, "context_token 不能为空").optional(),
});

/** 测试发送的输出：SendOutcome 五字段 + hint 中文释义（服务端生成后一并回传）。 */
export interface SendTestResult extends SendOutcome {
  /** 四态中文释义，由 {@link describeSendOutcome} 生成。 */
  hint: string;
}

/** 测试注入的 transport 覆盖；null = 恢复默认 fetch 传输。 */
let transportOverride: ClawBotTransport | null = null;

/**
 * 覆盖测试发送使用的 transport（仅供测试注入 fake；null 恢复默认）。
 *
 * 与仓库内其他 `*ForTests` 开关同一模式：测试 beforeEach 注入、afterEach 传 null 复位。
 */
export function setNotifyTransportForTests(transport: ClawBotTransport | null): void {
  transportOverride = transport;
}

/** 当前生效的 transport：注入优先；缺省 {@link createFetchTransport}。 */
export function notifyTransport(): ClawBotTransport {
  return transportOverride ?? createFetchTransport();
}

/**
 * SendOutcome → 四态中文释义（纯函数，设计 §4.3）：
 *   sent=已送达 / failed=发送失败 / expired=会话过期需重新绑定 /
 *   timeout_unknown=超时未知，如需重试请携带 clientId 重发——服务端按 client_id
 *   幂等去重（wechat.ts:249-255 的核心幂等语义）。
 *
 * @param outcome sendText 的返回值（失败不抛错，一律经此释义）。
 */
export function describeSendOutcome(outcome: SendOutcome): string {
  switch (outcome.status) {
    case "sent":
      return "已送达：测试通知已成功发送到 ClawBot。";
    case "failed":
      return outcome.error === null ? "发送失败：未知错误。" : `发送失败：${outcome.error}`;
    case "expired":
      return `会话过期：${outcome.error ?? "登录状态已失效"}。请在 ClawBot 后台重新绑定后重试（见页面下方绑定指引）。`;
    case "timeout_unknown":
      return (
        "超时未知：请求可能已被服务端受理，为避免重复提醒不会自动重发；" +
        `如确需重试，请携带 client_id=${outcome.clientId} 重发——服务端按 client_id 幂等去重。`
      );
  }
}
