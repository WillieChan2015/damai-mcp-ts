"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { findTextProbe } from "./actions";
import { ElementPropsPanel } from "./ElementPropsPanel";
import { findTextFormSchema } from "./schemas";
import type { ProbeFindResult } from "./tree";

const INPUT_CLS =
  "mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
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
    <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">find_text 试查</h2>
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={LABEL_CLS}>查找文本（匹配 text 或 content-desc）</label>
          <input
            {...form.register("text")}
            placeholder="如：立即购买 / 选座"
            className={INPUT_CLS}
          />
          {form.formState.errors.text ? (
            <p className="mt-1 text-xs text-red-600">{form.formState.errors.text.message}</p>
          ) : null}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" {...form.register("exact")} />
          整串相等（取消 = 子串匹配）
        </label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" {...form.register("clickableOnly")} />
          仅 clickable 元素
        </label>
        <div>
          <label className={LABEL_CLS}>等待秒数（1-30）</label>
          <input
            type="number"
            min={1}
            max={30}
            {...form.register("timeoutSec", { valueAsNumber: true })}
            className={INPUT_CLS}
          />
          {form.formState.errors.timeoutSec ? (
            <p className="mt-1 text-xs text-red-600">
              {form.formState.errors.timeoutSec.message}
            </p>
          ) : null}
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {submitting ? "试查中…（最长等待 timeoutSec 秒）" : "试查"}
          </button>
        </div>
      </form>

      {error ? <p className="text-xs text-red-600">{error}</p> : null}

      {outcome !== null ? (
        outcome.found ? (
          <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              命中 ✓（属性面板即证据卡）
            </p>
            <ElementPropsPanel element={outcome.element} footnote={outcome.meta.foundBy} />
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
              未命中（等待超时——改版后控件文案可能已变化，可关闭「整串相等」重试）
            </p>
            <p className="mt-1 font-mono text-xs text-amber-700 dark:text-amber-300">
              {outcome.error}
            </p>
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              证据来源：{outcome.meta.foundBy}
            </p>
          </div>
        )
      ) : null}
    </section>
  );
}
