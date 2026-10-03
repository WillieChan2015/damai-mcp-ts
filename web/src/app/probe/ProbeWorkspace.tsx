"use client";

import { DeviceSelect } from "@/components/DeviceSelect";

import { useState } from "react";

import { type DeviceIdentity } from "@/lib/deviceLabel";

import { FindTextForm } from "./FindTextForm";
import { UiTreePanel } from "./UiTreePanel";

/** 设备下拉的最小字段（page.tsx 从 DeviceInfo 映射，避免整包序列化）。 */
export interface ProbeDeviceOption extends DeviceIdentity {
  deviceId: string;
  model: string;
}


/**
 * 调试器工作区：共享设备下拉 + 两个工具卡（Dump 树查看 / find_text 试查）。
 * 无设备时展示中文指引（设计稿 §7：优雅降级空态）。
 */
export function ProbeWorkspace({ devices }: { devices: ProbeDeviceOption[] }) {
  const [deviceId, setDeviceId] = useState(devices[0]?.deviceId ?? "");

  if (devices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line p-10 text-center">
        <p className="text-sm font-medium text-ink">未检测到已连接的 Android 设备</p>
        <p className="mt-1 text-xs text-muted">
          无法进行选择器调试。请先在「设备机架」页面插拔 USB 真机或输入模拟器无线地址连接。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <label className="block text-xs font-medium text-ink">当前调试目标设备</label>
          <p className="text-[11px] text-muted">切换设备后工作区与 Dump 树将自动刷新</p>
        </div>
        <DeviceSelect
          devices={devices}
          value={deviceId}
          onValueChange={setDeviceId}
          className="max-w-md text-xs"
        />
      </div>

      {deviceId !== "" ? (
        <>
          <UiTreePanel key={`dump-${deviceId}`} deviceId={deviceId} />
          <FindTextForm key={`find-${deviceId}`} deviceId={deviceId} />
        </>
      ) : null}
    </div>
  );
}
