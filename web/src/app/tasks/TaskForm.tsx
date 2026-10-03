"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { grabTaskInputSchema } from "@core/schemas/grab";

import { DateTimeField } from "@/components/DateTimeField";
import { DeviceSelect } from "@/components/DeviceSelect";
import { ShowField } from "@/components/ShowField";
import { type DeviceIdentity } from "@/lib/deviceLabel";
import { prepareViewerPresets, VIEWER_PRESET_NAME_MAX } from "@/lib/viewerPresetRules";
import { saveViewerPresets, startGrabTask } from "./actions";

export interface TaskFormDevice extends DeviceIdentity {
  deviceId: string;
  model?: string;
}

/**
 * 抢票任务启动台表单。
 * 安全语义：不提供 confirmOrder 开关，流程止步于 ready_for_human，支付由人工手动完成。
 * 观演人快捷项来自本地文件，在本表单增删后立即保存；保存失败不改当前名单。
 */
export function TaskForm({
  devices = [],
  viewerPresets = [],
  onStarted,
}: {
  devices?: TaskFormDevice[];
  viewerPresets?: string[];
  onStarted: (taskId: string) => void;
}) {
  const [viewerNamesRaw, setViewerNamesRaw] = useState("");
  const [presets, setPresets] = useState(viewerPresets);
  const [draft, setDraft] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetSaving, setPresetSaving] = useState(false);
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

  const persistPresets = async (next: string[], clearDraft: boolean) => {
    const prepared = prepareViewerPresets(next);
    if (!prepared.ok) {
      setPresetError(prepared.error);
      return;
    }
    setPresetSaving(true);
    setPresetError(null);
    try {
      const result = await saveViewerPresets({ names: prepared.names });
      if (result.serverError) {
        setPresetError(result.serverError);
        return;
      }
      if (!result.data) {
        setPresetError("保存快捷姓名失败");
        return;
      }
      setPresets(result.data.names);
      if (clearDraft) {
        setDraft("");
      }
    } finally {
      setPresetSaving(false);
    }
  };

  const addPreset = () => {
    const name = draft.trim();
    if (name === "") {
      setPresetError("姓名不能为空");
      return;
    }
    if (presets.includes(name)) {
      setDraft("");
      setPresetError(null);
      return;
    }
    void persistPresets([...presets, name], true);
  };

  const removePreset = (name: string) => {
    void persistPresets(
      presets.filter((item) => item !== name),
      false,
    );
  };

  const labelCls = "block text-xs font-medium text-muted";

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls}>目标设备</label>
          {devices.length > 0 ? (
            <Controller
              control={form.control}
              name="deviceId"
              render={({ field }) => (
                <DeviceSelect
                  devices={devices}
                  value={field.value}
                  onValueChange={field.onChange}
                  className="mt-1"
                />
              )}
            />
          ) : (
            <Input
              {...form.register("deviceId")}
              placeholder="127.0.0.1:5555"
              className="mt-1"
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
          <Input
            type="number"
            min={1}
            {...form.register("priceIndex", { valueAsNumber: true })}
            className="mt-1 font-mono text-xs"
          />
        </div>

        <div>
          <label className={labelCls}>购票张数</label>
          <Input
            type="number"
            min={1}
            max={6}
            {...form.register("ticketNum", { valueAsNumber: true })}
            className="mt-1 font-mono text-xs"
          />
        </div>

        <div className="sm:col-span-2">
          <label className={labelCls}>观演人姓名（逗号分隔，留空由 App 自动带入）</label>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {presets.map((name) => (
              <span key={name} className="inline-flex items-center">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="rounded-r-none"
                  disabled={presetSaving}
                  onClick={() => addViewerPreset(name)}
                >
                  +{name}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  className="rounded-l-none border-l-0 px-1 text-muted"
                  aria-label={`移除快捷姓名 ${name}`}
                  disabled={presetSaving}
                  onClick={() => removePreset(name)}
                >
                  ×
                </Button>
              </span>
            ))}
            <Input
              value={draft}
              maxLength={VIEWER_PRESET_NAME_MAX}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPreset();
                }
              }}
              placeholder="添加快捷姓名"
              disabled={presetSaving}
              aria-label="添加快捷姓名"
              className="h-6 w-28 px-2 text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={presetSaving}
              onClick={addPreset}
            >
              添加
            </Button>
          </div>
          {presetError ? <p className="mt-1 text-xs text-danger">{presetError}</p> : null}
          <Input
            value={viewerNamesRaw}
            onChange={(e) => setViewerNamesRaw(e.target.value)}
            placeholder="姓名之间用逗号分隔"
            className="mt-1.5"
          />
        </div>

        <div>
          <label className={labelCls}>开票时间（本地时间，留空即时开抢）</label>
          <Controller
            control={form.control}
            name="openTime"
            render={({ field }) => (
              <DateTimeField
                value={field.value ?? ""}
                onChange={field.onChange}
                format="open-time"
                placeholder="留空则立即开抢"
                className="mt-1"
              />
            )}
          />
        </div>

        <div>
          <label className={labelCls}>提前预热秒数</label>
          <Input
            type="number"
            min={5}
            max={300}
            {...form.register("preheatSeconds", { valueAsNumber: true })}
            className="mt-1 font-mono text-xs"
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
        <Button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="w-full"
        >
          {form.formState.isSubmitting ? "正在下发抢票任务…" : "启动抢票作战任务"}
        </Button>
        <p className="mt-2 text-center text-[11px] text-muted">
          严格安全约束：任务止步于「订单待人工确认」，绝不静默代扣款。
        </p>
      </div>
    </form>
  );
}
