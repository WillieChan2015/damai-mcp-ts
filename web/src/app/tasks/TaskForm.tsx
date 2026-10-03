"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { grabTaskInputSchema } from "@core/schemas/grab";

import { ShowField } from "@/components/ShowField";
import { deviceChoiceLabel, type DeviceIdentity } from "@/lib/deviceLabel";
import { startGrabTask } from "./actions";

export interface TaskFormDevice extends DeviceIdentity {
  deviceId: string;
  model?: string;
}

const PRESET_VIEWERS = ["杨安琪", "张三", "李四"];

/**
 * 抢票任务启动台表单。
 * 安全语义：不提供 confirmOrder 开关，流程止步于 ready_for_human，支付由人工手动完成。
 */
export function TaskForm({
  devices = [],
  onStarted,
}: {
  devices?: TaskFormDevice[];
  onStarted: (taskId: string) => void;
}) {
  const [viewerNamesRaw, setViewerNamesRaw] = useState("");
  const [error, setError] = useState<string | null>(null);

  const defaultDeviceId = devices[0]?.deviceId ?? "";

  const form = useForm({
    resolver: zodResolver(grabTaskInputSchema),
    defaultValues: {
      deviceId: defaultDeviceId,
      itemId: "",
      priceIndex: 1,
      ticketNum: 1,
      openTime: "",
      preheatSeconds: 30,
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
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

  const addViewerPreset = (name: string) => {
    const list = viewerNamesRaw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!list.includes(name)) {
      list.push(name);
      setViewerNamesRaw(list.join(", "));
    }
  };

  const labelCls = "block text-xs font-medium text-muted";

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls}>目标设备</label>
          {devices.length > 0 ? (
            <select
              {...form.register("deviceId")}
              className="field mt-1"
            >
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {deviceChoiceLabel(d)}
                </option>
              ))}
            </select>
          ) : (
            <input
              {...form.register("deviceId")}
              placeholder="127.0.0.1:5555"
              className="field mt-1"
            />
          )}
        </div>

        <div className="sm:col-span-2">
          <ShowField
            deviceId={form.watch("deviceId")}
            itemId={form.watch("itemId")}
            onItemIdChange={(itemId) => form.setValue("itemId", itemId, { shouldValidate: true })}
            itemError={form.formState.errors.itemId?.message}
          />
        </div>

        <div>
          <label className={labelCls}>票档序号 (1-based)</label>
          <input
            type="number"
            min={1}
            {...form.register("priceIndex", { valueAsNumber: true })}
            className="field mt-1 font-mono text-xs"
          />
        </div>

        <div>
          <label className={labelCls}>购票张数</label>
          <input
            type="number"
            min={1}
            max={6}
            {...form.register("ticketNum", { valueAsNumber: true })}
            className="field mt-1 font-mono text-xs"
          />
        </div>

        <div className="sm:col-span-2">
          <div className="flex items-center justify-between">
            <label className={labelCls}>观演人姓名（逗号分隔，留空由 App 自动带入）</label>
            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <span>快捷添加:</span>
              {PRESET_VIEWERS.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => addViewerPreset(name)}
                  className="rounded border border-line bg-surface-raised px-1.5 py-0.5 hover:border-line-strong hover:text-ink"
                >
                  +{name}
                </button>
              ))}
            </div>
          </div>
          <input
            value={viewerNamesRaw}
            onChange={(e) => setViewerNamesRaw(e.target.value)}
            placeholder="杨安琪, 张三"
            className="field mt-1"
          />
        </div>

        <div>
          <label className={labelCls}>开票时间（本地时间，留空即时开抢）</label>
          <input
            {...form.register("openTime")}
            placeholder="2026-10-04 12:00:00"
            className="field mt-1 font-mono text-xs"
          />
        </div>

        <div>
          <label className={labelCls}>提前预热秒数</label>
          <input
            type="number"
            min={5}
            max={300}
            {...form.register("preheatSeconds", { valueAsNumber: true })}
            className="field mt-1 font-mono text-xs"
          />
        </div>
      </div>

      {(form.formState.errors.deviceId || form.formState.errors.openTime) && (
        <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {form.formState.errors.deviceId?.message ?? form.formState.errors.openTime?.message}
        </div>
      )}

      {error ? (
        <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="btn btn-primary w-full py-2.5 text-sm"
        >
          {form.formState.isSubmitting ? "正在下发抢票任务…" : "启动抢票作战任务"}
        </button>
        <p className="mt-2 text-center text-[11px] text-muted">
          严格安全约束：任务止步于「订单待人工确认」，绝不静默代扣款。
        </p>
      </div>
    </form>
  );
}
