"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";

import type { PurchaseSheetOptions } from "@core/damai/purchaseSheet";
import { grabTaskInputSchema } from "@core/schemas/grab";

import { DateTimeField } from "@/components/DateTimeField";
import { DeviceSelect } from "@/components/DeviceSelect";
import { ShowField } from "@/components/ShowField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type DeviceIdentity } from "@/lib/deviceLabel";
import { prepareViewerPresets, VIEWER_PRESET_NAME_MAX } from "@/lib/viewerPresetRules";
import { readPurchaseSheet, saveViewerPresets, startGrabTask } from "./actions";

function FallbackPrices({
  prices,
  primary,
  selected,
  onChange,
}: {
  prices: Array<{ label: string; soldOut: boolean }>;
  primary: string;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const choices = prices.filter((price) => price.label !== primary);
  if (choices.length === 0) {
    return null;
  }
  const toggle = (label: string) => {
    if (selected.includes(label)) {
      onChange(selected.filter((item) => item !== label));
      return;
    }
    if (selected.length >= 5) {
      return;
    }
    onChange([...selected, label]);
  };
  return (
    <div className="mt-2">
      <p className="text-[11px] text-muted">备选档（按点击顺序，主档缺货后再试，最多 5 个）</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {choices.map((price) => {
          const on = selected.includes(price.label);
          const order = selected.indexOf(price.label);
          return (
            <Button
              key={price.label}
              type="button"
              variant={on ? "default" : "outline"}
              size="xs"
              onClick={() => toggle(price.label)}
            >
              {on ? `${order + 1}. ` : ""}
              {price.soldOut ? `${price.label}（缺货登记）` : price.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function priceOptionLabel(price: { label: string; soldOut: boolean; picked: boolean }): string {
  if (price.soldOut) {
    return `${price.label}（缺货登记）`;
  }
  if (price.picked) {
    return `${price.label}（已选）`;
  }
  return price.label;
}

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
      sessionIndex: 1,
      sessionLabel: "",
      priceIndex: 1,
      priceLabel: "",
      priceFallbacks: [],
      ticketNum: 1,
      openTime: "",
      preheatSeconds: 30,
      clockOffsetMs: null,
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const viewerNames = viewerNamesRaw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (viewerNames.length > 0 && viewerNames.length !== values.ticketNum) {
      setError(`观演人数（${viewerNames.length}）必须等于购票张数（${values.ticketNum}）`);
      return;
    }

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

  const [sheet, setSheet] = useState<PurchaseSheetOptions | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [readingSheet, setReadingSheet] = useState(false);
  const deviceId = form.watch("deviceId");
  const itemId = form.watch("itemId");

  useEffect(() => {
    setSheet(null);
    setSheetError(null);
    form.setValue("sessionLabel", "");
    form.setValue("priceLabel", "");
    form.setValue("priceFallbacks", []);
    // 只在设备或演出变化时丢掉已读列表。setValue 不该触发这次清理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, itemId]);

  const readSheet = async () => {
    setReadingSheet(true);
    setSheetError(null);
    try {
      const result = await readPurchaseSheet({ deviceId, itemId });
      if (result.serverError) {
        setSheet(null);
        form.setValue("sessionLabel", "");
        form.setValue("priceLabel", "");
        form.setValue("priceFallbacks", []);
        setSheetError(result.serverError);
        return;
      }
      if (!result.data) {
        setSheet(null);
        setSheetError("没有读到场次或票档");
        return;
      }
      form.setValue("sessionLabel", result.data.sessions[0]?.label ?? "");
      form.setValue("priceLabel", result.data.prices[0]?.label ?? "");
      form.setValue("priceFallbacks", []);
      setSheet(result.data);
    } finally {
      setReadingSheet(false);
    }
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

        <div className="sm:col-span-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readingSheet || deviceId.trim() === "" || itemId.trim() === ""}
            onClick={() => void readSheet()}
          >
            {readingSheet ? "正在读取…" : "读取场次与票档"}
          </Button>
          {sheetError ? <p className="mt-1 text-xs text-danger">{sheetError}</p> : null}
        </div>

        {sheet ? (
          <>
            <div>
              <label className={labelCls}>场次</label>
              {sheet.sessions.length > 0 ? (
                <Controller
                  control={form.control}
                  name="sessionLabel"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="mt-1 w-full">
                        <SelectValue placeholder="选择场次" />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        {sheet.sessions.map((session) => (
                          <SelectItem key={session.label} value={session.label}>
                            {session.picked ? `${session.label}（已选）` : session.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              ) : (
                <p className="mt-1 text-[11px] text-muted">没有场次卡片，将使用当前已选中的场次。</p>
              )}
            </div>
            <div>
              <label className={labelCls}>票档</label>
              <Controller
                control={form.control}
                name="priceLabel"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      const current = form.getValues("priceFallbacks") ?? [];
                      form.setValue(
                        "priceFallbacks",
                        current.filter((label) => label !== value),
                      );
                    }}
                  >
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue placeholder="选择票档" />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {sheet.prices.map((price) => (
                        <SelectItem key={price.label} value={price.label}>
                          {priceOptionLabel(price)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FallbackPrices
                prices={sheet.prices}
                primary={form.watch("priceLabel") ?? ""}
                selected={form.watch("priceFallbacks") ?? []}
                onChange={(next) => form.setValue("priceFallbacks", next)}
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <label className={labelCls}>场次序号 (1-based)</label>
              <Input
                type="number"
                min={1}
                max={20}
                {...form.register("sessionIndex", { valueAsNumber: true })}
                className="mt-1 font-mono text-xs"
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
          </>
        )}

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
          <label className={labelCls}>开票时间（北京时间，留空即时开抢）</label>
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
          <label className={labelCls}>手动校时（毫秒，留空自动）</label>
          <Controller
            control={form.control}
            name="clockOffsetMs"
            render={({ field }) => (
              <Input
                type="number"
                value={field.value ?? ""}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (raw === "") {
                    field.onChange(null);
                    return;
                  }
                  const parsed = Number(raw);
                  field.onChange(Number.isFinite(parsed) ? parsed : null);
                }}
                placeholder="服务器时间减本机时间"
                className="mt-1 font-mono text-xs"
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
