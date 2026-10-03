"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { deviceChoiceLabel, type DeviceIdentity } from "@/lib/deviceLabel";
import { cn } from "cn";

/** 设备下拉。value 允许空串，表示尚未选择。 */
export function DeviceSelect({
  devices,
  value,
  onValueChange,
  placeholder = "请选择设备",
  className,
  id,
}: {
  devices: DeviceIdentity[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper">
        {devices.map((device) => (
          <SelectItem key={device.deviceId} value={device.deviceId}>
            {deviceChoiceLabel(device)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
