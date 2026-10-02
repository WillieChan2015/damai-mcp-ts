/**
 * 一次性抢票日 checklist（Python `damai/checklist.py` 的 TS 对应物）。
 *
 * 以显式分阶段 + 进度上报的方式，端到端跑完一整场抢票会话。
 * 这是杀手级 UX 特性：1 条命令从启动一路跑到提交。
 *
 * 阶段：
 *     0. 连接检查         （设备 + adb 可用）
 *     1. app 启动 + 登录校验（必要时人工重登）
 *     2. 详情页预热       （提前打开 URL，利用缓存状态）
 *     3. 倒计时循环       （每分钟更新一次状态；到点前经去抖门判定开票）
 *     4. 开票触发         （T-0 触发抢票流水线）
 *     5. 结果 + 可选提醒
 *
 * 实际点击经 {@link damaiGrab} 完成；本模块只负责调度、状态与可读进度。
 */
import { setTimeout as sleep } from "node:timers/promises";

import { screenshot, swipe } from "../actions/actions";
import { formatPyFloat } from "../device/adb";
import { DeviceManager } from "../device/manager";
import { dumpUi } from "../inspector/dump";
import type { UIElement } from "../inspector/models";
import { logger } from "../utils/logging";
import { asyncQuery } from "../utils/ntp";

// 与 Python 版一致：在模块顶层导入，测试经模块 mock（vi.mock）替换。
import { damaiGrab, damaiLoginCheck, damaiOpenConcert, parseIso } from "./actions";

/** 等待 open_time 期间状态 ping 的间隔（秒）。 */
export const COUNTDOWN_TICK_SEC = 60;

/** open_time 前多少秒开始预热，让预热彻底落地。 */
export const DEFAULT_PREHEAT_SECONDS = 30.0;

/** {@link PhaseEvent.toDict} 的输出形态（键名与 Python 版一致）。 */
export type PhaseEventDict = {
  phase: string;
  started_at_ms: number;
  finished_at_ms: number | null;
  elapsed_ms: number;
  note: string;
};

/** {@link ChecklistResult.toDict} 的输出形态（键名与 Python 版一致）。 */
export type ChecklistResultDict = {
  status: string;
  phases: PhaseEventDict[];
  grab_result: Record<string, unknown> | null;
  error: string | null;
  ntp_offset_ms: number | null;
};

/** {@link PhaseEvent} 的构造参数（对应 Python dataclass 字段及默认值）。 */
export interface PhaseEventInit {
  /** 阶段名。 */
  phase: string;
  /** 开始时刻（Unix 毫秒）。 */
  startedAtMs: number;
  /** 结束时刻；未结束时缺省 null。 */
  finishedAtMs?: number | null;
  /** 备注。缺省空串。 */
  note?: string;
}

/** checklist 运行过程中记录的单个检查点。 */
export class PhaseEvent {
  /** 阶段名。 */
  phase: string;
  /** 开始时刻（Unix 毫秒）。 */
  startedAtMs: number;
  /** 结束时刻；未结束时为 null。 */
  finishedAtMs: number | null;
  /** 备注。 */
  note: string;

  constructor(init: PhaseEventInit) {
    this.phase = init.phase;
    this.startedAtMs = init.startedAtMs;
    this.finishedAtMs = init.finishedAtMs ?? null;
    this.note = init.note ?? "";
  }

  /** 已耗时（毫秒）；未结束时为 0。 */
  get elapsedMs(): number {
    if (this.finishedAtMs === null) {
      return 0;
    }
    return this.finishedAtMs - this.startedAtMs;
  }

  /**
   * 序列化为普通对象。
   *
   * 键名保持 Python 版 `to_dict()` 的 snake_case 原样（对外表面）。
   */
  toDict(): PhaseEventDict {
    return {
      phase: this.phase,
      started_at_ms: this.startedAtMs,
      finished_at_ms: this.finishedAtMs,
      elapsed_ms: this.elapsedMs,
      note: this.note,
    };
  }
}

/** 一次 checklist 运行的完整报告，可直接 JSON 序列化。 */
export class ChecklistResult {
  /**
   * 最终状态。Python 版类型为 str，注释枚举了
   * "submitted" | "needs_human" | "failed" | "expired" | "preheat_open_time"；
   * 实际取值还包括透传自 grab 结果的 "ready_for_human"。
   */
  status: string;
  /** 各阶段检查点（按发生顺序）。 */
  phases: PhaseEvent[];
  /** 抢票结果（或登录检查中间结果）；无则为 null。 */
  grabResult: Record<string, unknown> | null;
  /** 失败原因；成功为 null。 */
  error: string | null;
  /** 若使用了 NTP 同步模块，记录其 offset（毫秒）。 */
  ntpOffsetMs: number | null;

