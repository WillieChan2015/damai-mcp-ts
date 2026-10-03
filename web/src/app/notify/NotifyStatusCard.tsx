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
    <li className="flex items-center justify-between gap-4 border-b border-zinc-100 py-2 last:border-b-0 dark:border-zinc-900">
      <span className="font-mono text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {status.configured ? (
        <span className="text-right text-sm">
          <code className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{status.display}</code>
          <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
            已配置（来源：{SOURCE_LABEL[status.source]}）
          </span>
        </span>
      ) : (
        <span className="text-sm text-red-600 dark:text-red-400">未配置</span>
      )}
    </li>
  );
}

/**
 * 配置完整性检查卡（服务端数据 props 展示，设计 §4.2/§4.4）：
 * 三要素逐字段「已配置（来源：…）或 未配置」，齐备时给出绿色「可以发送」结论。
 */
export function NotifyStatusCard({ snapshot }: { snapshot: NotifyStatusSnapshot }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">配置完整性检查</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        回落顺序：环境变量（DAMAI_CLAWBOT_*）→ 本地凭证文件（~/.config/damai-mcp-ts/notify.json）→
        未配置。token 与 context_token 仅显示掩码，完整值不会回传到页面。
      </p>
      <ul className="mt-4">
        <FieldRow label="origin" status={snapshot.origin} />
        <FieldRow label="token" status={snapshot.token} />
        <FieldRow label="context_token" status={snapshot.contextToken} />
      </ul>
      {snapshot.ready ? (
        <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
          三要素齐备，可以发送测试通知。
        </p>
      ) : (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          配置未齐备：可展开下方高级选项手填凭证完成本次测试发送（不保存），或按绑定指引配置。
        </p>
      )}
    </section>
  );
}
