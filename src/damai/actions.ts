/**
 * 大麦专属业务动作：登录检查、打开演唱会、选票档/观演人、抢票
 * （Python `damai/actions.py` 的 TS 对应物）。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { screenshot, tap, waitMs } from "../actions/actions";
import { formatPyFloat, shell } from "../device/adb";
import { dumpUi } from "../inspector/dump";
import { assertText, waitForElement } from "../inspector/find";
import type { UIElement } from "../inspector/models";
import {
  AppNotRunningError,
  DamaiGrabFailedError,
  DamaiLoginExpiredError,
  UIElementNotFoundError,
} from "../utils/errors";
import { logger } from "../utils/logging";
import { DamaiSelectors } from "./selectors";

/** 大麦 app 包名。 */
export const DAMAI_PACKAGE = "cn.damai";
/** 大麦主 Activity。 */
export const DAMAI_MAIN_ACTIVITY = "cn.damai.homepage.MainActivity";
/** 未登录态在 UI 上可见的文本。 */
export const DAMAI_LOGGED_OUT_TEXTS = ["登录/注册", "立即登录"] as const;
/** 登录 / 安全验证 Activity 的特征串（出现在 dumpsys window 里即视为验证中）。 */
export const DAMAI_AUTH_ACTIVITY_MARKERS = [
  "com.ali.user.mobile.login.ui.UserLoginActivity",
  "com.ali.user.open.tbauth.ui.TbAuth",
  "com.alibaba.wireless.security.open.middletier.fc.ui.ContainerActivity",
] as const;

// ---- 返回结构 ----------------------------------------------------------------
//
// 键名保持 Python 版 dict 的 snake_case 原样（这是 MCP 工具响应的对外表面，
// checklist 与上层 server 直接按这些键取值，改动会破坏行为保真）。

/** {@link damaiLoginCheck} 的返回结构。 */
export type LoginCheckResult = {
  /** 用户是否已登录。 */
  logged_in: boolean;
  /** 大麦是否在前台。 */
  foreground: boolean;
  /** 需要用户处理的提示；无提示时为 null。 */
  user_hint: string | null;
};

/** {@link damaiOpenConcert} 的返回结构。 */
export type OpenConcertResult = {
  item_id: string;
  /** 详情页是否加载完成（购买按钮出现）。 */
  loaded: boolean;
  /** 打开耗时（毫秒）。 */
  elapsed_ms: number;
};

/** {@link damaiGrab} 的返回结构。`failed` 分支只含基础四键。 */
export type GrabResult = {
  /** "ready_for_human"（等人工确认）| "submitted"（已提交订单）| "failed"。 */
  status: "ready_for_human" | "submitted" | "failed";
  /** 从流程开始到结束的耗时（毫秒）。 */
  elapsed_ms: number;
  item_id?: string;
  price_index?: number;
  viewer_names?: string[];
  /** 是否停在等待人工确认的状态。 */
  requires_human_confirmation?: boolean;
  /** 是否已触碰支付流程（恒为 false——支付永远不自动点击）。 */
  payment_started?: boolean;
  /** 调试截图路径列表。 */
  screenshots: string[];
  /** 失败原因；成功为 null。 */
  error: string | null;
};

// ---- 内部小工具 ---------------------------------------------------------------