  constructor(init: {
    status: string;
    phases?: PhaseEvent[];
    grabResult?: Record<string, unknown> | null;
    error?: string | null;
    ntpOffsetMs?: number | null;
  }) {
    this.status = init.status;
    this.phases = init.phases ?? [];
    this.grabResult = init.grabResult ?? null;
    this.error = init.error ?? null;
    this.ntpOffsetMs = init.ntpOffsetMs ?? null;
  }

  /**
   * 序列化为普通对象。
   *
   * 键名保持 Python 版 `to_dict()` 的 snake_case 原样（对外表面）。
   */
  toDict(): ChecklistResultDict {
    return {
      status: this.status,
      phases: this.phases.map((p) => p.toDict()),
      grab_result: this.grabResult,
      error: this.error,
      ntp_offset_ms: this.ntpOffsetMs,
    };
  }
}

/** 当前 Unix 毫秒（等价 Python 的 `int(time.time() * 1000)`）。 */
function nowMs(): number {
  return Date.now();
}

/** 当前 Unix 秒（等价 Python 的 `time.time()`）。 */
function nowSec(): number {
  return Date.now() / 1000;
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 对应 Python f-string 的 `{x:+.2f}`：恒带符号、保留两位小数。 */
function signed2(value: number): string {
  return `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(2)}`;
}

// ---- open_time 解析 ------------------------------------------------------------

/** 某年某月的天数（含闰年）。 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * 按本地时区构造 Date，范围非法时抛 Python datetime 风格的错误
 * （"YYYY-MM-DD HH:MM:SS" 一律按本地时区解析，禁止用 Date(字符串) 直接解析）。
 */
function buildStrictLocalDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms = 0,
): Date {
  if (month < 1 || month > 12) {
    throw new Error("month must be in 1..12");
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Error("day is out of range for month");
  }
  if (hour < 0 || hour > 23) {
    throw new Error("hour must be in 0..23");
  }
  if (minute < 0 || minute > 59) {
    throw new Error("minute must be in 0..59");
  }
  if (second < 0 || second > 59) {
    throw new Error("second must be in 0..59");
  }
  // 从 epoch 基准逐字段设置，规避 `new Date(year<100, ...)` 把年份解释为
  // 1900+year 的行为
  const d = new Date(0);
  d.setFullYear(year, month - 1, day);
  d.setHours(hour, minute, second, ms);
  return d;
}

/**
 * 解析 'YYYY-MM-DD HH:MM:SS' 或 ISO 时间。open_time 为空 / "now" / "立即"
 * 时返回 null。
 *
 * 时间语义（迁移约定第 3 条）：所有分支均按**本地时区**解释字面墙钟分量——
 * 带 "+08:00" 之类偏移的 ISO 分支同样只取字面分量、丢弃偏移
 * （等价 Python `fromisoformat(...).replace(tzinfo=None)`）。
 *
 * ISO 分支的严格性对齐 Python 3.10 `fromisoformat`：分量固定 2 位、分隔符
 * 为任意单字符、小数部分恰为 3 或 6 位、偏移形如 "+HH:MM"（严格介于 ±24h）。
 * 亚毫秒精度在 Date 中截断到毫秒（Python 保留微秒）。
 *
 * @throws 无法解析时抛错（文案与 Python 版逐字一致）。
 */
export function parseOpenTime(openTime: string): Date | null {
  if (!openTime || ["", "now", "立即"].includes(openTime.toLowerCase())) {
    return null;
  }
  // 格式 "%Y-%m-%d %H:%M:%S" —— 与 actions.parseIso 同一 strptime 格式，直接复用
  try {
    return parseIso(openTime);
  } catch {
    // 尝试下一格式
  }
  // 格式 "%Y-%m-%dT%H:%M:%S"
  const t = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(openTime);
  if (t !== null) {
    try {
      return buildStrictLocalDate(
        Number(t[1]), Number(t[2]), Number(t[3]),
        Number(t[4]), Number(t[5]), Number(t[6]),
      );
    } catch {
      // 尝试下一格式
    }
  }
  // 格式 "%Y-%m-%dT%H:%M:%S.%f"
  const tf = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})\.(\d{1,6})$/.exec(
    openTime,
  );
  if (tf !== null) {
    // Python %f 是微秒（1-6 位，右补零），Date 只保留毫秒
    const ms = Number(tf[7].padEnd(3, "0").slice(0, 3));
    try {
      return buildStrictLocalDate(
        Number(tf[1]), Number(tf[2]), Number(tf[3]),
        Number(tf[4]), Number(tf[5]), Number(tf[6]), ms,
      );
    } catch {
      // 落到 ISO 分支
    }
  }
  // 带 +08:00 之类偏移的 ISO——取字面墙钟分量、丢弃偏移（按本地时间处理）。
  // 对齐 Python：fromisoformat 分支的任何失败（形状不匹配、范围非法、
  // 偏移超界）都会落到末尾的「无法解析」错误，而不是返回 null。
  const normalized = openTime.replaceAll("Z", "+00:00");
  const iso =
    /^(\d{4})-(\d{2})-(\d{2}).(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}|\d{6}))?)?([+-]\d{2}:\d{2})?$/.exec(
      normalized,
    );
  if (iso !== null) {
    // 可选捕获组在运行时可能未参与匹配，显式按 string | undefined 处理
    const secText: string | undefined = iso[6];
    const fracText: string | undefined = iso[7];
    const tzText: string | undefined = iso[8];
    if (tzText !== undefined) {
      const offHour = Number(tzText.slice(1, 3));
      const offMin = Number(tzText.slice(4, 6));
      if (offHour > 23 || offMin > 59) {
        // Python：offset 必须严格介于 ±24h 之间，否则 ValueError → 无法解析
        throw new Error(
          `无法解析 open_time='${openTime}', 期望 'YYYY-MM-DD HH:MM:SS'`,
        );
      }
    }
    const second = secText === undefined ? 0 : Number(secText);
    const ms = fracText === undefined ? 0 : Number(fracText.padEnd(3, "0").slice(0, 3));
    try {
      return buildStrictLocalDate(
        Number(iso[1]), Number(iso[2]), Number(iso[3]),
        Number(iso[4]), Number(iso[5]), second, ms,
      );
    } catch {
      // 形状匹配但日期范围非法（如 2 月 30 日）→ 落到下方的「无法解析」
    }
  }
  throw new Error(
    `无法解析 open_time='${openTime}', 期望 'YYYY-MM-DD HH:MM:SS'`,
  );
}

