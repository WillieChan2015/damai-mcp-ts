/**
 * L4 只读余票监控（tickets 仓库 monitor.rs 三态骨架的 TS 适配，见
 * docs/improvements-from-competitors.md §5）。
 *
 * 轮询大麦 App 详情页（uiautomator dump），把页面证据折叠为四种余票状态：
 * `available`（有票）/ `not_on_sale`（未开售）/ `sold_out`（售罄）/ `unknown`
 * （未知）。带固定间隔 + 指数退避 + 连续失败自动停止。
 *
 * 只读硬约束（实现层保证）：
 * - 本模块仅 import `shell`（只在开始时执行一次 `am start` 深链"打开页面"，
 *   属导航而非点击，且仅当 `openPage=true`）、`dumpUi`（只读 UI 采样）、
 *   `DAMAI_PACKAGE` 包名常量与 `logger`；
 * - 绝不 import 任何点击 / 滑动 / 按键 / 文本输入类动作函数，也绝不 import
 *   damai_grab / damai_confirm_order / damai_pay 等下单符号——轮询期间零写入指令；
 * - tests/test_monitor.test.ts 用源码正则守护固化上述承诺。
 *
 * 词表移植说明：tickets 的 16 个阻塞词按四态折叠为 sold_out / not_on_sale
 * 两组（11 + 5），reason 保留原始命中词，信息不丢失；正证据为可购 CTA 文案
 * （UI dump 无库存数字可读，正证据即 CTA）。
 */
import { setTimeout as sleep } from "node:timers/promises";

import { shell } from "../device/adb";
import { dumpUi } from "../inspector/dump";
import type { UIElement } from "../inspector/models";
import { DAMAI_PACKAGE } from "./actions";
import { logger } from "../utils/logging";

// ---- 常量 ----------------------------------------------------------------------

/** found 时供人工核对用的移动端详情页 URL 模板（拼接 itemId 即得完整地址）。 */
export const MONITOR_DETAIL_URL_TEMPLATE =
  "https://m.damai.cn/damai/detail/item.html?itemId=";

/**
 * 大麦详情页"距开售倒计时"节点的 resource-id。
 *
 * 与 checklist 观察的是同一节点；按并行实现隔离规则在本文件内独立定义，
 * 不从 checklist import 其新导出。
 */
export const MONITOR_COUNTDOWN_RESOURCE_ID = "cn.damai:id/id_project_count_down_layout";

/** 终局性不可购词组：命中即判 `sold_out`（含演出已结束 / 取消 / 下架等本场级终局态）。 */
export const MONITOR_SOLD_OUT_WORDS = [
  "售罄",
  "售完",
  "缺货",
  "无票",
  "无货",
  "停售",
  "不可售",
  "不可购",
  "已结束",
  "已取消",
  "下架",
] as const;

/** 未开售词组：命中即判 `not_on_sale`。 */
export const MONITOR_NOT_ON_SALE_WORDS = [
  "未开售",
  "未开始",
  "即将开售",
  "登记",
  "候补",
] as const;

/** 可购正证据词组（CTA 文案）。 */
export const MONITOR_POSITIVE_WORDS = [
  "立即购买",
  "立即预订",
  "选座购买",
  "预售中",
  "售票中",
] as const;

/** dump 连续失败多少次后自动停止。 */
export const MONITOR_MAX_CONSECUTIVE_ERRORS = 5;

/** 指数退避延迟的封顶毫秒数（5 分钟）。 */
export const MONITOR_MAX_BACKOFF_MS = 300_000;

/** 业务侧允许的最小轮询间隔（毫秒）。库层不强制，由 MCP 工具的 zod 承担边界校验。 */
export const MONITOR_MIN_INTERVAL_MS = 5_000;

/** 业务侧允许的最大轮询间隔（毫秒）。库层不强制，由 MCP 工具的 zod 承担边界校验。 */
export const MONITOR_MAX_INTERVAL_MS = 3_600_000;

/** 业务侧允许的最大尝试次数。库层不强制，由 MCP 工具的 zod 承担边界校验。 */
export const MONITOR_MAX_ATTEMPTS_LIMIT = 100_000;

/** 轮询间隔默认值：30 秒。 */
const DEFAULT_INTERVAL_MS = 30_000;

/** 深链打开详情页后等待页面渲染再采样的间歇（毫秒）。 */
const OPEN_SETTLE_MS = 500;

/** 深链 `am start` 的超时（秒）。 */
const OPEN_TIMEOUT_SEC = 10;

