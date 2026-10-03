"use client";

import { useActionState } from "react";

import type { SendStatus } from "@core/notify/wechat";

import { sendTestNotification } from "./actions";
import type { SendTestResult } from "./testSend";

/** SendOutcome.status → 中文标签 + 配色（结果卡徽标）。 */
const STATUS_VIEW: Record<SendStatus, { label: string; cls: string }> = {
  sent: {
    label: "已送达",
    cls: "border-ok/30 bg-ok/10 text-ok",
  },
  failed: { label: "发送失败", cls: "border-danger/30 bg-danger/10 text-danger" },
  expired: {
    label: "会话过期",
    cls: "border-warn/30 bg-warn/10 text-warn",
  },
  timeout_unknown: {
    label: "超时未知",
    cls: "border-warn/30 bg-warn/10 text-warn",
  },
};

/** useActionState 的表单状态（ok: null=尚未提交）。 */
interface SendTestFormState {
  ok: boolean | null;
  outcome: SendTestResult | null;
  serverError: string | null;
  fieldErrors: string[];
}

const initialState: SendTestFormState = {
  ok: null,
  outcome: null,
  serverError: null,
  fieldErrors: [],
};

/** next-safe-action 格式化校验错误（zod format 形态）→ 「字段：首个错误」行列表。 */
function collectFieldErrors(validationErrors: unknown): string[] {
  if (validationErrors === null || typeof validationErrors !== "object") {
    return [];
  }
  const bag = validationErrors as Record<string, { _errors?: string[] } | undefined>;
  const lines: string[] = [];
  for (const field of ["target", "text", "origin", "token", "contextToken"]) {
    const message = bag[field]?._errors?.[0];
    if (message !== undefined) {
      lines.push(`${field}：${message}`);
    }
  }
  return lines;
}

/** 表单字段值：字符串去首尾空格，空串归一为 undefined（可选字段留空 = 用已配置凭证）。 */
function optionalValue(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 结果卡：SendOutcome 五字段 + hint 中文释义。 */
function ResultCard({ outcome }: { outcome: SendTestResult }) {
  const badge = STATUS_VIEW[outcome.status];
  return (
    <dl className="mt-2 space-y-1.5 rounded-lg border border-line bg-surface-raised p-3 text-xs">
      <div className="flex items-center gap-2">
        <dt className="text-muted">结果</dt>
        <dd>
          <span className={`rounded border px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
        </dd>
      </div>
      <div className="flex items-center gap-2">
        <dt className="text-muted">client_id</dt>
        <dd className="font-mono text-ink">{outcome.clientId}</dd>
      </div>
      <div className="flex items-center gap-2">
        <dt className="text-muted">HTTP 状态</dt>
        <dd className="font-mono text-ink">
          {outcome.httpStatus ?? "—（传输层未产生完整响应）"}
        </dd>
      </div>
      <div className="flex items-center gap-2">
        <dt className="text-muted">耗时</dt>
        <dd className="font-mono text-ink">{outcome.elapsedMs} ms</dd>
      </div>
      {outcome.error !== null ? (
        <div className="flex items-start gap-2">
          <dt className="shrink-0 text-muted">错误</dt>
          <dd className="text-danger font-medium">{outcome.error}</dd>
        </div>
      ) : null}
      <div className="flex items-start gap-2">
        <dt className="shrink-0 text-muted">说明</dt>
        <dd className="text-ink">{outcome.hint}</dd>
      </div>
    </dl>
  );
}

const inputCls =
  "field";
const labelCls = "block text-xs font-medium text-zinc-600 dark:text-zinc-400";

/**
 * 测试发送表单（useActionState，设计 §4.4）。
 *
 * 高级折叠区手填的凭证仅本次发送使用（服务端手填优先），页面任何路径都不保存凭证。
 */
export function SendTestForm({ ready }: { ready: boolean }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: SendTestFormState, formData: FormData): Promise<SendTestFormState> => {
      const result = await sendTestNotification({
        target: optionalValue(formData, "target") ?? "",
        text: optionalValue(formData, "text"),
        origin: optionalValue(formData, "origin"),
        token: optionalValue(formData, "token"),
        contextToken: optionalValue(formData, "contextToken"),
      });
      if (result.validationErrors !== undefined) {
        return {
          ok: false,
          outcome: null,
          serverError: null,
          fieldErrors: collectFieldErrors(result.validationErrors),
        };
      }
      if (result.serverError !== undefined) {
        return { ok: false, outcome: null, serverError: result.serverError, fieldErrors: [] };
      }
      if (result.data !== undefined) {
        return { ok: true, outcome: result.data, serverError: null, fieldErrors: [] };
      }
      return initialState;
    },
    initialState,
  );

  return (
    <section className="panel p-6">
      <h2 className="text-base font-semibold text-ink">测试发送</h2>
      <p className="mt-1 text-sm text-muted">
        {ready
          ? "将使用上方已配置凭证发送；如需临时改用其他凭证，可展开高级选项手填（手填优先）。"
          : "当前三要素未齐备：可在高级选项中手填凭证完成本次测试发送（不保存）。"}
      </p>
      <form action={formAction} className="mt-4 grid gap-3">
        <div>
          <label className={labelCls} htmlFor="notify-target">
            接收人 target（ClawBot to_user_id，必填）
          </label>
          <input
            id="notify-target"
            name="target"
            placeholder="user-001"
            autoComplete="off"
            className={`mt-1 ${inputCls}`}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="notify-text">
            文本内容（留空 = 固定测试文案；≤ 2000 字）
          </label>
          <textarea id="notify-text" name="text" rows={3} className={`mt-1 ${inputCls}`} />
        </div>

        <details className="rounded-lg border border-line bg-surface-raised p-3">
          <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">
            高级选项：手填临时凭证（仅本次发送使用，不持久化）
          </summary>
          <div className="mt-3 grid gap-3">
            <div>
              <label className={labelCls} htmlFor="notify-origin">
                origin（https，host ∈ *.ilinkai.weixin.qq.com）
              </label>
              <input
                id="notify-origin"
                name="origin"
                placeholder="https://bot.ilinkai.weixin.qq.com"
                autoComplete="off"
                className={`mt-1 ${inputCls}`}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="notify-token">
                token（Bearer 令牌）
              </label>
              <input
                id="notify-token"
                name="token"
                type="password"
                autoComplete="off"
                className={`mt-1 ${inputCls}`}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="notify-context-token">
                context_token（会话上下文）
              </label>
              <input
                id="notify-context-token"
                name="contextToken"
                type="password"
                autoComplete="off"
                className={`mt-1 ${inputCls}`}
              />
            </div>
          </div>
        </details>

        {state.fieldErrors.length > 0 ? (
          <div className="text-xs text-red-600 dark:text-red-400">
            {state.fieldErrors.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : null}
        {state.serverError !== null ? (
          <p className="whitespace-pre-line text-xs text-red-600 dark:text-red-400">
            {state.serverError}
          </p>
        ) : null}

        <div>
          <button
            type="submit"
            disabled={pending}
            className="btn btn-primary w-full px-4 py-2.5"
          >
            {pending ? "发送中…" : "发送测试通知"}
          </button>
          <p className="mt-2 text-xs text-zinc-400">
            单次请求超时 10 秒；超时＝送达状态未知，不会自动重发（可按结果里的 client_id 幂等重试）。
          </p>
        </div>

        {state.outcome !== null ? <ResultCard outcome={state.outcome} /> : null}
      </form>
    </section>
  );
}
