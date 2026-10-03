import type { NotifyFieldStatus, NotifyStatusSnapshot } from "./notifyConfig";

/** 来源 → 中文标注。 */
const SOURCE_LABEL: Record<NotifyFieldStatus["source"], string> = {
  env: "环境变量",
  file: "本地凭证文件",
  none: "未配置",
};

/** 单字段行：名称 + 展示值（token/context_token 已是掩码）+ 来源标注。 */
function FieldRow({ label, status }: { label: string; status: NotifyFieldStatus }) {
  return (
    <li className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-b-0">
      <span className="font-mono text-xs font-semibold text-ink">{label}</span>
      {status.configured ? (
        <span className="text-right text-xs">
          <code className="font-mono text-xs text-ink">{status.display}</code>
          <span className="ml-2 text-muted">
            （{SOURCE_LABEL[status.source]}）
          </span>
        </span>
      ) : (
        <span className="text-xs text-danger font-medium">未配置</span>
      )}
    </li>
  );
}

/**
 * 配置完整性检查卡。
 */
export function NotifyStatusCard({ snapshot }: { snapshot: NotifyStatusSnapshot }) {
  return (
    <section className="panel p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">配置完整性检查</h2>
        <span className="font-mono text-xs text-muted">ClawBot 三要素</span>
      </div>
      <p className="text-xs text-muted">
        回落顺序：环境变量（DAMAI_CLAWBOT_*）→ 本地凭证文件（~/.config/damai-mcp-ts/notify.json）→ 未配置。token 与 context_token 仅显示掩码，完整值不会回传到页面。
      </p>
      <ul className="rounded-lg border border-line bg-surface-raised px-4 py-1">
        <FieldRow label="origin" status={snapshot.origin} />
        <FieldRow label="token" status={snapshot.token} />
        <FieldRow label="context_token" status={snapshot.contextToken} />
      </ul>
      {snapshot.ready ? (
        <div className="rounded border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok font-medium">
          三要素已齐备，微信通知通道处于就绪状态，可立即发送测试通知。
        </div>
      ) : (
        <div className="rounded border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          配置未齐备：可展开下方高级选项手填凭证完成单次测试发送（不持久化），或参考下方指引完成环境配置。
        </div>
      )}
    </section>
  );
}
