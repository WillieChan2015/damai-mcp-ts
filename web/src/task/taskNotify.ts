import { ClawBotClient } from "@core/notify/wechat";

import { resolveNotifyCredentials } from "@/app/notify/notifyConfig";

/** 任务启动时抄下的通知配置。之后改设置不影响这场任务。 */
export interface TaskNotifyConfig {
  origin: string;
  token: string;
  contextToken: string;
  target: string;
}

export interface NotificationFields {
  notification_status?: string;
  notification_error?: string | null;
}

/** 四项缺一则视为未配置。请求不在这里发出。 */
export async function loadTaskNotifyConfig(): Promise<TaskNotifyConfig | null> {
  const target = process.env.DAMAI_CLAWBOT_TARGET;
  if (target === undefined || target === "") {
    return null;
  }
  const resolved = await resolveNotifyCredentials({});
  if (resolved.credentials === null) {
    return null;
  }
  return { ...resolved.credentials, target };
}

export function shouldNotifyGrab(status: unknown): boolean {
  return status === "submitted" || status === "ready_for_human";
}

export function shouldNotifyMonitor(found: unknown): boolean {
  return found === true;
}

/** 恰好发送一次。失败只返回通知字段，调用方不得据此改任务结果。 */
export async function appendNotification(options: {
  config: TaskNotifyConfig | null;
  shouldSend: boolean;
  text: string;
  onProgress: (line: string) => void;
  send?: (config: TaskNotifyConfig, text: string) => Promise<{ status: string; error: string | null }>;
}): Promise<NotificationFields> {
  if (!options.shouldSend) {
    return {};
  }
  if (options.config === null) {
    options.onProgress("微信通知未发送：未配置");
    return { notification_status: "unconfigured", notification_error: null };
  }
  const send = options.send ?? sendWithClawBot;
  try {
    const outcome = await send(options.config, options.text);
    const detail = outcome.error === null ? "" : `：${outcome.error}`;
    options.onProgress(`微信通知 ${outcome.status}${detail}`);
    return { notification_status: outcome.status, notification_error: outcome.error };
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    options.onProgress(`微信通知失败：${message}`);
    return { notification_status: "failed", notification_error: message };
  }
}

async function sendWithClawBot(
  config: TaskNotifyConfig,
  text: string,
): Promise<{ status: string; error: string | null }> {
  const client = new ClawBotClient({ origin: config.origin, token: config.token });
  const outcome = await client.sendText(config.target, config.contextToken, text);
  return { status: outcome.status, error: outcome.error };
}
