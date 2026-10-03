"use server";

import { revalidatePath } from "next/cache";

import { DeviceManager } from "@core/device/manager";
import {
  deviceConnectSchema,
  deviceDisconnectSchema,
} from "@core/schemas/grab";

import { actionClient } from "@/lib/safe-action";

/** 连接设备（adb connect host:port；序列号形式直接登记）。 */
export const connectDevice = actionClient
  .metadata({ operation: "连接设备" })
  .schema(deviceConnectSchema)
  .action(async ({ parsedInput }) => {
    const info = await DeviceManager.shared().connect(parsedInput.hostPort);
    revalidatePath("/devices");
    return { deviceId: info.deviceId, model: info.model, screenSize: info.screenSize };
  });

/** 断开设备。 */
export const disconnectDevice = actionClient
  .metadata({ operation: "断开设备" })
  .schema(deviceDisconnectSchema)
  .action(async ({ parsedInput }) => {
    await DeviceManager.shared().disconnect(parsedInput.deviceId);
    revalidatePath("/devices");
    return { disconnected: parsedInput.deviceId };
  });