/** 连败停止时错误信息的最大长度（字符；截断后不含上游原始输出，只保留原因开头）。 */
const ERROR_MESSAGE_MAX_CHARS = 200;

// ---- 类型 ----------------------------------------------------------------------

/** 余票四态。 */
export type Availability = "available" | "not_on_sale" | "sold_out" | "unknown";

/** 单次判定的结果：状态 + 命中证据（文案词，或倒计时节点的 "countdown_node"）。 */
export interface MonitorJudge {
  status: Availability;
  reason: string | null;
}

/** {@link classifyAvailability} 的可选项（词表均可注入，便于测试与站点适配）。 */
export interface ClassifyAvailabilityOptions {
  /** 售罄词组；默认 {@link MONITOR_SOLD_OUT_WORDS}。 */
  soldOutWords?: readonly string[];
  /** 未开售词组；默认 {@link MONITOR_NOT_ON_SALE_WORDS}。 */
  notOnSaleWords?: readonly string[];
  /** 正证据词组；默认 {@link MONITOR_POSITIVE_WORDS}。 */
  positiveWords?: readonly string[];
  /** 倒计时节点 resource-id；传 null 关闭该检查。默认 {@link MONITOR_COUNTDOWN_RESOURCE_ID}。 */
  countdownResourceId?: string | null;
}

/** 每次尝试完成后的上报快照。 */
export interface MonitorReportSnapshot {
  /** 当前尝试序号（从 1 起）。 */
  attempt: number;
  /** 本次判定的状态；dump 失败时为 "unknown"。 */
  status: Availability;
  /** 本次判定的命中证据；dump 失败或无证据时为 null。 */
  reason: string | null;
  /** 当前连续失败计数（成功即清零）。 */
  errors: number;
  /** 即将入睡的毫秒数；本轮不再继续（即将停止）时为 null。 */
  nextDelayMs: number | null;
}

/** {@link MonitorOptions.onReport} 的回调类型；异常会被吞掉并记录 warning。 */
export type MonitorReportCallback = (snapshot: MonitorReportSnapshot) => void | Promise<void>;

/** {@link monitorAvailability} 的轮询选项。 */
export interface MonitorOptions {
  /**
   * 轮询间隔毫秒；默认 30_000。
   * 库层只要求 > 0（5000–3600000 的业务边界由 MCP 工具的 zod schema 承担，
   * 与 tickets 在任务管理器层的校验同角色）。
   */
  intervalMs?: number;
  /**
   * 最大尝试次数；默认 0 = 无限轮询（tickets 语义忠实保留）。
   * 接线层（MCP 工具）必须给有限默认值，避免调用方忘记终止。
   */
  maxAttempts?: number;
  /** dump 连续失败多少次后停止；默认 {@link MONITOR_MAX_CONSECUTIVE_ERRORS}。 */
  maxConsecutiveErrors?: number;
  /** 退避延迟封顶毫秒；默认 {@link MONITOR_MAX_BACKOFF_MS}。 */
  maxBackoffMs?: number;
  /** 墙钟截止（Unix 毫秒）；到达即停 "timeout"。默认 null = 不设截止。 */
  deadlineUnixMs?: number | null;
  /** 开始时是否经 `am start` 深链打开详情页；默认 true（只执行一次，属导航非点击）。 */
  openPage?: boolean;
  /** 外部取消事件（结构等价 checklist 的 StopEvent）；置位即停 "cancelled"。 */
  stopEvent?: { readonly isSet: () => boolean } | null;
  /** 每次尝试完成后的快照回调；异常会被吞掉并记录 warning，绝不影响轮询本身。 */
  onReport?: MonitorReportCallback | null;
}

/** 停止原因。 */
export type MonitorStopReason =
  /** 判定有票（found=true），立即返回。 */
  | "available"
  /** 达到最大尝试次数仍未发现。 */
  | "max_attempts"
  /** dump 连续失败达到上限。 */
  | "consecutive_errors"
  /** 外部取消（stopEvent 置位）。 */
  | "cancelled"
  /** 到达墙钟截止（deadlineUnixMs）。 */
  | "timeout"
  /** 大麦不在前台（dump 中无 cn.damai 包元素；只读监控不做自动重导航）。 */
  | "not_foreground"
  /** 深链两次尝试后详情页仍未加载。 */
  | "page_not_loaded";

/** {@link MonitorResult} 的构造参数。 */
export interface MonitorResultInit {
  found: boolean;
  finalStatus: Availability;
  attempts: number;
  consecutiveErrors: number;
  stopReason: MonitorStopReason;
  detailUrl: string;
  lastReason: string | null;
  elapsedMs: number;
  error: string | null;
}