// ---- 倒计时 -------------------------------------------------------------------

/** Python `asyncio.Event` 的最小结构等价物：`isSet()` 返回是否已置位。 */
export interface StopEvent {
  readonly isSet: () => boolean;
}

/** {@link countdownLoop} 的进度回调：接收 (剩余秒数, 已耗时整秒)。 */
export type ProgressCallback = (secondsLeft: number, elapsedS: number) => void | Promise<void>;

/**
 * 一直等到 ``targetUnix``（epoch 秒，墙钟）。
 *
 * 每 {@link COUNTDOWN_TICK_SEC} 秒（最后 10 秒内改为每秒）调用一次
 * ``progressCb(secondsLeft, elapsedS)``。``stopEvent`` 已置位时提前返回。
 */
export async function countdownLoop(
  targetUnix: number,
  {
    progressCb = null,
    stopEvent = null,
  }: { progressCb?: ProgressCallback | null; stopEvent?: StopEvent | null } = {},
): Promise<void> {
  const started = nowSec();
  for (;;) {
    const now = nowSec();
    const left = targetUnix - now;
    const elapsed = now - started;
    if (left <= 0) {
      return;
    }
    if (stopEvent !== null && stopEvent.isSet()) {
      return;
    }
    const tick = left > 10 ? COUNTDOWN_TICK_SEC : 1;
    if (progressCb !== null) {
      try {
        await progressCb(left, Math.trunc(elapsed));
      } catch (exc) {
        // 回调出错绝不能杀死等待本身
        logger.error(`countdown callback raised, continuing: ${excToStr(exc)}`);
      }
    }
    await sleep(tick * 1000);
  }
}

// ---- 开票判定去抖门 -------------------------------------------------------------
//
// 语义移植自 damai 的 CountdownSignalGate 与 wait_for_sale_fast：
// 倒计时节点消失（= 页面已切到可购买态）必须**连续确认 N 次**才算开票（去抖门）；
// 下拉刷新会临时卸载倒计时节点，那段缺失永不计入（刷新后门 disarm，等节点重现
// 再重新武装）；定时器兜底最高优先级——到点必触发，不等再一次 UI 探测。

/** 大麦详情页倒计时节点的 resource-id（{@link CountdownSignalGate} 的观察对象）。 */
export const COUNTDOWN_NODE_RESOURCE_ID = "cn.damai:id/id_project_count_down_layout";

/** 基线要求：进入观察窗后连续见到倒计时节点的最少次数，见齐才武装门。 */
export const GATE_BASELINE_COUNT = 3;

/** 基线尝试窗口上限（毫秒）；实际窗口为 min(本值, 距开票)。 */
export const GATE_BASELINE_WINDOW_MS = 3000;

/** 定时器兜底提前量（毫秒）：now ≥ target + 本值即无条件判开票。 */
export const GATE_FALLBACK_AFTER_MS = 150;

/** {@link waitForSaleStart} 主循环默认轮询间隔（毫秒）。 */
export const GATE_DEFAULT_POLL_MS = 500;

/**
 * 开票判定去抖门（纯状态机，无 I/O，可直接单测）。
 *
 * 状态转移逐条对齐 damai `wait_for_sale_fast` 的信号门：
 * - {@link CountdownSignalGate.observe}(true)：未武装则 re-arm（rearmCount+1）
 *   并清零缺失计数；已武装则仅维持武装态。
 * - {@link CountdownSignalGate.observe}(false)：未武装或未到点
 *   （signalAllowed=false）时一律忽略；武装且到点才记缺失——首次缺失记
 *   {@link CountdownSignalGate.missingStartedAtMs}，连续缺失达到 confirmCount
 *   才确认开票（返回 true）。
 * - {@link CountdownSignalGate.disarm}：刷新后必调——刷新造成的节点缺失
 *   永不计入，须等节点重现再重新武装。
 */
