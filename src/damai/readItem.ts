/**
 * 从手机前台的大麦详情页读取 item id。
 *
 * 只看 `dumpsys activity top` 里最上面的 Activity。后台任务栈里的旧演出编号不采用。
 */

import { shell } from "../device/adb";
import { ADBError } from "../utils/errors";
import { DAMAI_PACKAGE } from "./actions";
import { extractDamaiItemId } from "./itemId";

export interface CurrentDamaiItem {
  /** 前台是大麦时为 true。别的 App 盖在上面时为 false，即使后台栈里还有大麦。 */
  foreground: boolean;
  /** 前台 Activity 的 Intent / URL 里抽出的编号；详情壳没带 id 时为 null。 */
  itemId: string | null;
}

function firstLine(output: string): string {
  return output.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** adb 把设备错误写在 stdout 首行（`error: device offline` 等）。 */
function isAdbFailure(output: string): boolean {
  const line = firstLine(output);
  return /^(adb:|error:)/i.test(line);
}

/**
 * 判断 top dump 的第一段 Activity 是不是大麦。
 * dump 按从顶到底打印，第一段不是大麦就说明详情页不在前台。
 */
export function interpretActivityTopDump(raw: string): CurrentDamaiItem {
  const dump = raw.replaceAll("\r\n", "\n");
  if (isAdbFailure(dump)) {
    throw new ADBError(firstLine(dump));
  }
  const section = topActivitySection(dump);
  if (section === null || !section.includes(DAMAI_PACKAGE)) {
    return { foreground: false, itemId: null };
  }
  return { foreground: true, itemId: extractDamaiItemId(section) };
}

/** 第一段 ActivityRecord / ACTIVITY 行，直到下一段 Activity 为止。 */
function topActivitySection(dump: string): string | null {
  const startMatch = /ActivityRecord\{|^[ \t]*ACTIVITY (?!MANAGER)/m.exec(dump);
  if (startMatch === null || startMatch.index === undefined) {
    return null;
  }
  const start = startMatch.index;
  const rest = dump.slice(start + startMatch[0].length);
  const next = /\n[ \t]*\* Hist #\d+:|\nACTIVITY /.exec(rest);
  const end = next === null ? Math.min(dump.length, start + 6000) : start + startMatch[0].length + next.index;
  return dump.slice(start, end);
}

/**
 * 读取当前前台演出编号。
 *
 * `dumpsys activity top` 没有 Activity 段时（部分机型输出为空），再读一次
 * `dumpsys activity activities`，仍然只解释第一段。
 */
export async function readCurrentDamaiItem(deviceId: string): Promise<CurrentDamaiItem> {
  const top = await shell("dumpsys", "activity", "top", {
    deviceId,
    timeout: 8,
    check: false,
  });
  if (isAdbFailure(top)) {
    throw new ADBError(firstLine(top));
  }
  if (/ActivityRecord\{|^[ \t]*ACTIVITY (?!MANAGER)/m.test(top)) {
    return interpretActivityTopDump(top);
  }
  const activities = await shell("dumpsys", "activity", "activities", {
    deviceId,
    timeout: 8,
    check: false,
  });
  return interpretActivityTopDump(activities);
}
