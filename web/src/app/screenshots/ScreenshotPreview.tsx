"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** 轮询间隔（ms）：与 no-store + 时间戳查询参数配合防缓存。 */
const POLL_MS = 2000;

/** 页面传递给预览组件的最小设备信息（可序列化）。 */
export interface PreviewDevice {
  deviceId: string;
  model?: string;
}

/**
 * 设备实时截图预览（设计 §5.2 的前端轮询消费端）。
 *
 * 以 2s 间隔更新 `<img src>` 的时间戳查询参数触发重新请求；设备离线时端点
 * 返回 502，`onError` 切到中文降级文案但**不卸载** `<img>`（hidden 仍会随
 * 时间戳变化继续请求），恢复后 `onLoad` 自动亮回。
 */
export function ScreenshotPreview({ devices }: { devices: PreviewDevice[] }) {
  const [selected, setSelected] = useState<string | null>(devices[0]?.deviceId ?? null);
  const [tick, setTick] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (selected === null) {
      return;
    }
    const timer = setInterval(() => setTick(Date.now()), POLL_MS);
    return () => clearInterval(timer);
  }, [selected]);

  if (devices.length === 0 || selected === null) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        当前无在线设备。到{" "}
        <Link href="/devices" className="underline hover:text-zinc-700 dark:hover:text-zinc-200">
          设备管理
        </Link>{" "}
        连接设备后，此处显示实时画面。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {devices.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {devices.map((d) => (
            <button
              key={d.deviceId}
              type="button"
              onClick={() => {
                setSelected(d.deviceId);
                setFailed(false);
              }}
              className={
                selected === d.deviceId
                  ? "rounded-lg border border-zinc-900 bg-zinc-900 px-3 py-1 font-mono text-xs text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "rounded-lg border border-zinc-300 px-3 py-1 font-mono text-xs text-zinc-600 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500"
              }
            >
              {d.deviceId}
              {d.model ? ` · ${d.model}` : ""}
            </button>
          ))}
        </div>
      )}

      {failed && (
        <div className="rounded-xl border border-dashed border-red-300 p-6 text-center text-sm text-red-500 dark:border-red-800">
          设备截图暂不可用（设备可能已离线），恢复后将自动重新显示。
        </div>
      )}

      {/* 轮询 <img>：不用 next/image（动态 API 端点，无需优化管线） */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/devices/${encodeURIComponent(selected)}/screenshot?t=${tick}`}
        alt={`设备 ${selected} 实时截图`}
        className={
          failed
            ? "hidden"
            : "mx-auto max-h-[70vh] rounded-xl border border-zinc-200 dark:border-zinc-800"
        }
        onError={() => setFailed(true)}
        onLoad={() => setFailed(false)}
      />
    </div>
  );
}