export class CountdownSignalGate {
  /** 连续缺失确认次数（构造时 clamp 到 1..5，默认 2）。 */
  private readonly confirmCount: number;
  private armedFlag = false;
  private falseStreakCount = 0;
  private rearmCounter = 0;
  private missingStartedAt: number | null = null;

  constructor(options?: { confirmCount?: number }) {
    const raw = options?.confirmCount ?? 2;
    // clamp 到 1..5：越界不抛错，取最近的合法值
    this.confirmCount = Math.min(5, Math.max(1, Math.trunc(raw)));
  }

  /** 门当前是否武装（武装后「到点 + 节点缺失」才开始计数）。 */
  get armed(): boolean {
    return this.armedFlag;
  }

  /** 当前连续缺失次数；disarm 或节点重现时清零。 */
  get falseStreak(): number {
    return this.falseStreakCount;
  }

  /**
   * 门完成「未武装 → 武装」转移的累计次数（已武装状态下的 observe(true) 不计）。
   * 跨整个等待周期累计，不随 disarm 清零——用于诊断页面抖动 / 刷新频率。
   */
  get rearmCount(): number {
    return this.rearmCounter;
  }

  /** 首次「武装 + 到点」缺失的时刻（Unix 毫秒）；无进行中的缺失时为 null。 */
  get missingStartedAtMs(): number | null {
    return this.missingStartedAt;
  }

  /**
   * 解除武装并清零缺失计数（下拉刷新后必调——刷新造成的缺失永不计入）。
   *
   * @param _nowMs 解除时刻（Unix 毫秒）。当前状态机不使用该值，仅为对齐
   *               damai 原版签名保留。
   */
  disarm(_nowMs?: number): void {
    this.armedFlag = false;
    this.falseStreakCount = 0;
    this.missingStartedAt = null;
  }

  /**
   * 观察一次倒计时节点状态。
   *
   * @param present 节点是否在场（可见）。
   * @param nowMs 本次观察时刻（Unix 毫秒）。
   * @param signalAllowed 是否已到点（nowMs ≥ 开票时刻）；到点后的缺失才计数。
   * @returns true = 确认开票（连续缺失已达 confirmCount）。
   */
  observe(present: boolean, nowMs: number, signalAllowed: boolean): boolean {
    if (present) {
      if (!this.armedFlag) {
        // re-arm：节点重现（或首次见到）→ 重新武装
        this.armedFlag = true;
        this.rearmCounter += 1;
      }
      this.falseStreakCount = 0;
      this.missingStartedAt = null;
      return false;
    }
    if (!this.armedFlag || !signalAllowed) {
      // 未武装 / 未到点的缺失一律忽略（页面变体、刷新卸载、开票前正常在售态）
      return false;
    }
    if (this.missingStartedAt === null) {
      this.missingStartedAt = nowMs;
    }
    this.falseStreakCount += 1;
    return this.falseStreakCount >= this.confirmCount;
  }
}

/** {@link waitForSaleStart} 的关键字参数。 */
export interface WaitForSaleStartOptions {
  /**
   * 观察窗起点（Unix 秒），默认 targetUnix - 10。早于它的时段视为候场，
   * 复用 {@link countdownLoop} 以 60s 粗粒度 tick 等待。
   */
  observeFromUnix?: number;
  /** 主循环轮询间隔（毫秒）。默认 500。 */
  gatePollMs?: number;
  /** 连续缺失确认次数（clamp 到 1..5）。默认 2。 */
  confirmCount?: number;
  /** 定时器兜底提前量（毫秒）。默认 150。 */
  fallbackAfterMs?: number;
  /** 是否启用下拉刷新（刷新后门 disarm 并进入冷却）。默认 true。 */
  refreshEnabled?: boolean;
  /** 两次刷新的最小间隔（毫秒）。默认 10000。 */
  refreshIntervalMs?: number;
  /** 距开票小于该秒数后不再刷新。默认 2。 */
  refreshStopAtSec?: number;
  /** 刷新后的冷却毫秒数（等页面重新渲染完成）。默认 250。 */
  refreshSettleMs?: number;
  /** 进度回调 (secondsLeft, elapsedS)；异常吞掉。 */
  progressCb?: ProgressCallback | null;
  /** 外部停止事件；置位后立即返回（trigger:"timer"）。 */
  stopEvent?: StopEvent | null;
}

