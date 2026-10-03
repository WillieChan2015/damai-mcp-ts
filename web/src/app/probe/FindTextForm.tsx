"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { findTextProbe } from "./actions";
import { ElementPropsPanel } from "./ElementPropsPanel";
import { findTextFormSchema } from "./schemas";
import type { ProbeFindResult } from "./tree";

const INPUT_CLS =
  "mt-1 field";
const LABEL_CLS = "block text-xs font-medium text-zinc-600 dark:text-zinc-400";

/**
 * find_text 试查表单（设计稿 §7.2「五字段」：设备由工作区共享下拉提供，
 * 其余 text / exact / clickableOnly / timeoutSec 在本表单）。
 *
 * 未命中（轮询超时）是正常试查结果，以琥珀色结果卡呈现而非红色错误；
 * 命中结果显示全字段 + toString + core 来源注脚的证据卡。
 */
export function FindTextForm({ deviceId }: { deviceId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ProbeFindResult | null>(null);
  const form = useForm({
    resolver: zodResolver(findTextFormSchema),
    defaultValues: { text: "", exact: true, clickableOnly: false, timeoutSec: 5 },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setOutcome(null);
    try {
      const result = await findTextProbe({ deviceId, ...values });
      if (result.serverError) {
        setError(result.serverError);
        return;
      }
      if (result.data) {
        setOutcome(result.data);
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  });

  const submitting = form.formState.isSubmitting;

  return (
    <section className="panel p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink">快速文本控件试查 (find_text)</h2>
        <p className="mt-0.5 text-xs text-muted">
          直接按文案或 content-desc 寻找目标控件，验证选择器在真实环境下的响应。
        </p>
      </div>

      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-muted">查找文本（匹配 text 或 content-desc）</label>
          <input
            {...form.register("text")}
            placeholder="如：立即购买 / 选座 / 确定"
            className="field mt-1"
          />
          {form.formState.errors.text ? (
            <p className="mt-1 text-xs text-danger">{form.formState.errors.text.message}</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:gap-6">
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
            <input type="checkbox" {...form.register("exact")} />
            <span>完全匹配（取消勾选后为包含匹配）</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
            <input type="checkbox" {...form.register("clickableOnly")} />
            <span>仅可点击控件 (clickable)</span>
          </label>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted">超时等待（秒）</label>
          <input
            type="number"
            min={1}
            max={30}
            {...form.register("timeoutSec", { valueAsNumber: true })}
            className="field mt-1 font-mono text-xs"
          />
          {form.formState.errors.timeoutSec ? (
            <p className="mt-1 text-xs text-danger">
              {form.formState.errors.timeoutSec.message}
            </p>
          ) : null}
        </div>

        <div className="flex items-end">
          <button
            type="submit"
            disabled={submitting}
            className="btn btn-secondary w-full py-2 text-xs"
          >
            {submitting ? "正在轮询查找中…" : "开始定位测试"}
          </button>
        </div>
      </form>

      {error ? (
        <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}

      {outcome !== null ? (
        outcome.found ? (
          <div className="space-y-3 rounded-lg border border-ok/30 bg-ok/10 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-ok">
              <span>✓ 成功命中目标控件</span>
              <span className="font-normal text-muted">（全属性证据如下）</span>
            </div>
            <ElementPropsPanel element={outcome.element} footnote={outcome.meta.foundBy} />
          </div>
        ) : (
          <div className="rounded-lg border border-warn/30 bg-warn/10 p-4">
            <p className="text-xs font-semibold text-warn">
              未命中目标控件（轮询超时）
            </p>
            <p className="mt-1 font-mono text-xs text-warn">
              {outcome.error}
            </p>
            <p className="mt-1 text-[11px] text-muted">
              建议：取消勾选「完全匹配」，或在上方 UI 树中重新检索控件确切文案与层级。
            </p>
          </div>
        )
      ) : null}
    </section>
  );
}
