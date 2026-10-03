/**
 * 从手机前台的大麦详情页读取 item id。
 *
 * `dumpsys activity top` 在部分机型上会先打印后台任务（微信、桌面），真正
 * `mResumed=true` 的详情页在后面。有 resumed 标记时用它，没有时才退回第一段。
 * 后台任务栈里的旧演出编号不采用。
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { adb, shell } from "../device/adb";
import { dumpUi } from "../inspector/dump";
import { ADBError } from "../utils/errors";
import { DAMAI_PACKAGE } from "./actions";
import { extractDamaiItemId } from "./itemId";
import { detailFromNodes, type ShowDetail } from "./showDetail";

export interface CurrentDamaiItem {
  /** 前台是大麦时为 true。别的 App 盖在上面时为 false，即使后台栈里还有大麦。 */
  foreground: boolean;
  /** 前台 Activity 的 Intent、界面文案里抽出的编号；读不到时为 null。 */
  itemId: string | null;
  /** 详情页上能读到的标题、时间、票价、场馆。界面没露出这些字段时省略。 */
  detail?: ShowDetail;
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
 * 详情壳的 Intent 经常是 `damai://projectdetail`，extras 不打印编号。界面文字里也没有
 * 这场的编号。大麦详情埋点会把 `item_id` 打进 logcat，但几分钟就会被冲掉。
 * 读到之后按详情 extras 对象身份记住；同一页再点读取时不再依赖日志还在。
 * 两边都没有时，再从界面文案里抽。
 * 详情页露出标题、时间、票价、场馆时一并带回，编号仍然单独解析。
 */
export async function readCurrentDamaiItem(deviceId: string): Promise<CurrentDamaiItem> {
  const activities = await dumpActivities(deviceId);
  const source = HAS_ACTIVITY.test(activities) ? activities : await dumpActivityTop(deviceId);
  let current = interpretActivityTopDump(source);
  const section = current.foreground ? foregroundActivitySection(source) : null;
  const detailPage = section !== null && isProjectDetail(section);
  if (current.foreground && current.itemId === null && detailPage && section !== null) {
    const pid = damaiPidFromActivityDump(section);
    const fromLog = extractDetailItemIdFromLog(await readDetailLog(deviceId), pid);
    const hash = extrasIdentity(await dumpActivityTop(deviceId));
    if (fromLog !== null) {
      if (hash !== null && pid !== null) {
        await rememberDetailItem(deviceId, hash, pid, fromLog);
      }
      current = { foreground: true, itemId: fromLog };
    } else if (hash !== null) {
      const cached = await recallDetailItem(deviceId, hash, pid);
      if (cached !== null) {
        current = { foreground: true, itemId: cached };
      }
    }
  }
  if (current.foreground && (current.itemId === null || detailPage)) {
    const fromUi = await readForegroundUi(deviceId);
    if (current.itemId === null) {
      if (fromUi.itemId !== null) {
        current = { foreground: true, itemId: fromUi.itemId };
      } else if (fromUi.covered) {
        current = { ...current, covered: true };
      }
    }
    if (fromUi.detail !== null) {
      current = { ...current, detail: fromUi.detail };
    }
  }
  return current;
}

/** 前台这一段是演出详情，而不是首页或频道。 */
function isProjectDetail(section: string): boolean {
  return section.includes("ProjectDetailActivity") || section.includes("damai://projectdetail");
}

/**
 * 详情页埋点里最近一条 `item_id`。
 * 同一进程里更早的场次不要。pid 对不上的行丢掉。
 */
export function extractDetailItemIdFromLog(log: string, pid: number | null): string | null {
  const itemId = /"item_id"\s*:\s*"(\d{6,20})"/;
  let last: string | null = null;
  for (const line of log.split(/\n/)) {
    if (!line.includes("page_product_detail") && !line.includes("ProjectDetailActivity")) {
      continue;
    }
    if (pid !== null && !logLineHasPid(line, pid)) {
      continue;
    }
    const matched = itemId.exec(line);
    if (matched?.[1]) {
      last = matched[1];
    }
  }
  return last;
}

/** `10-03 16:54:58.037 21334 27092 I ...` 这种 threadtime 行。 */
function logLineHasPid(line: string, pid: number): boolean {
  const timed = /^(?:\d{4}-)?\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+\d+\s/.exec(line);
  if (timed?.[1]) {
    return Number(timed[1]) === pid;
  }
  return line.includes(` ${pid} `);
}

