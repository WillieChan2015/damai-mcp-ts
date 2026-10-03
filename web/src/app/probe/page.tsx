import { DeviceManager } from "@core/device/manager";

import { ProbeWorkspace, type ProbeDeviceOption } from "./ProbeWorkspace";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "选择器调试器 · Damai Console" };

/** 选择器调试器：Dump UI 树查看 + find_text 试查（大麦改版后的自救入口）。 */
export default async function ProbePage() {
  // 设备数据源同 devices/page.tsx：adb 缺失/失败时容错为空列表
  let devices: ProbeDeviceOption[] = [];
  try {
    const infos = await DeviceManager.shared().listDevices(true);
    devices = infos.map((d) => ({
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
      <div>
        <PageHeader title="选择器调试器" lede="Dump 当前 UI 层级重建为可折叠树，或按文本试查选择器——大麦改版后定位新控件的第一个入口。 所有结果均标注 core 源码出处（dumpUi / findByText），便于把页面证据映射回选择器实现。" />
      </div>

      <ProbeWorkspace devices={devices} />
    </div>
  );
}