/** {@link waitForSaleStart} 的返回结构。 */
export interface WaitSaleStartResult {
  /** 触发方式："gate" = 门确认开票；"timer" = 定时器兜底（含外部取消）。 */
  trigger: "gate" | "timer";
  /** 基线是否建成；未建成时门不武装，全程靠定时器兜底。 */
  baselineEstablished: boolean;
  /** 返回那一刻门是否处于武装态。 */
  armedAtTrigger: boolean;
  /** 门累计 re-arm 次数（含基线武装本身）。 */
  rearmCount: number;
  /** 从首次确认缺失到返回经过的毫秒数；无缺失记录时为 null。 */
  missingMs: number | null;
  /** UI 观察是否被禁用（dump 连续失败 ≥ 3 次，退化为纯定时器）。 */
  uiDisabled: boolean;
  /** 执行过的下拉刷新次数。 */
  refreshes: number;
  /** 本函数总耗时（毫秒，含候场段）。 */
  elapsedMs: number;
}

/**
 * 判断 uiautomator dump 中是否存在可见的倒计时节点。
 *
 * resource-id 等值或后缀匹配（语义同 `inspector/find.ts` 的 rid 规则），
 * 且要求元素可见（enabled 且 bounds 非空）。
 */
function findCountdownNode(elements: readonly UIElement[]): boolean {
  return elements.some(
    (el) =>
      el.visible &&
      (el.resourceId === COUNTDOWN_NODE_RESOURCE_ID ||
        el.resourceId.endsWith(COUNTDOWN_NODE_RESOURCE_ID)),
  );
}

/**
 * 解析 "WxH" 形态的屏幕尺寸（取自 {@link DeviceManager} 的设备快照）；
 * 空 / 解析失败 / 查询失败时回退 1080x1920 并 logger.warning。
 */
async function resolveScreenSize(deviceId: string): Promise<{ w: number; h: number }> {
  try {
    const info = await DeviceManager.shared().require(deviceId);
    const m = /^(\d+)x(\d+)$/.exec(info.screenSize);
    if (m !== null) {
      return { w: Number(m[1]), h: Number(m[2]) };
    }
    logger.warning(
      `[checklist] 无法解析屏幕尺寸 '${info.screenSize}'，刷新手势回退 1080x1920`,
    );
  } catch (exc) {
    logger.warning(`[checklist] 获取屏幕尺寸失败，刷新手势回退 1080x1920: ${excToStr(exc)}`);
  }
  return { w: 1080, h: 1920 };
}

/**
 * 等待开票：候场 → 建基线 → 门观察主循环，返回开票判定方式。
 *
 * 主循环每迭代固定顺序：
 * ① stopEvent；② 定时器最高优先级（now ≥ target + fallbackAfterMs →
 * trigger:"timer"，到点必触发，不等再一次 UI 探测）；③ dump UI 找倒计时节点
 * （dump 抛异常 ≠ 节点缺失，不喂门，连错 3 次 → uiDisabled 退化为纯定时器）；
 * ④ dump 返回后复查 deadline（IPC 可能跨越定时器 deadline，定时器仍然获胜）；
 * ⑤ gate.observe（到点后连续 confirmCount 次缺失 → trigger:"gate"）；
 * ⑥ 下拉刷新窗口（刷新后 disarm + 冷却）；⑦ 睡 gatePollMs + 进度上报。
 *
 * 基线先建立：进入观察窗后先以 min(3s, 距开票) 为窗口、gatePollMs 为步长，
 * 要求节点连续 {@link GATE_BASELINE_COUNT} 次在场才武装门；窗口内未建成基线
 * 则降级为纯定时器兜底（deviation：damai 原版在此抛 RuntimeError——checklist
 * 是编排层，不能因 UI 变体让整场抢票中断）。
 *
 * @returns {@link WaitSaleStartResult}
 */
