import Link from "next/link";
import { DeviceManager } from "@core/device/manager";

import { ConnectForm } from "./ConnectForm";
import { DisconnectButton } from "./DisconnectButton";
import { Glyph, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "设备机架 · Damai Console" };

export default async function DevicesPage() {
  let devices: Awaited<ReturnType<DeviceManager["listDevices"]>> = [];
  try {
    devices = await DeviceManager.shared().listDevices(true);
  } catch {
    devices = [];
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="设备机架"
        lede="真机通过 USB 连接（开启 USB 调试并授权）自动就绪；模拟器支持一键快速拨测与无线 ADB 挂载。"
        actions={
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted">
              {devices.length} 台设备已入架
            </span>
          </div>
        }
      />

      <ConnectForm />

      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-semibold text-ink">在线设备矩阵</h2>
          <span className="text-xs text-muted">ADB 通路检测与状态</span>
        </div>

        {devices.length === 0 ? (
          <div className="flex h-56 flex-col items-center justify-center rounded-lg border border-dashed border-line p-8 text-center">
            <Glyph name="devices" className="h-8 w-8 text-muted" />
            <p className="mt-3 text-sm font-medium text-ink">当前机架无在线设备</p>
            <p className="mt-1 text-xs text-muted max-w-md">
              请插入真机并确保已允许 USB 调试，或在上方填入模拟器端口（如 127.0.0.1:5555）点击连接。
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {devices.map((d) => (
              <div
                key={d.deviceId}
                className="panel flex flex-col justify-between p-4 transition-all hover:border-line-strong"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="live-dot shrink-0" />
                      <span className="font-semibold text-sm text-ink truncate">
                        {d.model || "Android 终端"}
                      </span>
                    </div>
                    <span className="rounded border border-line bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-muted shrink-0">
                      {d.isEmulator ? "模拟器" : "真机"}
                    </span>
                  </div>

                  <div className="mt-3 space-y-1 font-mono text-xs text-muted">
                    <div className="flex items-center justify-between py-0.5 border-b border-line/60">
                      <span className="text-muted">序列号</span>
                      <span className="text-ink select-all">{d.deviceId}</span>
                    </div>
                    <div className="flex items-center justify-between py-0.5 border-b border-line/60">
                      <span className="text-muted">Android</span>
                      <span className="text-ink">v{d.androidVersion}</span>
                    </div>
                    <div className="flex items-center justify-between py-0.5">
                      <span className="text-muted">分辨率</span>
                      <span className="text-ink">{d.screenSize}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between gap-2 pt-3 border-t border-line">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/screenshots`}
                      className="rounded border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-line-strong hover:text-ink transition-colors"
                    >
                      取景
                    </Link>
                    <Link
                      href={`/probe`}
                      className="rounded border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-line-strong hover:text-ink transition-colors"
                    >
                      调试
                    </Link>
                  </div>
                  <DisconnectButton deviceId={d.deviceId} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
