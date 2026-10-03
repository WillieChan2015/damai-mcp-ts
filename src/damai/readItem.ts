/**
 * 从手机前台的大麦详情页读取 item id。
 *
 * `dumpsys activity top` 在部分机型上会先打印后台任务（微信、桌面），真正
 * `mResumed=true` 的详情页在后面。有 resumed 标记时用它，没有时才退回第一段。
 * 后台任务栈里的旧演出编号不采用。
 */

import { shell } from "../device/adb";
import { dumpUi } from "../inspector/dump";
import { ADBError } from "../utils/errors";
import { DAMAI_PACKAGE } from "./actions";
import { extractDamaiItemId } from "./itemId";

export interface CurrentDamaiItem {
  /** 前台是大麦时为 true。别的 App 盖在上面时为 false，即使后台栈里还有大麦。 */
  foreground: boolean;
  /** 前台 Activity 的 Intent、界面文案里抽出的编号；读不到时为 null。 */
  itemId: string | null;
  /**
   * 任务栈顶是大麦，但这轮界面 dump 里没有大麦节点。
   * 锁屏、息屏或通知栏盖住详情时为 true。
   */
  covered?: boolean;
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
 * 判断当前前台 Activity 是不是大麦。
 * 有 `ACTIVITY` 行时认 `mResumed=true` 的那一段；只有 ActivityRecord 时认第一段。
 */
export function interpretActivityTopDump(raw: string): CurrentDamaiItem {
  const dump = raw.replaceAll("\r\n", "\n");
  if (isAdbFailure(dump)) {
    throw new ADBError(firstLine(dump));
  }
  const section = foregroundActivitySection(dump);
  if (section === null || !section.includes(DAMAI_PACKAGE)) {
    return { foreground: false, itemId: null };
  }
  return { foreground: true, itemId: extractDamaiItemId(section) };
}

const ACTIVITY_LINE = /^[ \t]*ACTIVITY (?!MANAGER)/gm;

/** 前台那一段。`activity top` 的 ACTIVITY 列表优先于栈里的 ActivityRecord。 */
function foregroundActivitySection(dump: string): string | null {
  const sections = activityLineSections(dump);
  if (sections.length > 0) {
    return pickForegroundSection(sections);
  }
  return firstActivityRecordSection(dump);
}

function activityLineSections(dump: string): string[] {
  const starts: number[] = [];
  for (const match of dump.matchAll(ACTIVITY_LINE)) {
    if (match.index !== undefined) {
      starts.push(match.index);
    }
  }
  return starts.map((start, index) => dump.slice(start, starts[index + 1] ?? dump.length));
}

/**
 * 有 resumed 的段里优先大麦（分屏时详情仍算前台）。
 * 整份 dump 都没有 `mResumed=true` 时退回第一段，不把后台大麦当成前台。
 */
function pickForegroundSection(sections: readonly string[]): string {
  const resumed = sections.filter((section) => section.includes("mResumed=true"));
  if (resumed.length === 0) {
    return sections[0] ?? "";
  }
  return resumed.find((section) => section.includes(DAMAI_PACKAGE)) ?? resumed[0] ?? "";
}

/** 第一段 ActivityRecord，直到下一段 Hist / ACTIVITY 为止。 */
function firstActivityRecordSection(dump: string): string | null {
  const startMatch = /ActivityRecord\{/m.exec(dump);
  if (startMatch === null || startMatch.index === undefined) {
    return null;
  }
  const start = startMatch.index;
  const rest = dump.slice(start + startMatch[0].length);
  const next = /\n[ \t]*\* Hist #\d+:|\n[ \t]*ACTIVITY /.exec(rest);
  const end = next === null ? Math.min(dump.length, start + 6000) : start + startMatch[0].length + next.index;
  return dump.slice(start, end);
}

const HAS_ACTIVITY = /ActivityRecord\{|^[ \t]*ACTIVITY (?!MANAGER)/m;

/**
 * 读取当前前台演出编号。
 *
 * 先读 `dumpsys activity activities`：任务从顶到底，第一段就是前台，并且带 Intent。
 * `dumpsys activity top` 会先打印后台应用，详情页视图太大时还会把这一段 dump 超时，
 * 所以只在 activities 没有 Activity 段时才用它。
 * 详情壳的 Intent 经常是 `damai://projectdetail`，extras 不打印编号；这时再从界面文案里抽。
 */
export async function readCurrentDamaiItem(deviceId: string): Promise<CurrentDamaiItem> {
  const activities = await dumpActivities(deviceId);
  let current = HAS_ACTIVITY.test(activities)
    ? interpretActivityTopDump(activities)
    : interpretActivityTopDump(await dumpActivityTop(deviceId));
  if (current.foreground && current.itemId === null) {
    const fromUi = await itemIdFromForegroundUi(deviceId);
    if (fromUi.itemId !== null) {
      current = { foreground: true, itemId: fromUi.itemId };
    } else if (fromUi.covered) {
      current = { ...current, covered: true };
    }
  }
  return current;
}

async function dumpActivityTop(deviceId: string): Promise<string> {
  const top = await shell("dumpsys", "activity", "top", {
    deviceId,
    timeout: 8,
    check: false,
  });
  if (isAdbFailure(top)) {
    throw new ADBError(firstLine(top));
  }
  return top;
}

async function dumpActivities(deviceId: string): Promise<string> {
  const activities = await shell("dumpsys", "activity", "activities", {
    deviceId,
    timeout: 8,
    check: false,
  });
  if (isAdbFailure(activities)) {
    throw new ADBError(firstLine(activities));
  }
  return activities;
}

/** 界面文案里的演出链接。dump 失败时不当成掉线，调用方继续提示粘贴分享。 */
async function itemIdFromForegroundUi(
  deviceId: string,
): Promise<{ itemId: string | null; covered: boolean }> {
  let elements;
  try {
    elements = await dumpUi(deviceId, { compressed: false, stockFallback: false });
  } catch (err) {
    if (err instanceof ADBError) {
      return { itemId: null, covered: false };
    }
    throw err;
  }
  const texts: string[] = [];
  let sawDamai = false;
  for (const el of elements) {
    if (!el.package.startsWith(DAMAI_PACKAGE)) {
      continue;
    }
    sawDamai = true;
    if (el.text !== "") {
      texts.push(el.text);
    }
    if (el.contentDesc !== "") {
      texts.push(el.contentDesc);
    }
  }
  if (!sawDamai) {
    return { itemId: null, covered: true };
  }
  for (const text of texts) {
    const id = extractDamaiItemId(text);
    if (id !== null) {
      return { itemId: id, covered: false };
    }
  }
  return { itemId: extractDamaiItemId(texts.join("\n")), covered: false };
}
