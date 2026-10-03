import { NOTIFY_CREDENTIALS_FILE_DEFAULT } from "@core/notify/credentials";

import { NotifyStatusCard } from "./NotifyStatusCard";
import { SendTestForm } from "./SendTestForm";
import { loadNotifyStatusSnapshot } from "./notifyConfig";
import { PageHeader } from "@/components/console";

export const dynamic = "force-dynamic";

export const metadata = { title: "通知 · Damai Console" };

/**
 * 通知页（设计 §4）：配置完整性检查 + 测试发送 + 绑定指引。
 *
 * 定位（技术决策 4）：core ClawBotClient 公开 API 只有
 * constructor + sendText（src/notify/wechat.ts:217,260），无二维码绑定/状态查询
 * 协议（模块头 wechat.ts:5-7 明确排除）——本页面不新增协议、不保存凭证。
 */
export default async function NotifyPage() {
  const snapshot = await loadNotifyStatusSnapshot();

  return (
    <div className="space-y-6">
      <PageHeader
        title="微信通知通道"
        lede="微信 ClawBot 机器人三要素连通性检查、测试下发与通道配置指引；核心库仅通过 sendText 单端点通信，绝不在磁盘持久化任何明文凭证。"
      />

      <NotifyStatusCard snapshot={snapshot} />
      <SendTestForm ready={snapshot.ready} />

      <details className="rounded-[10px] border border-line bg-card p-6">
        <summary className="cursor-pointer text-base font-semibold text-ink">
          绑定指引
        </summary>
        <div className="mt-3 space-y-3 text-sm text-muted">
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              在 ClawBot 后台获取三要素：服务 origin（https，host ∈ *.ilinkai.weixin.qq.com）、
              Bearer token、会话 context_token。
            </li>
            <li>
              方式一（推荐）：设置环境变量{" "}
              <code className="font-mono text-xs">DAMAI_CLAWBOT_ORIGIN</code>、{" "}
              <code className="font-mono text-xs">DAMAI_CLAWBOT_TOKEN</code>、{" "}
              <code className="font-mono text-xs">DAMAI_CLAWBOT_CONTEXT_TOKEN</code>{" "}
              后重启控制台（cli 启动注入的环境变量会传给 web 进程）。
            </li>
            <li>
              方式二：手动放置本地凭证文件{" "}
              <code className="font-mono text-xs">~/.config/damai-mcp-ts/notify.json</code>
              （本机实际路径：<code className="font-mono text-xs">{NOTIFY_CREDENTIALS_FILE_DEFAULT}</code>
              ，设置了 XDG_CONFIG_HOME 时跟随其值），内容形如{" "}
              <code className="font-mono text-xs">
                {`{"origin":"…","token":"…","contextToken":"…"}`}
              </code>
              ，并执行 <code className="font-mono text-xs">chmod 600</code> 收紧权限。
            </li>
          </ol>
          <p className="rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs text-muted">
            本页面不保存凭证、不实现绑定协议：凭证只在发送当次使用，永不写盘（不调用 saveNotifyCredentials）；二维码绑定与状态查询请到 ClawBot 侧完成，之后更新上述配置即可。
          </p>
        </div>
      </details>
    </div>
  );
}