function damaiPidFromActivityDump(section: string): number | null {
  const proc = /ProcessRecord\{[0-9a-fA-F]+\s+(\d+):cn\.damai\//.exec(section);
  if (proc?.[1]) {
    return Number(proc[1]);
  }
  const pid = /\bpid=(\d+)/.exec(section);
  return pid?.[1] ? Number(pid[1]) : null;
}

/**
 * 用宿主机的 `adb logcat` 读环形缓冲。
 * `adb shell logcat -t` 太大时设备端只会返回刚写入的几行，详情埋点已经不在里面。
 */
async function readDetailLog(deviceId: string): Promise<string> {
  const result = await adb("logcat", "-d", "-e", "item_id", "-t", "200000", {
    deviceId,
    timeout: 8,
    check: false,
  });
  const log = result.stdout.replace(/[\r\n]+$/, "");
  if (isAdbFailure(log)) {
    return "";
  }
  return log;
}

const DETAIL_CACHE_LIMIT = 8;

interface DetailCacheEntry {
  itemId: string;
  pid: number;
}

function detailCachePath(): string {
  return process.env.DAMAI_DETAIL_ITEM_CACHE ?? join(tmpdir(), "damai-mcp-detail-item.json");
}

/** 测试隔离用。清掉本进程和缓存文件里记住的详情编号。 */
export async function clearDetailItemCache(): Promise<void> {
  await rm(detailCachePath(), { force: true });
}

/** 把这场详情 extras 对象和编号记下来。extras 换了就是另一场。 */
export async function rememberDetailItem(
  deviceId: string,
  hash: string,
  pid: number,
  itemId: string,
): Promise<void> {
  const all = await readDetailCache();
  const device = all[deviceId] ?? {};
  device[hash] = { itemId, pid };
  const hashes = Object.keys(device);
  while (hashes.length > DETAIL_CACHE_LIMIT) {
    const oldest = hashes.shift();
    if (oldest) {
      delete device[oldest];
    }
  }
  all[deviceId] = device;
  const path = detailCachePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(all));
}

async function recallDetailItem(
  deviceId: string,
  hash: string,
  pid: number | null,
): Promise<string | null> {
  const entry = (await readDetailCache())[deviceId]?.[hash];
  if (!entry) {
    return null;
  }
  if (pid !== null && entry.pid !== pid) {
    return null;
  }
  return entry.itemId;
}

async function readDetailCache(): Promise<Record<string, Record<string, DetailCacheEntry>>> {
  try {
    const raw = await readFile(detailCachePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return {};
    }
    return parsed as Record<string, Record<string, DetailCacheEntry>>;
  } catch {
    return {};
  }
}

function extrasIdentity(dump: string): string | null {
  return /ProjectDetailExtrasData@([0-9a-fA-F]+)/.exec(dump)?.[1] ?? null;
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

/** 界面文案里的演出链接和详情字段。dump 失败时不当成掉线，调用方继续提示粘贴分享。 */
async function readForegroundUi(
  deviceId: string,
): Promise<{ itemId: string | null; covered: boolean; detail: ShowDetail | null }> {
  let elements;
  try {
    elements = await dumpUi(deviceId, { compressed: false, stockFallback: false });
  } catch (err) {
    if (err instanceof ADBError) {
      return { itemId: null, covered: false, detail: null };
    }
    throw err;
  }
  const texts: string[] = [];
  const damai: { package: string; text: string; resourceId: string }[] = [];
  for (const el of elements) {
    if (!el.package.startsWith(DAMAI_PACKAGE)) {
      continue;
    }
    damai.push({ package: el.package, text: el.text, resourceId: el.resourceId });
    if (el.text !== "") {
      texts.push(el.text);
    }
    if (el.contentDesc !== "") {
      texts.push(el.contentDesc);
    }
  }
  if (damai.length === 0) {
    return { itemId: null, covered: true, detail: null };
  }
  const detail = detailFromNodes(damai);
  for (const text of texts) {
    const id = extractDamaiItemId(text);
    if (id !== null) {
      return { itemId: id, covered: false, detail };
    }
  }
  return { itemId: extractDamaiItemId(texts.join("\n")), covered: false, detail };
}