/** {@link monitorAvailability} 的结果。 */
export class MonitorResult {
  /** 是否判定有票后提前返回。 */
  readonly found: boolean;
  /** 最后一次成功判定的状态（从未成功判定过则为 "unknown"）。 */
  readonly finalStatus: Availability;
  /** 已完成的尝试次数（深链打开阶段的加载探测不计入）。 */
  readonly attempts: number;
  /** 停止时刻的连续失败计数。 */
  readonly consecutiveErrors: number;
  /** 停止原因。 */
  readonly stopReason: MonitorStopReason;
  /** 详情页 URL（拼接 itemId），供人工打开核对。 */
  readonly detailUrl: string;
  /** 最后一次判定的命中证据（文案词 / "countdown_node"）；无则 null。 */
  readonly lastReason: string | null;
  /** 从调用到停止的总耗时（毫秒）。 */
  readonly elapsedMs: number;
  /** 停止相关的中文错误描述（连败 / 页面未加载）；其余停止原因与正常路径为 null。 */
  readonly error: string | null;

  constructor(init: MonitorResultInit) {
    this.found = init.found;
    this.finalStatus = init.finalStatus;
    this.attempts = init.attempts;
    this.consecutiveErrors = init.consecutiveErrors;
    this.stopReason = init.stopReason;
    this.detailUrl = init.detailUrl;
    this.lastReason = init.lastReason;
    this.elapsedMs = init.elapsedMs;
    this.error = init.error;
  }

  /**
   * 序列化为普通对象。
   *
   * 全部 snake_case（对外表面，可直接作为 MCP 工具的 structuredContent）。
   */
  toDict(): {
    found: boolean;
    final_status: Availability;
    attempts: number;
    consecutive_errors: number;
    stop_reason: MonitorStopReason;
    detail_url: string;
    last_reason: string | null;
    elapsed_ms: number;
    error: string | null;
  } {
    return {
      found: this.found,
      final_status: this.finalStatus,
      attempts: this.attempts,
      consecutive_errors: this.consecutiveErrors,
      stop_reason: this.stopReason,
      detail_url: this.detailUrl,
      last_reason: this.lastReason,
      elapsed_ms: this.elapsedMs,
      error: this.error,
    };
  }
}

// ---- 判定（纯函数） -------------------------------------------------------------

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * 子串包含匹配（语义同 `src/inspector/find.ts` 的 matchesText 非精确分支）：
 * 候选（text / content-desc）非空且包含词即命中。
 */
function elementMentionsWord(el: UIElement, word: string): boolean {
  return (
    (el.text !== "" && el.text.includes(word)) ||
    (el.contentDesc !== "" && el.contentDesc.includes(word))
  );
}

/** 在可见元素的 text / content-desc 里找第一个命中的词；无命中返回 null。 */
function firstMentionedWord(
  elements: readonly UIElement[],
  words: readonly string[],
): string | null {
  for (const word of words) {
    for (const el of elements) {
      if (el.visible && elementMentionsWord(el, word)) {
        return word;
      }
    }
  }
  return null;
}

/**
 * 倒计时节点是否在场。
 *
 * resource-id 等值 / 后缀 / 包含匹配（语义同 `src/inspector/find.ts` 的
 * matchesRid 非精确分支）。
 */
function countdownNodePresent(elements: readonly UIElement[], resourceId: string): boolean {
  return elements.some(
    (el) =>
      el.visible &&
      el.resourceId !== "" &&
      (el.resourceId === resourceId ||
        el.resourceId.endsWith(resourceId) ||
        el.resourceId.includes(resourceId)),
  );
}

/**
 * 把 UI dump 的元素列表折叠为余票四态（纯函数，可直接单测）。
 *
 * 扫描全部可见元素的 `text` 与 `content-desc`，优先级从高到低：
 *
 * 1. 命中售罄词组 → `sold_out`（reason=命中词）；
 * 2. 命中未开售词组 → `not_on_sale`（reason=命中词）；
 * 3. 倒计时节点在场（resource-id 等值/后缀匹配）→ `not_on_sale`
 *    （reason="countdown_node"）；
 * 4. 命中正证据 CTA 词组 → `available`（reason=命中词）；
 * 5. 其余一律 `unknown`——无正证据时保持轮询，绝不臆断。
 *
 * 阻塞词优先于正证据：页面同屏出现"售罄"与"立即购买"（如按钮未及时隐藏）时
 * 不得误报有票。
 */
