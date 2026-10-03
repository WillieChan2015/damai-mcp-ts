"use client";

import { useState } from "react";

import { FindTextForm } from "./FindTextForm";
import { UiTreePanel } from "./UiTreePanel";

/** 设备下拉的最小字段（page.tsx 从 DeviceInfo 映射，避免整包序列化）。 */
export interface ProbeDeviceOption {
  deviceId: string;
  model: string;
}

const SELECT_CLS =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

/**
 * 调试器工作区：共享设备下拉 + 两个工具卡（Dump 树查看 / find_text 试查）。
 * 无设备时展示中文指引（设计稿 §7：优雅降级空态）。
 */
export function ProbeWorkspace({ devices }: { devices: ProbeDeviceOption[] }) {
  const [deviceId, setDeviceId] = useState(devices[0]?.deviceId ?? "");

  if (devices.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        未发现设备，无法进行选择器调试。请先在「设备」页连接设备（<code>adb devices</code> 有输出后再回到本页）。
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
          设备（Dump 与 find_text 共用）
        </label>
        <select
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          className={SELECT_CLS}
        >
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.deviceId}（{d.model}）
            </option>
          ))}
        </select>
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