export async function waitForSaleStart(
  deviceId: string,
  targetUnix: number,
  {
    observeFromUnix = targetUnix - 10,
    gatePollMs = GATE_DEFAULT_POLL_MS,
    confirmCount = 2,
    fallbackAfterMs = GATE_FALLBACK_AFTER_MS,
    refreshEnabled = true,
    refreshIntervalMs = 10000,
    refreshStopAtSec = 2,
    refreshSettleMs = 250,
    progressCb = null,
    stopEvent = null,
  }: WaitForSaleStartOptions = {},
): Promise<WaitSaleStartResult> {
  const startedMs = nowMs();
  const targetMs = targetUnix * 1000;
  const gate = new CountdownSignalGate({ confirmCount });

  let baselineEstablished = false;
  let uiDisabled = false;
  let refreshes = 0;
  let consecutiveDumpErrors = 0;

  /** 统一出口：汇总门状态与计时。 */
  const finish = (trigger: "gate" | "timer"): WaitSaleStartResult => {
    const now = nowMs();
    return {
      trigger,
      baselineEstablished,
      armedAtTrigger: gate.armed,
      rearmCount: gate.rearmCount,
      missingMs:
        gate.missingStartedAtMs === null
          ? null
          : Math.max(0, now - gate.missingStartedAtMs),
      uiDisabled,
      refreshes,
      elapsedMs: now - startedMs,
    };
  };

  /** 带容错的进度上报（等价 countdownLoop 的容错语义）。 */
  const reportProgress = async (): Promise<void> => {
    if (progressCb === null) {
      return;
    }
    try {
      await progressCb(targetUnix - nowSec(), (nowMs() - startedMs) / 1000);
    } catch (exc) {
      logger.error(`countdown callback raised, continuing: ${excToStr(exc)}`);
    }
  };

  // ---- 候场段：距观察窗开始还有一段时间 → 复用 60s 粗粒度 tick（语义不变）----
  if (nowSec() < observeFromUnix) {
    await countdownLoop(observeFromUnix, { progressCb, stopEvent });
  }

  // ---- 基线段：min(3s, 距开票) 窗口内连续 3 次见到节点才武装门 ----
  // 没有这个转换，错误或半渲染的页面看起来就像已开售。
  const baselineDeadlineMs = Math.min(nowMs() + GATE_BASELINE_WINDOW_MS, targetMs);
  let baselineStreak = 0;
  while (!baselineEstablished && !uiDisabled && nowMs() < baselineDeadlineMs) {
    if (stopEvent !== null && stopEvent.isSet()) {
      gate.disarm();
      return finish("timer");
    }
    let present: boolean;
    try {
      present = findCountdownNode(await dumpUi(deviceId));
      consecutiveDumpErrors = 0;
    } catch (exc) {
      // dump 抛异常 ≠ 节点缺失：不喂门；连错 3 次禁用 UI 观察
      consecutiveDumpErrors += 1;
      if (consecutiveDumpErrors >= 3) {
        uiDisabled = true;
        logger.warning(
          `[checklist] UI dump 连续失败 ${consecutiveDumpErrors} 次，` +
            `开票判定退化为纯定时器: ${excToStr(exc)}`,
        );
        gate.disarm();
        break;
      }
      await sleep(gatePollMs);
      continue;
    }
    if (present) {
      baselineStreak += 1;
      if (baselineStreak >= GATE_BASELINE_COUNT) {
        baselineEstablished = true;
        // 用状态机自身的 re-arm 语义武装门（首次 observe(true) 即 armed；
        // 基线未建成时门保持未武装，rearmCount 如实报告 0）
        gate.observe(true, nowMs(), nowMs() >= targetMs);
        break;
      }
    } else {
      // 基线要求「连续」在场：缺失即归零重来
      baselineStreak = 0;
    }
    await reportProgress();
    await sleep(gatePollMs);
  }
  if (!baselineEstablished) {
    // 门未武装：绝不让未经验证的缺失计数进入确认逻辑（纯定时器兜底）
    gate.disarm();
  }

  // 屏幕尺寸只解析一次（刷新手势用）
  const screenSize = refreshEnabled
    ? await resolveScreenSize(deviceId)
    : { w: 1080, h: 1920 };
  let lastRefreshMs = startedMs;
  let cooldownUntilMs = 0;

  // ---- 主循环 ----
  for (;;) {
    // ① 外部取消（与 countdownLoop 的取消语义一致，返回 trigger:"timer"）
    if (stopEvent !== null && stopEvent.isSet()) {
      return finish("timer");
    }
    // ② 定时器最高优先级：到点必触发，不等再一次 UI 探测
    const now = nowMs();
    if (now >= targetMs + fallbackAfterMs) {
      return finish("timer");
    }
    // ③ dump UI 找倒计时节点；基线未建成（门不武装）或 UI 已禁用时
    //    退化为纯定时器等待，不再做任何 UI 观察
    let present: boolean | null = null;
    if (baselineEstablished && !uiDisabled) {
      try {
        present = findCountdownNode(await dumpUi(deviceId));
        consecutiveDumpErrors = 0;
      } catch (exc) {
        consecutiveDumpErrors += 1;
        if (consecutiveDumpErrors >= 3) {
          uiDisabled = true;
          logger.warning(
            `[checklist] UI dump 连续失败 ${consecutiveDumpErrors} 次，` +
              `开票判定退化为纯定时器: ${excToStr(exc)}`,
          );
        }
      }
    }
    // ④ dump 返回后复查 deadline：IPC 可能跨越定时器 deadline，定时器仍然获胜
    if (present !== null && nowMs() >= targetMs + fallbackAfterMs) {
      return finish("timer");
    }
    // ⑤ 门观察：到点/过点后的节点缺失才计数；连续 confirmCount 次 → 确认开票
    if (present !== null) {
      const confirmed = gate.observe(present, nowMs(), nowMs() >= targetMs);
      if (confirmed) {
        return finish("gate");
      }
    }
    // ⑥ 下拉刷新窗口：距上次刷新 ≥ refreshIntervalMs、距开票 > refreshStopAtSec
    //    且不在冷却期；刷新会临时卸载倒计时节点 → disarm 后等节点重现再武装
    if (
      refreshEnabled &&
      !uiDisabled &&
      nowMs() - lastRefreshMs >= refreshIntervalMs &&
      nowSec() < targetUnix - refreshStopAtSec &&
      nowMs() >= cooldownUntilMs
    ) {
      try {
        await swipe(
          deviceId,
          screenSize.w / 2,
          screenSize.h * 0.25,
          screenSize.w / 2,
          screenSize.h * 0.65,
          { durationMs: 300 },
        );
      } catch (exc) {
        // 刷新手势失败不影响判定主流程
        logger.warning(`[checklist] 刷新手势失败（忽略）: ${excToStr(exc)}`);
      }
      gate.disarm();
      lastRefreshMs = nowMs();
      cooldownUntilMs = nowMs() + refreshSettleMs;
      refreshes += 1;
    }
    // ⑦ 睡一个轮询间隔 + 进度上报
    await sleep(gatePollMs);
    await reportProgress();
  }
}

