import { DeviceManager } from "@core/device/manager";

import { getTaskManager } from "@/task/manager";

import { MonitorForm } from "./MonitorForm";
import { MonitorTaskList } from "./MonitorTaskList";
import { PageHeader } from "@/components/ui";

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
      <PageHeader
        title="余票监控雷达"
        lede="只读轮询大麦详情页 DOM 节点，智能判定四态（有票 / 未开售 / 售罄 / 未知）；一旦发现回流余票立即停止并自动推送外链，全程零点击指令。"
      />

      <section className="panel p-6">
        <h2 className="text-base font-semibold text-ink">新建监控任务</h2>
        <div className="mt-4">
          <MonitorForm
            devices={devices.map((d) => ({
              deviceId: d.deviceId,
              model: d.model,
              marketName: d.marketName,
              deviceName: d.deviceName,
            }))}
          />
        </div>
      </section>

      <section className="panel p-6">
        <h2 className="text-base font-semibold text-ink">监控任务巡检列表</h2>
        <div className="mt-3">
          <MonitorTaskList initialTasks={initialTasks} />
        </div>
      </section>
    </div>
  );
}