export function classifyAvailability(
  elements: readonly UIElement[],
  options: ClassifyAvailabilityOptions = {},
): MonitorJudge {
  const soldOutWords = options.soldOutWords ?? MONITOR_SOLD_OUT_WORDS;
  const notOnSaleWords = options.notOnSaleWords ?? MONITOR_NOT_ON_SALE_WORDS;
  const positiveWords = options.positiveWords ?? MONITOR_POSITIVE_WORDS;
  const countdownRid =
    options.countdownResourceId !== undefined
      ? options.countdownResourceId
      : MONITOR_COUNTDOWN_RESOURCE_ID;

  const soldOut = firstMentionedWord(elements, soldOutWords);
  if (soldOut !== null) {
    return { status: "sold_out", reason: soldOut };
  }
  const notOnSale = firstMentionedWord(elements, notOnSaleWords);
  if (notOnSale !== null) {
    return { status: "not_on_sale", reason: notOnSale };
  }
  if (countdownRid !== null && countdownRid !== "" && countdownNodePresent(elements, countdownRid)) {
    return { status: "not_on_sale", reason: "countdown_node" };
  }
  const positive = firstMentionedWord(elements, positiveWords);
  if (positive !== null) {
    return { status: "available", reason: positive };
  }
  return { status: "unknown", reason: null };
}

// ---- 轮询 ----------------------------------------------------------------------

/** dump 中是否存在属于大麦包的元素（前台判据 / 深链加载判据）。 */
function hasDamaiPackage(elements: readonly UIElement[]): boolean {
  return elements.some((el) => el.package === DAMAI_PACKAGE);
}

/**
 * 第 n 次连续失败（n ≥ 1）后的退避延迟：`interval · 2^(n-1)`，
 * 下限 interval、封顶 maxBackoffMs——首次失败睡 interval，随后逐次翻倍
 * （10, 20, 40, … 直至封顶），成功一次即回到 interval。
 */
function backoffDelayMs(intervalMs: number, errors: number, maxBackoffMs: number): number {
  const raw = intervalMs * 2 ** (errors - 1);
  return Math.max(Math.min(raw, maxBackoffMs), intervalMs);
}

/**
 * 轮询大麦详情页的余票状态（只读；绝不点击购买、绝不提交订单）。
 *
 * 流程（对齐 tickets monitor.rs 的轮询骨架）：
 *
 * 1. `openPage=true`（默认）时经 `am start` 深链打开详情页：先
 *    `damai://item?id=<itemId>`，未加载再回退 web URL；以「dump 中存在
 *    package === cn.damai 的元素」为加载判据（不等待购买按钮——未开售时按钮
 *    文案本就不是"立即购买"）。两次尝试后仍未加载 → 停止 `"page_not_loaded"`。
 *    深链只在开始时执行一次，属"打开页面"而非点击；轮询期间零写入指令。
 * 2. 循环：stopEvent 置位 → `"cancelled"`；deadline 到 → `"timeout"`；
 *    dump 异常 → 连败计数 +1，达上限停 `"consecutive_errors"`（错误信息中文、
 *    截断 200 字符、不含上游原始输出），否则按指数退避入睡后继续；dump 成功
 *    → 连败清零；dump 中无 cn.damai 包元素 → 停 `"not_foreground"`（不做自动
 *    重导航，避免干扰设备上的人工操作）；判定 `available` → 立即返回
 *    `found=true`（附 detailUrl 供人工确认）；其余状态继续轮询（未开售/售罄
 *    都可能翻转，不提前停）。
 * 3. `maxAttempts > 0` 且尝试次数达上限 → 停 `"max_attempts"`（found=false）。
 *
 * @throws 中文 Error——`intervalMs <= 0`（含 NaN）或 `maxAttempts < 0`（含 NaN）时。
 */
