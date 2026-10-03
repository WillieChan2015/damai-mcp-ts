"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { ShowField } from "@/components/ShowField";
import { deviceChoiceLabel, type DeviceIdentity } from "@/lib/deviceLabel";
import { startMonitorTask } from "./actions";

/** 表单下拉项（page.tsx 由 DeviceManager.listDevices 映射而来）。 */
export interface MonitorDeviceOption extends DeviceIdentity {
  deviceId: string;
  model: string;
}

/**
 * 表单级 schema：interval 以「秒」输入（提交时 ×1000 转毫秒），服务端仍由
 * monitorTaskInputSchema（5000-3600000 毫秒边界）二次校验——表单校验只是
 * 即时反馈，action schema 才是权威。
 */
const monitorFormSchema = z.object({
  deviceId: z.string().min(1, "请选择设备"),
  itemId: z.string().min(1, "请先读取手机上的演出，或粘贴分享内容"),
  intervalSeconds: z
    .number({ invalid_type_error: "请填写轮询间隔秒数" })
    .int("须为整数秒")
    .min(5, "最小 5 秒")
    .max(3600, "最大 3600 秒"),
  startAt: z.string(),
  endAt: z.string(),
  openPage: z.boolean(),
});

type MonitorFormValues = z.infer<typeof monitorFormSchema>;

/** 新建监控任务表单（与任务页 TaskForm 同构：RHF + zodResolver）。 */
export function MonitorForm({ devices }: { devices: MonitorDeviceOption[] }) {
  const [error, setError] = useState<string | null>(null);
  const [startedTaskId, setStartedTaskId] = useState<string | null>(null);
  const form = useForm<MonitorFormValues>({
    resolver: zodResolver(monitorFormSchema),
    defaultValues: {
      deviceId: "",
      itemId: "",
      intervalSeconds: 30,
      startAt: "",
      endAt: "",
      openPage: true,
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setStartedTaskId(null);
    // 空串 → undefined（= 立即采样 / 不设截止），由 action 转 Unix 毫秒
    const result = await startMonitorTask({
      deviceId: values.deviceId,
      itemId: values.itemId,
      intervalMs: values.intervalSeconds * 1000,
      openPage: values.openPage,
      startAt: values.startAt ? values.startAt : undefined,
      endAt: values.endAt ? values.endAt : undefined,
    });
    if (result.serverError) {
      setError(result.serverError);
      return;
    }
    if (result.data) {
      setStartedTaskId(result.data.taskId);
    }
  });

  const inputCls =
    "field";
  const labelCls = "block text-xs font-medium text-zinc-600 dark:text-zinc-400";
  const formError =
    form.formState.errors.deviceId?.message ?? form.formState.errors.intervalSeconds?.message;

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label className={labelCls}>设备（只读采样，不干扰人工操作）</label>
        <select {...form.register("deviceId")} className={`mt-1 ${inputCls}`}>
          <option value="">请选择设备</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {deviceChoiceLabel(d)}
            </option>
          ))}
        </select>
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
        <label className={labelCls}>轮询间隔（秒，5-3600）</label>
        <input
          type="number"
          {...form.register("intervalSeconds", { valueAsNumber: true })}
          className={`mt-1 ${inputCls}`}
        />
      </div>
      <div>
        <label className={labelCls}>开始时间（留空 = 立即采样）</label>
        <input type="datetime-local" {...form.register("startAt")} className={`mt-1 ${inputCls}`} />
      </div>
      <div>
        <label className={labelCls}>截止时间（留空 = 不设截止）</label>
        <input type="datetime-local" {...form.register("endAt")} className={`mt-1 ${inputCls}`} />
      </div>
      <div className="flex items-end">
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" {...form.register("openPage")} className="h-4 w-4" />
          启动时深链打开详情页（导航，非点击）
        </label>
      </div>

      {formError ? <p className="text-xs text-red-600 sm:col-span-2">{formError}</p> : null}
      {error ? <p className="text-xs text-red-600 sm:col-span-2">{error}</p> : null}
      {startedTaskId ? (
        <p className="text-xs text-emerald-600 sm:col-span-2">
          监控任务已启动（{startedTaskId.slice(0, 8)}），在下方列表查看实时状态。
        </p>
      ) : null}

      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="btn btn-primary w-full px-4 py-2.5"
        >
          {form.formState.isSubmitting ? "启动中…" : "启动监控任务"}
        </button>
        <p className="mt-2 text-xs text-zinc-400">
          只读轮询详情页（uiautomator dump），判定有票即停止并给出外链；绝不点击购买，最多 720 次采样后自动收尾。
        </p>
      </div>
    </form>
  );
}
