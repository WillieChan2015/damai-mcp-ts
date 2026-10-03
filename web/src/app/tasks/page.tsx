import { DeviceManager } from "@core/device/manager";
import { getTaskManager } from "@/task/manager";

import { TaskPanel } from "./TaskPanel";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "抢票任务作战舱" };

export default async function TasksPage() {
  const manager = getTaskManager();

  let devices: Array<{ deviceId: string; model?: string }> = [];
  try {
    const list = await DeviceManager.shared().listDevices(true);
    devices = list.map((d) => ({
      deviceId: d.deviceId,
      model: d.model,
      marketName: d.marketName,
      deviceName: d.deviceName,
    }));
  } catch {
    devices = [];
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="抢票任务作战舱"
        lede="全流程六阶门控：NTP 校时 → 详情页预热 → 开票去抖门 → 锁定票档 → 选中观演人 → 交付人工核验与支付。"
      />
      <TaskPanel initialTasks={manager.list()} devices={devices} />
    </div>
  );
}