/** 当前 Unix 秒（等价 Python 的 time.time()）。 */
function nowSec(): number {
  return Date.now() / 1000;
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 对应 Python `int(time.time())` 的截断秒。 */
function truncSec(): number {
  return Math.trunc(nowSec());
}

/** Python str repr 风格的单引号/双引号字符串（用于日志里渲染观演人列表）。 */
function pyStrRepr(s: string): string {
  if (s.includes("'") && !s.includes('"')) {
    return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** Python f-string 渲染 list[str] 的形态：`['杨安琪', '张三']`。 */
function pyListRepr(items: readonly string[]): string {
  return `[${items.map(pyStrRepr).join(", ")}]`;
}

/** 调试截图目录（等价 Python `_shots_dir`）。 */
const SHOTS_DIR = "damai_shots";

/**
 * 调试截图目录路径；目录不存在则创建。
 *
 * Python `Path("./damai_shots")` 的 `str()` 会把 "./" 规范化掉，产出
 * `damai_shots/xxx.png` 形态的路径——此处保持一致。
 */
export function shotsDir(): string {
  mkdirSync(SHOTS_DIR, { recursive: true });
  return SHOTS_DIR;
}

// ---- helpers ----------------------------------------------------------------

/**
 * 检查当前栈顶 Activity——用于检测 app 崩溃 / 前台丢失。
 */
export async function isDamaiForeground(deviceId: string): Promise<boolean> {
  const out = await shell("dumpsys", "activity", "activities", {
    deviceId,
    timeout: 5,
    check: false,
  });
  return out.includes(DAMAI_PACKAGE);
}

/**
 * 严格解析 "YYYY-MM-DD HH:MM:SS" 为本地时区的 Date
 * （等价 Python `datetime.strptime(s, "%Y-%m-%d %H:%M:%S")`）。
 *
 * 按迁移约定：禁止 `new Date(字符串)` 解析非严格 ISO，改用六参构造，
 * 语义为按**本地时区**解释。格式或范围非法时抛错（文案复刻 Python
 * strptime/datetime 的 ValueError 形态）。
 */
export function parseIso(s: string): Date {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(s);
  if (m === null) {
    throw new Error(`time data '${s}' does not match format '%Y-%m-%d %H:%M:%S'`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
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
  const d = new Date(0);
  d.setFullYear(year, month - 1, day);
  d.setHours(hour, minute, second, 0);
  return d;
}

/** 某年某月的天数（含闰年）。 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * 睡到目标 Unix 秒（墙钟），带细粒度轮询
 * （等价 Python `_wait_until`：末段（<200ms）不做分段轮询，一次睡满剩余
 * 时间到点返回；更长的时间按 `pollMs` 分段睡，且始终预留最后 100ms
 * 给末段的精确睡眠）。
 */
export async function waitUntil(
  targetTs: number,
  { pollMs = 200 }: { pollMs?: number } = {},
): Promise<void> {
  for (;;) {
    const remaining = targetTs - nowSec();
    if (remaining <= 0) {
      return;
    }
    // 末段（<200ms）一次睡满剩余时间
    if (remaining < 0.2) {
      await sleep(Math.max(remaining, 0) * 1000);
      return;
    }
    await sleep(Math.min(remaining - 0.1, pollMs / 1000) * 1000);
  }
}

/**
 * 在大麦 UI 中匹配观演人显示名——可能带 "(实名)" 后缀。
 */
export function isInViewerNameList(text: string, viewers: readonly string[]): boolean {
  const t = text.trim();
  for (const v of viewers) {
    if (t.includes(v) || t.startsWith(v)) {
      return true;
    }
  }
  return false;
}

// ---- 1. 登录检查 -------------------------------------------------------------

/**
 * 校验大麦 app 在前台且用户已登录。
 *
 * @returns {@link LoginCheckResult}
 * @throws {@link AppNotRunningError} 大麦不在前台时。
 */
export async function damaiLoginCheck(
  deviceId: string,
  { timeout = 3.0 }: { timeout?: number } = {},
): Promise<LoginCheckResult> {
  if (!(await isDamaiForeground(deviceId))) {
    throw new AppNotRunningError(
      `大麦 (${DAMAI_PACKAGE}) 不在前台，请先打开 APP 并登录。`,
    );
  }
  const windowState = await shell("dumpsys", "window", "windows", {
    deviceId,
    timeout: 5,
    check: false,
  });
  if (DAMAI_AUTH_ACTIVITY_MARKERS.some((marker) => windowState.includes(marker))) {
    return {
      logged_in: false,
      foreground: true,
      user_hint: "请在大麦内完成登录或安全验证后再继续。",
    };
  }
  // 已登录指示：「我的」tab 显示用户名 / 我的订单可见。
  // 账户 tab 文案在 9.0.31 由 "登录/注册" 改成了 "立即登录"。
  for (const text of DAMAI_LOGGED_OUT_TEXTS) {
    const loginBtn = await assertText(deviceId, text, { timeout });
    if (loginBtn) {
      return { logged_in: false, foreground: true, user_hint: null };
    }
  }
  return { logged_in: true, foreground: true, user_hint: null };
}

// ---- 2. 打开演唱会 ------------------------------------------------------------

/**
 * 通过 item_id 跳转到演唱会详情页。
 *
 * 优先用 app 能处理的深链 scheme `damai://item?id=...`；失败时经 adb am start
 * 回退到 web URL 强制在 app 内打开。
 *
 * @returns {@link OpenConcertResult}
 */
export async function damaiOpenConcert(
  deviceId: string,
  itemId: string,
  { selectors = null }: { selectors?: DamaiSelectors | null } = {},
): Promise<OpenConcertResult> {
  const t0 = nowSec();
  const sel = selectors ?? new DamaiSelectors();
  // 方案 1：app 深链
  await shell(
    "am", "start", "-W", "-a", "android.intent.action.VIEW",
    "-d", `damai://item?id=${itemId}`,
    { deviceId, check: false, timeout: 10 },
  );
  await waitMs(1500);
  if (!(await isDamaiForeground(deviceId))) {
    // 方案 2：web URL → 强制在 app 内打开
    await shell(
      "am", "start", "-W", "-a", "android.intent.action.VIEW",
      "-d", `https://m.damai.cn/shows/item.html?itemId=${itemId}`,
      { deviceId, check: false, timeout: 10 },
    );
    await waitMs(2000);
  }
  // 等购买按钮出现（说明页面加载完成）
  let loaded: boolean;
  try {
    await waitForElement(deviceId, `text=${sel.detailBuyButton}`, { timeout: 8.0 });
    loaded = true;
  } catch (exc) {
    if (!(exc instanceof UIElementNotFoundError)) {
      throw exc;
    }
    loaded = false;
  }
  return {
    item_id: itemId,
    loaded,
    elapsed_ms: Math.trunc((nowSec() - t0) * 1000),
  };
}

// ---- 3. 选票档 ----------------------------------------------------------------

/**
 * 从价格选择弹层里挑第 N 个票档。
 *
 * 策略：dump UI，找出文本匹配 `¥<数字>` 的元素，返回第（priceIndex）个。
 * 点击其中心点。
 *
 * @returns 命中的票档元素（已点击）。
 * @throws {@link DamaiGrabFailedError} 价格表未弹出 / 没有价格元素 / 序号越界。
 */
export async function damaiSelectPrice(
  deviceId: string,
  priceIndex: number,
  {
    selectors = null,
    timeout = 4.0,
  }: { selectors?: DamaiSelectors | null; timeout?: number } = {},
): Promise<UIElement> {
  // 与 Python 原版一致：该变量在函数体内实际未被使用（按 text=¥ 定位），
  // 仅为保持参数语义保留。
  const sel = selectors ?? new DamaiSelectors();
  // 确保价格弹层已打开
  try {
    await waitForElement(deviceId, "text=¥", { timeout, pollInterval: 0.2 });
  } catch (exc) {
    if (exc instanceof UIElementNotFoundError) {
      throw new DamaiGrabFailedError(`价格表未弹出: ${excToStr(exc)}`, { cause: exc });
    }
    throw exc;
  }

  // dump 并找出所有 ¥xxx 元素，自上而下排序
  const elements = await dumpUi(deviceId);
  const priceEls = elements.filter(
    (e) => e.text !== "" && /^¥\d+(\.\d+)?$/.test(e.text.trim()) && e.visible,
  );
  if (priceEls.length === 0) {
    throw new DamaiGrabFailedError("未找到任何 ¥xxx 价格元素");
  }
  // 按 Y 再按 X 排序（自上而下、从左到右）
  priceEls.sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
  if (priceIndex < 1 || priceIndex > priceEls.length) {
    throw new DamaiGrabFailedError(
      `price_index=${priceIndex} 超出范围 (1..${priceEls.length})`,
    );
  }
  const target = priceEls[priceIndex - 1];
  await tap(deviceId, ...target.center);
  await waitMs(400);
  return target;
}

// ---- 4. 选观演人 ---------------------------------------------------------------

/**
 * 点击每个具名观演人旁的勾选项。返回已点击的元素。
 *
 * @throws {@link DamaiGrabFailedError} 在 timeout 内没能点齐全部观演人。
 */
export async function damaiSelectViewers(
  deviceId: string,
  viewerNames: readonly string[],
  { timeout = 4.0 }: { timeout?: number } = {},
): Promise<UIElement[]> {
  const deadline = nowSec() + timeout;
  let lastErr: unknown = null;
  let clicked: UIElement[] = [];
  while (nowSec() < deadline) {
    let elements: UIElement[];
    try {
      elements = await dumpUi(deviceId);
    } catch (exc) {
      lastErr = exc;
      await sleep(300);
      continue;
    }

    clicked = [];
    for (const name of viewerNames) {
      // 按可见名字查找（可能被换行包裹）
      const target =
        elements.find((e) => e.visible && isInViewerNameList(e.text, [name])) ?? null;
      if (target === null) {
        continue;
      }
      // 直接点击该元素（大麦把名字行做成可点击）
      await tap(deviceId, ...target.center);
      clicked.push(target);
      await waitMs(150);
    }
    if (clicked.length === viewerNames.length) {
      return clicked;
    }
    await sleep(300);
  }

  // Python f-string 对 None 渲染为 "None"，此处保持一致
  const lastErrText = lastErr === null ? "None" : excToStr(lastErr);
  throw new DamaiGrabFailedError(
    `选观演人超时（${formatPyFloat(timeout)}s）: 已点 ${clicked.length}/${viewerNames.length}，最后错误: ${lastErrText}`,
  );
}

// ---- 5. 确认 + 支付 -------------------------------------------------------------

/**
 * 点击「确认订单」按钮。返回被点击的元素。
 */
export async function damaiConfirmOrder(
  deviceId: string,
  {
    selectors = null,
    timeout = 5.0,
  }: { selectors?: DamaiSelectors | null; timeout?: number } = {},
): Promise<UIElement> {
  const sel = selectors ?? new DamaiSelectors();
  const btn = await waitForElement(deviceId, `text=${sel.confirmButton}`, { timeout });
  await tap(deviceId, ...btn.center);
  return btn;
}

/**
 * 点击「立即支付」——返回被点击的元素。调用方必须在 APP 内完成支付。
 */
export async function damaiPay(
  deviceId: string,
  {
    selectors = null,
    timeout = 5.0,
  }: { selectors?: DamaiSelectors | null; timeout?: number } = {},
): Promise<UIElement> {
  const sel = selectors ?? new DamaiSelectors();
  const btn = await waitForElement(deviceId, `text=${sel.payButton}`, { timeout });
  await tap(deviceId, ...btn.center);
  return btn;
}

// ---- 6. 一站式抢票 --------------------------------------------------------------

/** {@link damaiGrab} 的关键字参数（对应 Python 版 keyword-only 参数）。 */
export interface DamaiGrabOptions {
  /** 选择器集合；缺省用默认 {@link DamaiSelectors}。 */
  selectors?: DamaiSelectors | null;
  /** 开票前多少秒开始预热。默认 30.0。 */
  preheatSeconds?: number;
  /** 整个流程最大耗时（秒）。默认 600.0。 */
  maxRuntimeSec?: number;
  /** 等待期间重新 dump 的轮询间隔（毫秒）。默认 150。 */
  pollIntervalMs?: number;
  /**
   * 是否在选完票档/观演人后自动提交订单。**默认 false**——
   * 只有用户明确选择提交时才传 true；支付永远不会被自动点击。
   */
  confirmOrder?: boolean;
}

/**
 * 准备一张订单并在敏感用户动作前停下。
 *
 * 默认流程在票档与观演人选择完成后即停止，让用户检查订单并完成可能需要的
 * 安全验证。仅在用户明确选择提交订单时传 `confirmOrder: true`。
 * 支付不在本自动化流程之内，必须由用户在 APP 内完成。
 *
 * 与 Python 原版一致：`maxRuntimeSec` / `ticketNum` 参数为 API 对等保留，
 * 函数体内未实现对应的硬停止 / 张数逻辑。
 *
 * @returns {@link GrabResult}（status: "ready_for_human" | "submitted" | "failed"）
 */
export async function damaiGrab(
  deviceId: string,
  itemId: string,
  priceIndex = 1,
  viewerNames: string[] | null = null,
  ticketNum = 1,
  openTime = "",
  // maxRuntimeSec / ticketNum 与 Python 原版一样在函数体内未被使用
  //（字段仍在 {@link DamaiGrabOptions} 中，为 API 对等保留）。
  {
    selectors = null,
    preheatSeconds = 30.0,
    pollIntervalMs = 150,
    confirmOrder = false,
  }: DamaiGrabOptions = {},
): Promise<GrabResult> {
  const sel = selectors ?? new DamaiSelectors();
  const viewers = viewerNames ?? [];
  const tStart = nowSec();

  const shotsDirPath = shotsDir();
  const logPaths: string[] = [];

  try {
    // 1. 校验登录
    const login = await damaiLoginCheck(deviceId);
    if (!login.logged_in) {
      throw new DamaiLoginExpiredError("大麦未登录，请先在大麦 APP 里扫码登录。");
    }

    // 2. 打开演唱会详情页
    const openRes = await damaiOpenConcert(deviceId, itemId, { selectors: sel });
    if (!openRes.loaded) {
      const shot = join(shotsDirPath, `open_fail_${truncSec()}.png`);
      await screenshot(deviceId, shot);
      logPaths.push(shot);
      throw new DamaiGrabFailedError(
        `详情页加载失败（${openRes.elapsed_ms}ms），截图: ${shot}`,
      );
    }

    // 3. 计算目标时刻（open_time 按本地时区解析）
    const targetTs = openTime ? parseIso(openTime).getTime() / 1000 : nowSec();

    // 4. 预热 —— 由 damai_open_concert 完成（已在详情页）。
    //    preheat > 0 时等到 target_ts - preheat_seconds 再点购买按钮。
    const preheatUntil = Math.max(targetTs - preheatSeconds, nowSec());
    if (preheatUntil > nowSec()) {
      await waitUntil(preheatUntil, { pollMs: pollIntervalMs });
      logger.info(`预热完成，等待开票: ${(targetTs - nowSec()).toFixed(1)}s`);
    }

    // 5. 等开票
    if (nowSec() < targetTs) {
      await waitUntil(targetTs, { pollMs: pollIntervalMs });
      logger.info(`⏰ 开票！开始抢票 (${pyListRepr(viewers)}, 票档 #${priceIndex})`);
    }

    // 6. 点购买按钮（尝试所有已知文案变体）
    let buyBtn: UIElement | null = null;
    for (const label of [
      sel.detailBuyButton,
      sel.detailBuyButtonAlt,
      sel.detailBuyButtonAlt2,
    ]) {
      try {
        buyBtn = await waitForElement(deviceId, `text=${label}`, { timeout: 1.5 });
        break;
      } catch (exc) {
        if (exc instanceof UIElementNotFoundError) {
          continue;
        }
        throw exc;
      }
    }
    if (buyBtn === null) {
      const shot = join(shotsDirPath, `no_buy_btn_${truncSec()}.png`);
      await screenshot(deviceId, shot);
      logPaths.push(shot);
      throw new DamaiGrabFailedError(`找不到立即购买按钮，截图: ${shot}`);
    }
    await tap(deviceId, ...buyBtn.center);

    // 7. 选票档
    await damaiSelectPrice(deviceId, priceIndex, { selectors: sel });

    // 8. 选观演人
    if (viewers.length > 0) {
      await damaiSelectViewers(deviceId, viewers);
    }

    if (!confirmOrder) {
      const shot = join(shotsDirPath, `ready_for_human_${truncSec()}.png`);
      await screenshot(deviceId, shot);
      logPaths.push(shot);
      const elapsed = Math.trunc((nowSec() - tStart) * 1000);
      return {
        status: "ready_for_human",
        elapsed_ms: elapsed,
        item_id: itemId,
        price_index: priceIndex,
        viewer_names: viewers,
        requires_human_confirmation: true,
        payment_started: false,
        screenshots: logPaths,
        error: null,
      };
    }

    // 只有调用方显式选择提交时才会走到这里。支付仍在本自动化流程之外，
    // 必须由用户完成。
    await damaiConfirmOrder(deviceId, { selectors: sel });
    const submittedShot = join(shotsDirPath, `order_submitted_${truncSec()}.png`);
    await screenshot(deviceId, submittedShot);
    logPaths.push(submittedShot);

    const elapsed = Math.trunc((nowSec() - tStart) * 1000);
    return {
      status: "submitted",
      elapsed_ms: elapsed,
      item_id: itemId,
      price_index: priceIndex,
      viewer_names: viewers,
      requires_human_confirmation: false,
      payment_started: false,
      screenshots: logPaths,
      error: null,
    };
  } catch (exc) {
    if (exc instanceof DamaiGrabFailedError || exc instanceof DamaiLoginExpiredError) {
      const elapsed = Math.trunc((nowSec() - tStart) * 1000);
      const shot = join(shotsDirPath, `grab_fail_${truncSec()}.png`);
      try {
        await screenshot(deviceId, shot);
        logPaths.push(shot);
      } catch {
        // 尽力而为：截图失败不影响失败结果的返回
      }
      return {
        status: "failed",
        elapsed_ms: elapsed,
        screenshots: logPaths,
        error: excToStr(exc),
      };
    }
    throw exc;
  }
}
