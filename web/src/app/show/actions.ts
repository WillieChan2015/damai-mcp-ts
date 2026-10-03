"use server";

import { z } from "zod";

import { readCurrentDamaiItem } from "@core/damai/readItem";
import { resolveDamaiItemId } from "@core/damai/itemId";
import { DamaiMCPError } from "@core/utils/errors";

import { actionClient } from "@/lib/safe-action";

/** 读取或粘贴的结果。itemId 为空时 message 说明下一步该做什么。 */
export interface ShowResolveResult {
  itemId: string | null;
  message: string | null;
}

const DEVICE_OFFLINE = "读不到手机。请确认数据线还连着，并且已允许 USB 调试。";

export const readCurrentShow = actionClient
  .metadata({ operation: "读取当前演出" })
  .schema(z.object({ deviceId: z.string().min(1).max(128) }))
  .action(async ({ parsedInput }): Promise<ShowResolveResult> => {
    let current;
    try {
      current = await readCurrentDamaiItem(parsedInput.deviceId);
    } catch (err) {
      if (err instanceof DamaiMCPError) {
        return { itemId: null, message: DEVICE_OFFLINE };
      }
      throw err;
    }
    if (!current.foreground) {
      return {
        itemId: null,
        message: "请先在手机上打开大麦，进入要抢的那场演出详情，再点读取。",
      };
    }
    if (current.covered) {
      return {
        itemId: null,
        message: "大麦的演出详情还在，但屏幕上盖着别的界面。请解锁并停在详情页，再点读取。",
      };
    }
    if (current.itemId === null) {
      return {
        itemId: null,
        message: "大麦已在前台，但没有读到演出编号。请确认打开的是演出详情；或在大麦里点分享，把文字粘贴到下面。",
      };
    }
    return { itemId: current.itemId, message: "已从手机当前页面识别演出。" };
  });

export const resolveShareShow = actionClient
  .metadata({ operation: "解析分享" })
  .schema(z.object({ text: z.string().trim().min(1).max(8000) }))
  .action(async ({ parsedInput }): Promise<ShowResolveResult> => {
    const itemId = await resolveDamaiItemId(parsedInput.text);
    if (itemId === null) {
      return {
        itemId: null,
        message: "没有识别到演出。请粘贴大麦分享的整段文字或链接。",
      };
    }
    return { itemId, message: "已从分享内容识别演出。" };
  });
