import { DeviceManager } from "@core/device/manager";

import { getTaskManager } from "@/task/manager";

import { MonitorForm } from "./MonitorForm";
import { MonitorTaskList } from "./MonitorTaskList";

export const dynamic = "force-dynamic";

export const metadata = { title: "余票监控 · Damai Console" };

/** 监控面板（RSC）：设备下拉 + 新建表单 + 监控任务列表（初始快照，客户端轮询续命）。 */
export default async function MonitorPage() {
  // adb 缺失/失败时 listDevices 内部已捕获并返回缓存（空列表），这里兜底防御
  // （同 devices/page.tsx 先例）
  let devices: Awaited<ReturnType<DeviceManager["listDevices"]>> = [];
  try {
    devices = await DeviceManager.shared().listDevices(true);
  } catch {
    devices = [];
  }
  const initialTasks = getTaskManager().list().filter((task) => task.kind === "monitor");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">余票监控</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          只读轮询大麦详情页（uiautomator dump），四态判定 available / not_on_sale / sold_out /
          unknown；发现有票立即停止并给出详情页外链，全程零点击指令。
        </p>
      </div>

      <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">新建监控任务</h2>
        <div className="mt-4">
          <MonitorForm
            devices={devices.map((d) => ({ deviceId: d.deviceId, model: d.model }))}
          />
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">监控任务</h2>
        <div className="mt-3">
          <MonitorTaskList initialTasks={initialTasks} />
        </div>
      </section>
    </div>
  );
}