// ---- 编排 ---------------------------------------------------------------------

/** {@link runChecklist} 的关键字参数（对应 Python 版 keyword-only 参数）。 */
export interface RunChecklistOptions {
  /** 开票时间 'YYYY-MM-DD HH:MM:SS'；空串表示「立即抢」。 */
  openTime?: string;
  /** 要选的票档序号（1-based）。 */
  priceIndex?: number;
  /** 观演人姓名列表（大麦实名制）。 */
  viewerNames?: string[] | null;
  /** 购票张数。 */
  ticketNum?: number;
  /** 抢票泵的提前预热时间（秒）。 */
  preheatSeconds?: number;
  /** NTP 服务器（默认 pool.ntp.org）。 */
  ntpServer?: string;
  /** NTP 超时（秒）。 */
  ntpTimeoutSec?: number;
  /** 每个阶段开始时触发的异步回调。 */
  onPhase?: ((phase: string) => void | Promise<void>) | null;
  /** 每个倒计时 tick 触发的异步回调，参数为 (seconds_left, elapsed_s)。 */
  onProgress?: ProgressCallback | null;
  /**
   * 是否禁用开票判定去抖门；true 时 Phase 3 回退为纯 {@link countdownLoop}
   * 候场（旧行为）。默认 false。
   */
  signalGateDisabled?: boolean;
  /**
   * 透传给 {@link waitForSaleStart} 的门参数；observeFromUnix / progressCb /
   * stopEvent 由 checklist 自己决定（observeFromUnix 恒为 fireAt），不接受覆盖。
   */
  signalGateOptions?: Omit<
    WaitForSaleStartOptions,
    "progressCb" | "stopEvent" | "observeFromUnix"
  > | null;
}

/**
 * 跑完整的抢票日 checklist：NTP 同步 → 连接检查 → 登录检查 → 详情页预热 →
 * 并行 warm dump → 倒计时 → fire。
 *
 * @returns {@link ChecklistResult}，含各阶段耗时与最终抢票结果。
 */