export async function monitorAvailability(
  deviceId: string,
  itemId: string,
  options: MonitorOptions = {},
): Promise<MonitorResult> {
  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    maxAttempts = 0,
    maxConsecutiveErrors = MONITOR_MAX_CONSECUTIVE_ERRORS,
    maxBackoffMs = MONITOR_MAX_BACKOFF_MS,
    deadlineUnixMs = null,
    openPage = true,
    stopEvent = null,
    onReport = null,
  } = options;

  if (!(intervalMs > 0)) {
    throw new Error("监控间隔必须为正数");
  }
  if (!(maxAttempts >= 0)) {
    throw new Error("max_attempts 不能为负");
  }

  const startedAtMs = Date.now();
  const detailUrl = MONITOR_DETAIL_URL_TEMPLATE + itemId;
  let attempts = 0;
  let errors = 0;
  let lastStatus: Availability = "unknown";
  let lastReason: string | null = null;

  /** 每次尝试恰好上报一次快照；回调异常吞掉并记 warning，绝不影响轮询。 */
  const report = async (
    status: Availability,
    reason: string | null,
    nextDelayMs: number | null,
  ): Promise<void> => {
    if (onReport === null) {
      return;
    }
    try {
      await onReport({ attempt: attempts, status, reason, errors, nextDelayMs });
    } catch (exc) {
      logger.warning(`监控上报回调异常（已忽略）: ${excMessage(exc)}`);
    }
  };

  const finish = (
    stopReason: MonitorStopReason,
    error: string | null,
    overrides: { finalStatus?: Availability; lastReason?: string | null } = {},
  ): MonitorResult =>
    new MonitorResult({
      found: stopReason === "available",
      finalStatus: overrides.finalStatus ?? lastStatus,
      attempts,
      consecutiveErrors: errors,
      stopReason,
      detailUrl,
      lastReason: overrides.lastReason !== undefined ? overrides.lastReason : lastReason,
      elapsedMs: Date.now() - startedAtMs,
      error,
    });

  // 外部取消 / 已过截止时连深链都不打开，不要打扰设备
  if (stopEvent !== null && stopEvent.isSet()) {
    return finish("cancelled", null);
  }
  if (deadlineUnixMs !== null && Date.now() >= deadlineUnixMs) {
    return finish("timeout", null);
  }

  // ---- 开始：深链打开详情页（最多两次尝试：app 深链 → web URL 回退） ----------
  if (openPage) {
    const deepLinks = [
      `damai://item?id=${itemId}`,
      `https://m.damai.cn/shows/item.html?itemId=${itemId}`,
    ];
    let loaded = false;
    for (const url of deepLinks) {
      await shell("am", "start", "-a", "android.intent.action.VIEW", "-d", url, {
        deviceId,
        check: false,
        timeout: OPEN_TIMEOUT_SEC,
      });
      await sleep(OPEN_SETTLE_MS);
      let elements: UIElement[];
      try {
        elements = await dumpUi(deviceId);
      } catch (exc) {
        logger.warning(`打开详情页后的 UI 采样失败: ${excMessage(exc)}`);
        continue;
      }
      if (hasDamaiPackage(elements)) {
        loaded = true;
        break;
      }
    }
    if (!loaded) {
      const msg =
        `无法打开大麦详情页（item_id=${itemId}）：` +
        `两次深链尝试后 UI 中均未发现 ${DAMAI_PACKAGE} 包元素`;
      logger.warning(msg);
      return finish("page_not_loaded", msg, { finalStatus: "unknown", lastReason: null });
    }
  }

  // ---- 轮询主循环 -------------------------------------------------------------
  for (;;) {
    if (stopEvent !== null && stopEvent.isSet()) {
      return finish("cancelled", null);
    }
    if (deadlineUnixMs !== null && Date.now() >= deadlineUnixMs) {
      return finish("timeout", null);
    }

    attempts++;
    let elements: UIElement[];
    try {
      elements = await dumpUi(deviceId);
    } catch (exc) {
      errors += 1;
      const full = `UI 采样连续失败 ${errors} 次，最后错误: ${excMessage(exc)}`;
      const msg =
        full.length > ERROR_MESSAGE_MAX_CHARS
          ? full.slice(0, ERROR_MESSAGE_MAX_CHARS)
          : full;
      logger.warning(msg);
      if (errors >= maxConsecutiveErrors) {
        await report("unknown", null, null);
        return finish("consecutive_errors", msg);
      }
      const delay = backoffDelayMs(intervalMs, errors, maxBackoffMs);
      await report("unknown", null, delay);
      await sleep(delay);
      continue;
    }

    // 成功响应清零连败计数（tickets 既有语义）
    errors = 0;
    if (!hasDamaiPackage(elements)) {
      await report("unknown", null, null);
      return finish("not_foreground", null);
    }

    const judge = classifyAvailability(elements);
    if (judge.status === "available") {
      await report("available", judge.reason, null);
      return finish("available", null, { finalStatus: "available", lastReason: judge.reason });
    }
    lastStatus = judge.status;
    lastReason = judge.reason;

    if (maxAttempts > 0 && attempts >= maxAttempts) {
      await report(judge.status, judge.reason, null);
      return finish("max_attempts", null);
    }
    await report(judge.status, judge.reason, intervalMs);
    await sleep(intervalMs);
  }
}
