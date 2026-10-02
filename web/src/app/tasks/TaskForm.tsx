"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { grabTaskInputSchema } from "@core/schemas/grab";

import { startGrabTask } from "./actions";

/**
 * 抢票任务表单（Phase 1）。
 *
 * 安全语义（D5）：不提供 confirmOrder 开关——runner 恒以默认 false 调 core，
 * 流程止步于提交前的 ready_for_human / needs_action，支付永远人工完成。
 */
export function TaskForm({ onStarted }: { onStarted: (taskId: string) => void }) {
  const [viewerNamesRaw, setViewerNamesRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(grabTaskInputSchema),
    defaultValues: {
      deviceId: "",
      itemId: "",
      priceIndex: 1,
      ticketNum: 1,
      openTime: "",
      preheatSeconds: 30,
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    // 观演人：逗号/中文逗号分隔 → 数组；空 → null（App 自动带入）
    const viewerNames = viewerNamesRaw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const result = await startGrabTask({
      ...values,
      viewerNames: viewerNames.length > 0 ? viewerNames : null,
    });
    if (result.serverError) {
      setError(result.serverError);
      return;
    }
    if (result.data?.taskId) {
      onStarted(result.data.taskId);
    }
  });

  const inputCls =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
  const labelCls = "block text-xs font-medium text-zinc-600 dark:text-zinc-400";

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className={labelCls}>设备序列号</label>
        <input {...form.register("deviceId")} placeholder="127.0.0.1:5555" className={`mt-1 ${inputCls}`} />
      </div>
      <div>
        <label className={labelCls}>大麦 item id</label>
        <input {...form.register("itemId")} placeholder="1063631004645" className={`mt-1 ${inputCls}`} />
      </div>
      <div>
        <label className={labelCls}>票档序号（1-based）</label>
        <input type="number" {...form.register("priceIndex", { valueAsNumber: true })} className={`mt-1 ${inputCls}`} />
      </div>
      <div>
        <label className={labelCls}>张数</label>
        <input type="number" {...form.register("ticketNum", { valueAsNumber: true })} className={`mt-1 ${inputCls}`} />
      </div>
      <div className="sm:col-span-2">
        <label className={labelCls}>观演人（逗号分隔；留空 = App 自动带入）</label>
        <input
          value={viewerNamesRaw}
          onChange={(e) => setViewerNamesRaw(e.target.value)}
          placeholder="杨安琪, 张三"
          className={`mt-1 ${inputCls}`}
        />
      </div>
      <div>
        <label className={labelCls}>开票时间（本地时区，留空 = 立即抢）</label>
        <input {...form.register("openTime")} placeholder="2026-07-09 17:21:00" className={`mt-1 ${inputCls}`} />
      </div>
      <div>
        <label className={labelCls}>预热秒数</label>
        <input
          type="number"
          {...form.register("preheatSeconds", { valueAsNumber: true })}
          className={`mt-1 ${inputCls}`}
        />
      </div>

      {form.formState.errors.deviceId || form.formState.errors.itemId || form.formState.errors.openTime ? (
        <p className="text-xs text-red-600 sm:col-span-2">
          {form.formState.errors.deviceId?.message ??
            form.formState.errors.itemId?.message ??
            form.formState.errors.openTime?.message}
        </p>
      ) : null}
      {error ? <p className="text-xs text-red-600 sm:col-span-2">{error}</p> : null}

      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {form.formState.isSubmitting ? "启动中…" : "启动抢票任务"}
        </button>
        <p className="mt-2 text-xs text-zinc-400">
          流程止步于提交前的人工确认（needs_action 时先核对官方订单页），支付永远手动完成。
        </p>
      </div>
    </form>
  );
}
