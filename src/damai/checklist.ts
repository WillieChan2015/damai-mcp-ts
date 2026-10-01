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
 *     3. 倒计时循环       （每分钟更新一次状态）
 *     4. 开票触发         （T-0 触发抢票流水线）
 *     5. 结果 + 可选提醒
 *
 * 实际点击经 {@link damaiGrab} 完成；本模块只负责调度、状态与可读进度。
 */
import { setTimeout as sleep } from "node:timers/promises";

import { screenshot } from "../actions/actions";
import { formatPyFloat } from "../device/adb";
import { DeviceManager } from "../device/manager";
import { dumpUi } from "../inspector/dump";
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
    await countdownLoop(fireAt, { progressCb: onProgress });
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