export async function runChecklist(
  deviceId: string,
  itemId: string,
  {
    openTime = "",
    priceIndex = 1,
    viewerNames = null,
    ticketNum = 1,
    preheatSeconds = DEFAULT_PREHEAT_SECONDS,
    ntpServer = "pool.ntp.org",
    ntpTimeoutSec = 5.0,
    onPhase = null,
    onProgress = null,
    signalGateDisabled = false,
    signalGateOptions = null,
  }: RunChecklistOptions = {},
): Promise<ChecklistResult> {
  const result = new ChecklistResult({ status: "preheat_open_time" });
  const phases = result.phases;

  const begin = (name: string, note = ""): PhaseEvent => {
    const ev = new PhaseEvent({ phase: name, startedAtMs: nowMs(), note });
    phases.push(ev);
    if (onPhase !== null) {
      // 对应 Python 的 asyncio.create_task：即发即忘，不阻塞主流程
      void safeCb(onPhase, name);
    }
    return ev;
  };

  const end = (ev: PhaseEvent): void => {
    ev.finishedAtMs = nowMs();
  };

  // ---- Phase -1: NTP 同步（尽力而为）----
  const pNtp = begin("ntp_sync", `server=${ntpServer}`);
  try {
    const ntpRes = await asyncQuery(ntpServer, ntpTimeoutSec);
    result.ntpOffsetMs = ntpRes.offsetMs;
    logger.info(
      `[checklist] NTP offset=${signed2(ntpRes.offsetMs)}ms delay=${ntpRes.delayMs.toFixed(2)}ms`,
    );
  } catch (exc) {
    logger.warning(`[checklist] NTP sync failed (continuing without): ${excToStr(exc)}`);
  }
  end(pNtp);

  const parsed = parseOpenTime(openTime);
  const targetUnix = parsed !== null ? parsed.getTime() / 1000 : null;

  // ---- Phase 0: 连接检查 ----
  const p0 = begin("connectivity", `device=${deviceId}`);
  try {
    const info = await DeviceManager.shared().require(deviceId);
    logger.info(`[checklist] device ok: ${info.model} ${info.screenSize}`);
  } catch (exc) {
    end(p0);
    result.status = "failed";
    result.error = `device_unreachable: ${excToStr(exc)}`;
    return result;
  }
  end(p0);

  // ---- Phase 1: app 启动 + 登录检查 ----
  const p1 = begin("login_check");
  try {
    const loggedIn = await damaiLoginCheck(deviceId, { timeout: 3.0 });
    if (!loggedIn.logged_in) {
      logger.warning("[checklist] not logged in — user needs to login manually");
    }
    result.grabResult = { login_check: loggedIn };
  } catch (exc) {
    logger.warning(`[checklist] login_check raised: ${excToStr(exc)}`);
  }
  end(p1);

  if (targetUnix !== null && preheatSeconds > 0) {
    // ---- Phase 2: 详情页预热 ----
    // 提前打开详情页，让购买按钮已进缓存
    const p2 = begin("preheat_open", `preheat_seconds=${formatPyFloat(preheatSeconds)}`);
    await damaiOpenConcert(deviceId, itemId);
    end(p2);

    // ---- Phase 2.5: 并行 dump 预热 ----
    // 预热期间并行地刷 UI dump + 截屏，让开票瞬间屏幕在 OS 缓存里已经
    // 「发热」，首次 find_by_text 落在 <50ms 而不是 ~300ms。
    if (preheatSeconds >= 5.0) {
      const p25 = begin("preheat_warm_dump", "parallel UI dump × 3");
      try {
        // Python 原版第二处 dump_ui(device_id, refresh=True) 的 refresh 参数
        // 并不存在（调用即 TypeError 被 except 吞掉）；按该阶段注释的意图
        // 迁移为三个并行调用。allSettled 等价 gather(return_exceptions=True)。
        await Promise.allSettled([
          dumpUi(deviceId),
          dumpUi(deviceId),
          screenshot(deviceId),
        ]);
      } catch (exc) {
        logger.warning(`[checklist] warm-dump failed (non-fatal): ${excToStr(exc)}`);
      }
      end(p25);
    }

    // ---- Phase 3: 倒计时 ----
    const p3 = begin("countdown", `open_time=${openTime}`);
    const fireAt = targetUnix - preheatSeconds;
    // Python 版在此捕获 asyncio.CancelledError 后补记 _end 再重抛；JS 侧的
    // sleep 未接 AbortSignal、正常路径不会中途抛出，故省略该分支。
    if (signalGateDisabled) {
      // 逃生通道：禁用去抖门时保持旧行为（纯候场到 fireAt）
      await countdownLoop(fireAt, { progressCb: onProgress });
    } else {
      // 开票判定去抖门：候场段复用 countdownLoop（observeFromUnix=fireAt，
      // 行为逐字不变），到点前后用「连续 N 次节点消失 + 定时器兜底」判定开票。
      // Phase 4 仍透传 openTime——damaiGrab 自带的开票时间闸门不被绕过，
      // 门提前确认时 waitUntil 立即返回，两层语义自动对齐。
      const waitRes = await waitForSaleStart(deviceId, targetUnix, {
        ...signalGateOptions,
        observeFromUnix: fireAt,
        progressCb: onProgress,
      });
      logger.info(
        `[checklist] 开票判定: trigger=${waitRes.trigger} baseline=${waitRes.baselineEstablished} ` +
          `rearm=${waitRes.rearmCount} refreshes=${waitRes.refreshes} uiDisabled=${waitRes.uiDisabled}`,
      );
    }
    end(p3);

    // ---- Phase 4: fire ----
    const p4 = begin("grab_fire");
    try {
      const grab = await damaiGrab(
        deviceId,
        itemId,
        priceIndex,
        viewerNames ?? [],
        ticketNum,
        openTime, // damai_grab 自带开票时间闸门
        {
          preheatSeconds: 0.0, // checklist 已预热
          maxRuntimeSec: 60.0, // 短窗口 —— 已预热
        },
      );
      result.grabResult = grab;
      result.status = grab.status ?? "submitted";
    } catch (exc) {
      result.status = "failed";
      result.error = `grab_error: ${excToStr(exc)}`;
    }
    end(p4);
  } else {
    // 无 open_time 或预热被禁用 —— 立即 fire
    const p4 = begin("grab_fire", "no open_time -> immediate");
    try {
      const grab = await damaiGrab(
        deviceId,
        itemId,
        priceIndex,
        viewerNames ?? [],
        ticketNum,
        "",
        {
          preheatSeconds: 0.0,
          maxRuntimeSec: 60.0,
        },
      );
      result.grabResult = grab;
      result.status = grab.status ?? "submitted";
    } catch (exc) {
      result.status = "failed";
      result.error = `grab_error: ${excToStr(exc)}`;
    }
    end(p4);
  }

  return result;
}

/**
 * 运行一个异步回调且不让异常外溢（等价 Python `_safe_cb`）。
 */
async function safeCb<A extends unknown[]>(
  cb: (...args: A) => void | Promise<void>,
  ...args: A
): Promise<void> {
  try {
    await cb(...args);
  } catch (exc) {
    logger.error(`checklist callback failed: ${excToStr(exc)}`);
  }
}
