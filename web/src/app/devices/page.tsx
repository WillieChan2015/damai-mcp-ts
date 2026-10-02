import { DeviceManager } from "@core/device/manager";

import { ConnectForm } from "./ConnectForm";
import { DisconnectButton } from "./DisconnectButton";

export const dynamic = "force-dynamic";

export const metadata = { title: "设备管理 · Damai Console" };

export default async function DevicesPage() {
  // adb 缺失/失败时 listDevices 内部已捕获并返回缓存（空列表），这里兜底防御
  let devices: Awaited<ReturnType<DeviceManager["listDevices"]>> = [];
  try {
    devices = await DeviceManager.shared().listDevices(true);
  } catch {
    devices = [];
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">设备管理</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          真机插 USB（开启 USB 调试）即自动出现；模拟器通过 ADB 无线地址连接。
        </p>
      </div>

      <ConnectForm />

      {devices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          未发现设备。请检查：手机已开启 USB 调试并授权；或 adb 可用（<code>adb devices</code> 有输出）。
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
              <th className="py-2 pr-4 font-medium">序列号</th>
              <th className="py-2 pr-4 font-medium">型号</th>
              <th className="py-2 pr-4 font-medium">Android</th>
              <th className="py-2 pr-4 font-medium">分辨率</th>
              <th className="py-2 pr-4 font-medium">类型</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr
                key={d.deviceId}
                className="border-b border-zinc-100 dark:border-zinc-900"
              >
                <td className="py-2 pr-4 font-mono text-xs">{d.deviceId}</td>
                <td className="py-2 pr-4">{d.model}</td>
                <td className="py-2 pr-4">{d.androidVersion}</td>
                <td className="py-2 pr-4">{d.screenSize}</td>
                <td className="py-2 pr-4">{d.isEmulator ? "模拟器" : "真机"}</td>
                <td className="py-2">
                  <DisconnectButton deviceId={d.deviceId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
