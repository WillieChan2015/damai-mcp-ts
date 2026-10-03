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
import { recognizeTextBoxes } from "../inspector/visionOcr";
import {
  AppNotRunningError,
  DamaiGrabFailedError,
  DamaiLoginExpiredError,
  UIElementNotFoundError,
} from "../utils/errors";
import { parseBeijingDateTime } from "../utils/beijingTime";
import { logger } from "../utils/logging";
import {
  isPriceHeading,
  applyOcrLabels,
  listPriceCards,
  listSessionCards,
  normalizeSheetLabel,
  parsePurchaseSheet,
  PRICE_CARD_TEXT,
  priceListReady,
  sheetHasChoice,
  sessionCardsAwaitingPrices,
  sheetHeadingsReady,
  unlabeledSheetCards,
  type PurchasePriceOption,
  type PurchaseSheetOptions,
} from "./purchaseSheet";
import { DamaiSelectors } from "./selectors";
import { NOT_ON_SALE_CTA_WORDS } from "./cta";

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

/** 官方订单列表页（人工核对入口；needs_action / submitted 时随结果返回）。 */
export const DAMAI_ORDERS_URL = "https://orders.damai.cn/orderList";

/**
 * needs_action 状态的固定中文提示（逐字固定，便于上层按前缀识别）。
 *
 * 语义同构于 tickets 的 `Outcome::action("订单请求结果未确认，请先检查官方
 * 订单页，避免重复下单", ORDERS)`：提交订单的点击是否送达设备未知时，
 * 结果既不是成功也不是失败——用户必须先核对官方订单页，再决定是否重跑，
 * 否则会重复下单。
 */
export const NEEDS_ACTION_MESSAGE = "订单请求结果未确认，请先检查官方订单页，避免重复下单";

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
  /** 详情页是否加载完成（购买入口可用：CTA 文案命中或购买弹层已打开）。 */
  loaded: boolean;
  /** 打开耗时（毫秒）。 */
  elapsed_ms: number;
  /** 入口状态（additive）：buyable=CTA 文案命中；sheet_open=购买弹层已打开；unknown=无信号。 */
  state?: "buyable" | "sheet_open" | "unknown";
  /** 命中证据（CTA 文案或固定说明）；unknown 时为 null。 */
  evidence?: string | null;
};

/** {@link damaiGrab} 的返回结构。`failed` 分支只含基础四键。 */
export type GrabResult = {
  /**
   * "ready_for_human"（等人工确认）| "submitted"（已提交订单）|
   * "needs_action"（订单请求结果未确认——先查官方订单页，切勿直接重跑）|
   * "needs_human_captcha"（滑块验证拦截，订单未提交——人工过验后重跑）|
   * "failed"。
   */
  status:
    | "ready_for_human"
    | "submitted"
    | "needs_action"
    | "needs_human_captcha"
    | "cancelled"
    | "failed";
  /** 从流程开始到结束的耗时（毫秒）。 */
  elapsed_ms: number;
  item_id?: string;
  price_index?: number;
  /** 实际点中的场次卡片文字。没点场次时省略。 */
  session_label?: string;
  /** 实际点中的票档卡片文字。 */
  price_label?: string;
  viewer_names?: string[];
  /** 是否停在等待人工确认的状态。 */
  requires_human_confirmation?: boolean;
  /** 是否已触碰支付流程（恒为 false——支付永远不自动点击）。 */
  payment_started?: boolean;
  /** 官方订单页 URL；submitted 与 needs_action 时携带，其余省略。 */
  order_url?: string;
  /** 调试截图路径列表。 */
  screenshots: string[];
  /** 失败原因；成功为 null。 */
  error: string | null;
  /** 本次抢票实际执行的尝试轮数（含首轮）；重试泵关闭（maxGrabAttempts=1）时恒为 1。 */
  attempts?: number;
  /** 终局失败/拦截分类；failed 与 needs_human_captcha 结果上可能出现，其余省略。 */
  errorCategory?: GrabErrorCategory;
  /** 仅 submitted：是否已看到订单/收银台页证据（见 {@link DamaiGrabOptions.verifyOrder}）。 */
  order_seen?: boolean;
};

// ---- 抢票阻断分类（纯函数，可单测） ---------------------------------------------
//
// App 端没有 tickets 的 errno 字段，终局/可重试的判定用「页面文案词表」代替
// （对应 deep-compare §7.3 项 6）。词表挂在 {@link DamaiSelectors} 上，与
// monitor 的余票词表互相独立（监控语义 ≠ 抢票语义，避免反向耦合）。

/** {@link classifyGrabBlocker} 的分类；无命中时 kind 为 null。 */
export type GrabBlockerKind =
  | "crowd"
  | "sold_out"
  | "restricted"
  | "captcha"
  | "session"
  | null;

/** {@link GrabResult.errorCategory} 的枚举（非 null 的 {@link GrabBlockerKind}）。 */
export type GrabErrorCategory = Exclude<GrabBlockerKind, null>;

/** 一次阻断命中的结果：分类 + 命中的词。 */
export interface GrabBlocker {
  kind: GrabBlockerKind;
  /** 命中的文案词；无命中为空串。 */
  word: string;
}

/** 子串包含匹配（实现风格同 monitor 的判定纯函数；词表独立，不从 monitor import）。 */
function grabElementMentionsWord(el: UIElement, word: string): boolean {
  return (
    (el.text !== "" && el.text.includes(word)) ||
    (el.contentDesc !== "" && el.contentDesc.includes(word))
  );
}

/** 在可见元素的 text / content-desc 里按词表顺序找第一个命中的词；无命中返回 null。 */
function grabFirstMentionedWord(
  elements: readonly UIElement[],
  words: readonly string[],
): string | null {
  for (const word of words) {
    for (const el of elements) {
      if (el.visible && grabElementMentionsWord(el, word)) {
        return word;
      }
    }
  }
  return null;
}

/**
 * 把 UI dump 的元素列表分类为抢票阻断类型（纯函数，可直接单测）。
 *
 * 扫描可见元素的 `text` / `content-desc`，优先级从高到低：
 * captcha（滑块验证）> session（登录失效）> sold_out（售罄）>
 * restricted（限购/实名）> crowd（瞬时拥塞，可重试）。
 * 全部未命中时返回 `{ kind: null, word: "" }`。
 */
export function classifyGrabBlocker(
  elements: readonly UIElement[],
  sel: DamaiSelectors,
): GrabBlocker {
  const captcha = grabFirstMentionedWord(elements, [sel.captchaIndicator]);
  if (captcha !== null) {
    return { kind: "captcha", word: captcha };
  }
  const session = grabFirstMentionedWord(elements, sel.sessionExpiredWords);
  if (session !== null) {
    return { kind: "session", word: session };
  }
  const soldOut = grabFirstMentionedWord(elements, sel.soldOutWords);
  if (soldOut !== null) {
    return { kind: "sold_out", word: soldOut };
  }
  const restricted = grabFirstMentionedWord(elements, sel.restrictedWords);
  if (restricted !== null) {
    return { kind: "restricted", word: restricted };
  }
  const crowd = grabFirstMentionedWord(elements, sel.crowdPopupWords);
  if (crowd !== null) {
    return { kind: "crowd", word: crowd };
  }
  return { kind: null, word: "" };
}

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
    // 末段（<200ms）一次睡满剩余时间；node timers/promises 对小数毫秒向零
    // 截断，可能提前 <1ms 醒来，因此睡完回环复查，确保到点才返回。
    if (remaining < 0.2) {
      await sleep(Math.max(remaining, 0) * 1000);
      continue;
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
 * 深链链（本机实测：ProjectDetailActivity 注册的 authority 是
 * detail / projectdetail / trade/detail，`damai://item` 解析失败——
 * 但旧版本可能仍路由它，故保留在链尾）；web URL 只作最后兜底
 * （部分设备会落系统浏览器而非 app 内）。
 *
 * 加载判定：购买 CTA 文案变体（预售态 CTA 为「立即预订」，只等「立即购买」
 * 会把可购票页误判成加载失败）→ 购买弹层谓词 → SKU 弹层 Activity 在前台。
 *
 * @returns {@link OpenConcertResult}
 */
export async function damaiOpenConcert(
  deviceId: string,
  itemId: string,
  {
    selectors = null,
    buyButtonTimeout = 8.0,
    settleMs = 1500,
  }: { selectors?: DamaiSelectors | null; buyButtonTimeout?: number; settleMs?: number } = {},
): Promise<OpenConcertResult> {
  const t0 = nowSec();
  const sel = selectors ?? new DamaiSelectors();
  for (const link of [`damai://detail?id=${itemId}`, `damai://item?id=${itemId}`]) {
    await shell(
      "am", "start", "-W", "-a", "android.intent.action.VIEW",
      "-d", link,
      { deviceId, check: false, timeout: 10 },
    );
    await waitMs(settleMs);
    if (await isDamaiForeground(deviceId)) {
      break;
    }
  }
  if (!(await isDamaiForeground(deviceId))) {
    for (const url of [
      `https://m.damai.cn/damai/perform/item.html?itemId=${itemId}`,
      `https://m.damai.cn/shows/item.html?itemId=${itemId}`,
    ]) {
      await shell(
        "am", "start", "-W", "-a", "android.intent.action.VIEW",
        "-d", url,
        { deviceId, check: false, timeout: 10 },
      );
      await waitMs(2000);
      if (await isDamaiForeground(deviceId)) {
        break;
      }
    }
  }
  let state: "buyable" | "sheet_open" | "unknown" = "unknown";
  let evidence: string | null = null;
  if (buyButtonTimeout > 0) {
    const btn = await findBuyButtonByVariants(deviceId, sel, Math.max(buyButtonTimeout / 3, 1.5));
    if (btn !== null) {
      state = "buyable";
      evidence = btn.text.trim();
    } else {
      const elements = await dumpUi(deviceId);
      if (
        sheetHeadingsReady(elements) ||
        priceListReady(elements) ||
        sessionCardsAwaitingPrices(elements).length > 0
      ) {
        state = "sheet_open";
        evidence = "购买弹层已打开";
      } else if (await isSkuSheetForeground(deviceId)) {
        state = "sheet_open";
        evidence = "SKU 购买弹层 Activity 在前台";
      } else {
        // CTA 子树不进无障碍树的版本（本机实测）：OCR 读底部条是唯一可靠读法。
        // not_buyable 时不置 loaded——上层报错会带上可见的 CTA 文案。
        const cta = await readBottomCta(deviceId, sel);
        if (cta.kind === "buyable") {
          state = "buyable";
          evidence = `${cta.label}（OCR）`;
        } else if (cta.kind === "not_buyable") {
          evidence = `CTA 为「${cta.label}」，当前不可购`;
        }
      }
    }
  }
  return {
    item_id: itemId,
    loaded: state !== "unknown",
    elapsed_ms: Math.trunc((nowSec() - t0) * 1000),
    state,
    evidence,
  };
}

// ---- 3. 选场次 / 选票档 --------------------------------------------------------

const SHEET_POLL_MS = 200;
/** 读取弹层时最多再 dump 几次。按 200ms 折算会连着 dump 二十次，无线调试上要一两分钟。 */
const READ_SHEET_DUMPS = 4;

/**
 * 在 timeout 秒内反复 dump，直到 ready 成立。
 * 间隔走 {@link waitMs}，测试里可以把它打成立即返回。
 */
async function dumpUntilReady(
  deviceId: string,
  timeout: number,
  ready: (elements: readonly UIElement[]) => boolean,
  maxAttempts?: number,
): Promise<UIElement[]> {
  const attempts = maxAttempts ?? Math.max(1, Math.ceil((timeout * 1000) / SHEET_POLL_MS));
  let last: UIElement[] = [];
  for (let i = 0; i < attempts; i += 1) {
    last = await dumpUi(deviceId, { compressed: false });
    if (ready(last)) {
      return last;
    }
    if (i + 1 < attempts) {
      await waitMs(SHEET_POLL_MS);
    }
  }
  return last;
}

/** 标题已经在，并且至少有一张可点卡片。正文可以还在截图里。 */
function sheetBodiesReady(elements: readonly UIElement[]): boolean {
  return sheetHeadingsReady(elements) && unlabeledSheetCards(elements).length > 0;
}

async function withCardText(deviceId: string, elements: UIElement[]): Promise<UIElement[]> {
  const needSessions = sheetHeadingsReady(elements) && listSessionCards(elements).length === 0;
  const needPrices = sheetHeadingsReady(elements) && !priceListReady(elements);
  if (!needSessions && !needPrices) {
    return elements;
  }
  const png = await screenshot(deviceId);
  if (!Buffer.isBuffer(png)) {
    throw new DamaiGrabFailedError("截图识别场次和票档失败: 截图不是图片数据");
  }
  let boxes;
  try {
    boxes = await recognizeTextBoxes(png);
  } catch (exc) {
    const stderr =
      exc !== null && typeof exc === "object" && "stderr" in exc ? String(exc.stderr ?? "") : "";
    const message = exc instanceof Error ? exc.message : String(exc);
    const detail = stderr.trim() === "" ? message : `${message}: ${stderr.trim()}`;
    throw new DamaiGrabFailedError(`截图识别场次和票档失败: ${detail}`);
  }
  const labeled = applyOcrLabels(elements, boxes);
  if (needPrices && !priceListReady(labeled)) {
    const sample = boxes
      .map((box) => box.text.trim())
      .filter((text) => text !== "")
      .slice(0, 6)
      .join("、");
    throw new DamaiGrabFailedError(
      `场次和票档标题已出现，但没有读出价格卡片（可点卡片 ${unlabeledSheetCards(elements).length}，识别 ${boxes.length} 行${sample === "" ? "" : `：${sample}`}）`,
    );
  }
  return labeled;
}

async function loadSheetElements(
  deviceId: string,
  timeout: number,
  ready: (elements: readonly UIElement[]) => boolean,
): Promise<UIElement[]> {
  const dumped = await dumpUntilReady(
    deviceId,
    timeout,
    (nodes) => ready(nodes) || sheetBodiesReady(nodes),
  );
  return withCardText(deviceId, dumped);
}

function joinedLabels(elements: readonly UIElement[]): string {
  return elements.map((element) => element.text.trim()).join("、");
}

/**
 * 票档卡片与解析选项按序配对（{@link parsePurchaseSheet} 内部同样按
 * {@link listPriceCards} 的顺序产出 prices）。option.label 为归一化正文——
 * 角标与正文同节点（"看台588元缺货登记"）与独立角标节点（"看台588元" +
 * 重叠角标）两种形态都能按用户配置的纯文本档位名命中。
 */
function zipPriceOptions(
  elements: readonly UIElement[],
): Array<{ card: UIElement; option: PurchasePriceOption }> {
  const cards = listPriceCards(elements);
  const prices = parsePurchaseSheet(elements).prices;
  const paired = Math.min(cards.length, prices.length);
  const zipped: Array<{ card: UIElement; option: PurchasePriceOption }> = [];
  for (let i = 0; i < paired; i += 1) {
    const card = cards[i];
    const option = prices[i];
    if (card !== undefined && option !== undefined) {
      zipped.push({ card, option });
    }
  }
  return zipped;
}

/**
 * 点购买弹层里的一场。
 *
 * `sessionLabel` 非空时按卡片全文点，点不中不退回序号。
 * 标签为空且没有日期卡片时：序号 1 跳过；更大的序号直接失败。
 *
 * @returns 点中的卡片。跳过时为 null。
 */
export async function damaiSelectSession(
  deviceId: string,
  sessionIndex = 1,
  {
    sessionLabel = "",
    timeout = 4.0,
  }: { sessionLabel?: string; timeout?: number } = {},
): Promise<UIElement | null> {
  const label = sessionLabel.trim();
  const wanted = normalizeSheetLabel(label);
  const elements = await loadSheetElements(deviceId, timeout, (nodes) => {
    if (wanted !== "") {
      return (
        listSessionCards(nodes).some((card) => normalizeSheetLabel(card.text.trim()) === wanted) ||
        sheetHasChoice(nodes)
      );
    }
    return sheetHasChoice(nodes);
  });
  const cards = listSessionCards(elements);
  if (wanted !== "") {
    // 归一化比对：场次卡片行尾可能拼着「预售」角标（同节点形态）
    const target = cards.find((card) => normalizeSheetLabel(card.text.trim()) === wanted);
    if (target === undefined) {
      if (!sheetHasChoice(elements)) {
        throw new DamaiGrabFailedError(`价格表未弹出: 未找到场次「${label}」`);
      }
      const available = joinedLabels(cards);
      throw new DamaiGrabFailedError(
        available === "" ? `未找到场次「${label}」` : `未找到场次「${label}」，当前有: ${available}`,
      );
    }
    return tapChoice(deviceId, target, "场次");
  }
  if (cards.length === 0) {
    if (sessionIndex === 1) {
      return null;
    }
    if (!sheetHasChoice(elements)) {
      throw new DamaiGrabFailedError("价格表未弹出: 未找到场次卡片");
    }
    throw new DamaiGrabFailedError(`session_index=${sessionIndex} 超出范围 (1..0)`);
  }
  if (sessionIndex < 1 || sessionIndex > cards.length) {
    throw new DamaiGrabFailedError(
      `session_index=${sessionIndex} 超出范围 (1..${cards.length}): ${joinedLabels(cards)}`,
    );
  }
  const target = cards[sessionIndex - 1];
  if (target === undefined) {
    throw new DamaiGrabFailedError(`session_index=${sessionIndex} 超出范围 (1..${cards.length})`);
  }
  return tapChoice(deviceId, target, "场次");
}

/** 已经选中的卡片不再点。预约页上再点一次会取消心形选中。 */
async function tapChoice(deviceId: string, target: UIElement, kind: string): Promise<UIElement> {
  const label = target.text.trim();
  if (target.selected) {
    logger.info(`${kind}「${label}」已选中，不再点击`);
    return target;
  }
  logger.info(`点中${kind}「${label}」`);
  await tap(deviceId, ...target.center);
  await waitMs(400);
  return target;
}

/**
 * 从购买弹层里点一个票档。
 *
 * 优先认「看台488元」这种卡片。没有这类卡片、也没有「票档」标题时，
 * 才退回整段 `¥数字`。`priceLabel` 非空时按全文点，点不中不退回序号。
 *
 * `selectors` 保留是为了和旧调用签名兼容，定位不使用它。
 *
 * @returns 命中的票档元素（已点击）。
 * @throws {@link DamaiGrabFailedError} 价格表未弹出 / 没有价格元素 / 序号或文字对不上。
 */
export async function damaiSelectPrice(
  deviceId: string,
  priceIndex: number,
  {
    selectors = null,
    timeout = 4.0,
    priceLabel = "",
  }: { selectors?: DamaiSelectors | null; timeout?: number; priceLabel?: string } = {},
): Promise<UIElement> {
  void selectors;
  const label = priceLabel.trim();
  const wanted = normalizeSheetLabel(label);
  const elements = await loadSheetElements(deviceId, timeout, (nodes) => {
    const cards = listPriceCards(nodes);
    if (wanted !== "") {
      return cards.some((card) => normalizeSheetLabel(card.text.trim()) === wanted);
    }
    return cards.length > 0;
  });
  const priceEls = listPriceCards(elements);
  if (priceEls.length === 0) {
    const sawNewCard = elements.some(
      (element) =>
        element.visible &&
        (isPriceHeading(element.text.trim()) || PRICE_CARD_TEXT.test(element.text.trim())),
    );
    const detail = sawNewCard ? "未找到价格卡片" : "未找到任何 ¥xxx 价格元素";
    throw new DamaiGrabFailedError(`价格表未弹出: ${detail}`);
  }
  const labels = joinedLabels(priceEls);
  const zipped = zipPriceOptions(elements);
  let target: UIElement | undefined;
  if (wanted !== "") {
    const entry = zipped.find((item) => item.option.label === wanted);
    if (entry === undefined) {
      throw new DamaiGrabFailedError(`未找到票档「${label}」，当前有: ${labels}`);
    }
    // 缺货登记/可预约卡片绝不点击：点击进入的是登记/预约流程而非购票
    if (entry.option.soldOut) {
      throw new DamaiGrabFailedError(
        `票档「${entry.option.label}」当前缺货或需预约（缺货登记/可预约角标），未点击`,
      );
    }
    target = entry.card;
  } else if (priceIndex < 1 || priceIndex > priceEls.length) {
    throw new DamaiGrabFailedError(
      `price_index=${priceIndex} 超出范围 (1..${priceEls.length}): ${labels}`,
    );
  } else {
    const entry = zipped[priceIndex - 1];
    if (entry === undefined) {
      throw new DamaiGrabFailedError(`price_index=${priceIndex} 超出范围 (1..${priceEls.length})`);
    }
    if (entry.option.soldOut) {
      throw new DamaiGrabFailedError(
        `票档「${entry.option.label}」当前缺货或需预约（缺货登记/可预约角标），未点击`,
      );
    }
    target = entry.card;
  }
  return tapChoice(deviceId, target, "票档");
}

/** 购票张数上限（与 Web schema 一致）。 */
export const MAX_TICKET_NUM = 6;
/** 备选档位上限，不含主档。 */
export const MAX_PRICE_FALLBACKS = 5;
/** 列表里每一档都缺货时的错误前缀。抢票泵据此停重试。 */
export const PRICE_FALLBACKS_SOLD_OUT = "备选档位均已缺货";

/** 主档在前，备选按给定顺序跟在后面。空串和重复项丢掉。 */
export function orderedPriceLabels(primary: string, fallbacks: readonly string[] = []): string[] {
  const labels: string[] = [];
  const first = primary.trim();
  if (first !== "") {
    labels.push(first);
  }
  for (const raw of fallbacks) {
    const label = raw.trim();
    if (label === "" || labels.includes(label)) {
      continue;
    }
    labels.push(label);
  }
  return labels;
}

function visibleName(element: UIElement): string {
  const text = element.text.trim();
  return text !== "" ? text : element.contentDesc.trim();
}

function onSameRow(anchor: UIElement, element: UIElement): boolean {
  const mid = (element.bounds[1] + element.bounds[3]) / 2;
  return mid >= anchor.bounds[1] - 12 && mid <= anchor.bounds[3] + 12;
}

/** 在购买弹层里定位「数量」行、增加按钮和当前数字。 */
export function locateTicketStepper(
  elements: readonly UIElement[],
  selectors: DamaiSelectors = new DamaiSelectors(),
): { label: UIElement | null; increase: UIElement | null; count: number | null } {
  const label =
    elements.find((element) => element.visible && visibleName(element) === selectors.ticketCountLabel) ??
    null;
  if (label === null) {
    return { label: null, increase: null, count: null };
  }
  const increase =
    elements
      .filter((element) => {
        if (!element.visible || !onSameRow(label, element)) {
          return false;
        }
        return (
          selectors.ticketIncreaseTexts.includes(visibleName(element)) &&
          element.center[0] > label.bounds[2]
        );
      })
      .sort((a, b) => a.center[0] - b.center[0])[0] ?? null;
  const countElement = elements
    .filter((element) => {
      if (!element.visible || !onSameRow(label, element) || !/^\d+$/.test(element.text.trim())) {
        return false;
      }
      const x = element.center[0];
      if (x <= label.bounds[2]) {
        return false;
      }
      if (increase !== null && x >= increase.bounds[0]) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.center[0] - b.center[0])[0];
  return {
    label,
    increase,
    count: countElement === undefined ? null : Number(countElement.text.trim()),
  };
}

/**
 * 把购买弹层的张数点到 `ticketNum`。1 张不点。
 * 点完再读回数字，对不上就失败，不用坐标猜按钮。
 */
export async function damaiSelectTicketCount(
  deviceId: string,
  ticketNum: number,
  {
    selectors = null,
  }: { selectors?: DamaiSelectors | null } = {},
): Promise<number> {
  if (ticketNum === 1) {
    return 1;
  }
  const sel = selectors ?? new DamaiSelectors();
  let elements = await dumpUi(deviceId);
  let stepper = locateTicketStepper(elements, sel);
  if (stepper.increase === null) {
    throw new DamaiGrabFailedError("未找到购票数量增加按钮");
  }
  for (let step = 1; step < ticketNum; step += 1) {
    await tap(deviceId, ...stepper.increase.center);
    await waitMs(150);
    elements = await dumpUi(deviceId);
    stepper = locateTicketStepper(elements, sel);
    if (stepper.increase === null) {
      throw new DamaiGrabFailedError("未找到购票数量增加按钮");
    }
  }
  if (stepper.count !== ticketNum) {
    throw new DamaiGrabFailedError(
      `购票张数读回为 ${stepper.count === null ? "未知" : String(stepper.count)}，期望 ${ticketNum}`,
    );
  }
  return stepper.count;
}

/**
 * 按主档、备选的顺序点第一张未缺货的票档。
 * 没有文字档时退回 {@link damaiSelectPrice} 的序号。
 */
export async function damaiSelectPriceByPriority(
  deviceId: string,
  priceIndex: number,
  {
    selectors = null,
    timeout = 4.0,
    priceLabel = "",
    priceFallbacks = [],
  }: {
    selectors?: DamaiSelectors | null;
    timeout?: number;
    priceLabel?: string;
    priceFallbacks?: readonly string[];
  } = {},
): Promise<UIElement> {
  const wanted = orderedPriceLabels(priceLabel, priceFallbacks);
  if (wanted.length === 0) {
    return damaiSelectPrice(deviceId, priceIndex, { selectors, timeout, priceLabel: "" });
  }
  const elements = await loadSheetElements(deviceId, timeout, (nodes) => listPriceCards(nodes).length > 0);
  const cards = listPriceCards(elements);
  if (cards.length === 0) {
    const sawNewCard = elements.some(
      (element) =>
        element.visible &&
        (isPriceHeading(element.text.trim()) || PRICE_CARD_TEXT.test(element.text.trim())),
    );
    const detail = sawNewCard ? "未找到价格卡片" : "未找到任何 ¥xxx 价格元素";
    throw new DamaiGrabFailedError(`价格表未弹出: ${detail}`);
  }
  const zipped = zipPriceOptions(elements);
  const byLabel = new Map(zipped.map((item) => [item.option.label, item]));
  for (const label of wanted) {
    const entry = byLabel.get(label);
    if (entry === undefined || entry.option.soldOut) {
      continue;
    }
    return tapChoice(deviceId, entry.card, "票档");
  }
  const present = wanted.filter((label) => byLabel.has(label));
  if (present.length > 0 && present.every((label) => byLabel.get(label)?.option.soldOut === true)) {
    throw new DamaiGrabFailedError(`${PRICE_FALLBACKS_SOLD_OUT}：${wanted.join("、")}`);
  }
  throw new DamaiGrabFailedError(
    `未找到可用票档（${wanted.join("、")}），当前有: ${joinedLabels(cards)}`,
  );
}

/** 详情页上打开预约列表的按钮。不包含弹层里的「可预约」「已预约」。 */
const RESERVE_ENTRY_TEXTS = ["去预约", "提前预约", "预约抢票"] as const;
/**
 * 详情页底部购票条。已预约、立即购买都画在这个容器里，文字经常不进无障碍树。
 */
const PURCHASE_BAR_ID = "cn.damai:id/trade_project_detail_purchase_status_bar_container_fl";

/**
 * SKU 购买弹层 Activity 特征串（dumpsys window 命中即视为弹层已打开）。
 * 本机实测：弹层是独立 Activity 且无 VIEW filter——无法深链进入，只能点击；
 * dumpsys 检测比 a11y 谓词更可靠（不受弹层渲染进度影响）。
 */
export const DAMAI_SKU_ACTIVITY_MARKER =
  "commonbusiness.seatbiz.sku.qilin.ui.NcovSkuActivity";

/** 购买弹层（NcovSkuActivity）是否在前台。 */
export async function isSkuSheetForeground(deviceId: string): Promise<boolean> {
  const out = await shell("dumpsys", "window", "windows", {
    deviceId,
    timeout: 5,
    check: false,
  });
  return out.includes(DAMAI_SKU_ACTIVITY_MARKER);
}

/** 依次尝试三个购买 CTA 文案变体（立即购买 / 立即预订 / 选座购买）；命中返回元素。 */
async function findBuyButtonByVariants(
  deviceId: string,
  sel: DamaiSelectors,
  perVariantTimeout: number,
): Promise<UIElement | null> {
  for (const label of [sel.detailBuyButton, sel.detailBuyButtonAlt, sel.detailBuyButtonAlt2]) {
    try {
      return await waitForElement(deviceId, `text=${label}`, { timeout: perVariantTimeout });
    } catch (exc) {
      if (exc instanceof UIElementNotFoundError) {
        continue;
      }
      throw exc;
    }
  }
  return null;
}

/** 解析 PNG IHDR 的宽高（bytes 16-23）；非 PNG / 截断返回 null。 */
function pngSize(png: Buffer): { w: number; h: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
    return null;
  }
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/** {@link readBottomCta} 的结果：可购（带点击坐标）/ 不可购（带文案）/ 读不出。 */
export type BottomCta =
  | { kind: "buyable"; label: string; center: [number, number] }
  | { kind: "not_buyable"; label: string }
  | { kind: "unreadable" };

/**
 * OCR 读取底部购买条 CTA 文案。
 *
 * 本机实测：详情页底部 CTA 整个子树不进无障碍树（文本与容器 rid 均稳定缺失，
 * 标准 uiautomator dump 又因页面 idle 不收敛不可用）——文本/rid 都找不到时，
 * 这是判断 CTA 是否可购的唯一可靠读法。只在屏幕底部带内做**全等**文案匹配：
 * 页面中部（巡演城市「预约」角标等）的字样绝不参与，避免误判。
 * 截图 / OCR / 解析任何一步失败都按 unreadable 处理（调用方走通用兜底）。
 */
export async function readBottomCta(deviceId: string, sel: DamaiSelectors): Promise<BottomCta> {
  try {
    const png = await screenshot(deviceId);
    if (!Buffer.isBuffer(png)) {
      return { kind: "unreadable" };
    }
    const size = pngSize(png);
    if (size === null) {
      return { kind: "unreadable" };
    }
    const boxes = (await recognizeTextBoxes(png)).filter((box) => {
      const [x1, y1, x2, y2] = box.bounds;
      return (y1 + y2) / 2 >= size.h * 0.88 && (x1 + x2) / 2 >= size.w * 0.25;
    });
    const buyableTexts = new Set([sel.detailBuyButton, sel.detailBuyButtonAlt, sel.detailBuyButtonAlt2]);
    const inBandTexts = boxes.map((box) => box.text.trim()).filter((text) => text !== "");
    const buyable = [...buyableTexts].find(
      (label) => inBandTexts.includes(label) || inBandTexts.join("") === label,
    );
    if (buyable !== undefined) {
      // 坐标取第一个带文本的 box（多行 CTA 时各 box 同属一个按钮区域）
      const box = boxes.find((item) => item.text.trim() !== "");
      if (box !== undefined) {
        const [x1, y1, x2, y2] = box.bounds;
        return { kind: "buyable", label: buyable, center: [Math.floor((x1 + x2) / 2), Math.floor((y1 + y2) / 2)] };
      }
    }
    const notBuyable = inBandTexts.find((text) =>
      NOT_ON_SALE_CTA_WORDS.some((word) => text === word),
    );
    if (notBuyable !== undefined) {
      return { kind: "not_buyable", label: notBuyable };
    }
    return { kind: "unreadable" };
  } catch (exc) {
    logger.warning(`[cta] 读取底部 CTA 失败（按 unreadable 处理）: ${excToStr(exc)}`);
    return { kind: "unreadable" };
  }
}

async function tapExactText(deviceId: string, labels: readonly string[], timeout: number): Promise<boolean> {
  for (const label of labels) {
    try {
      const button = await waitForElement(deviceId, `text=${label}`, { timeout });
      if (button.text.trim() !== label && button.contentDesc.trim() !== label) {
        continue;
      }
      await tap(deviceId, ...button.center);
      return true;
    } catch (exc) {
      if (exc instanceof UIElementNotFoundError) {
        continue;
      }
      throw exc;
    }
  }
  return false;
}

async function tapPurchaseBar(elements: readonly UIElement[], deviceId: string): Promise<boolean> {
  const bar = elements.find((element) => element.visible && element.resourceId === PURCHASE_BAR_ID);
  if (bar === undefined) {
    return false;
  }
  logger.info("点详情页底部购票条");
  await tap(deviceId, ...bar.center);
  return true;
}

async function tapDetailBuyButton(
  deviceId: string,
  sel: DamaiSelectors,
  elements: readonly UIElement[],
): Promise<void> {
  if (await tapPurchaseBar(elements, deviceId)) {
    return;
  }
  const opened = await tapExactText(
    deviceId,
    [sel.detailBuyButton, sel.detailBuyButtonAlt, sel.detailBuyButtonAlt2],
    1.5,
  );
  if (opened) {
    return;
  }
  const reserved = await tapExactText(deviceId, RESERVE_ENTRY_TEXTS, 1.5);
  if (reserved) {
    return;
  }
  const again = await dumpUi(deviceId, { compressed: false });
  if (await tapPurchaseBar(again, deviceId)) {
    return;
  }
  // CTA 子树不进无障碍树的版本（本机实测）：OCR 读底部条，确认可购才坐标点击
  const cta = await readBottomCta(deviceId, sel);
  if (cta.kind === "buyable") {
    logger.info(`OCR 读到 CTA「${cta.label}」，坐标点击打开购买弹层`);
    await tap(deviceId, ...cta.center);
    return;
  }
  if (cta.kind === "not_buyable") {
    throw new DamaiGrabFailedError(`详情页 CTA 为「${cta.label}」，当前不可购，无法读取场次与票档`);
  }
  throw new DamaiGrabFailedError("找不到立即购买或预约入口，无法读取场次与票档");
}

/**
 * 票档区要等场次被选中才渲染。没有票档标题时先点第一场。
 */
async function revealPriceSection(
  deviceId: string,
  elements: UIElement[],
  timeout: number,
): Promise<UIElement[]> {
  if (priceListReady(elements) || sheetHeadingsReady(elements)) {
    return elements;
  }
  const target = sessionCardsAwaitingPrices(elements)[0];
  if (target === undefined) {
    return elements;
  }
  logger.info("票档区未出现，先点第一场");
  await tap(deviceId, ...target.center);
  await waitMs(400);
  return dumpUntilReady(
    deviceId,
    timeout,
    (nodes) => priceListReady(nodes) || sheetHeadingsReady(nodes),
    READ_SHEET_DUMPS,
  );
}

/**
 * 打开演出详情并读出购买弹层上的场次和票档。
 * 只点购买按钮，不点「确定」。
 */
export async function damaiReadPurchaseSheet(
  deviceId: string,
  itemId: string,
  {
    selectors = null,
    timeout = 4.0,
  }: { selectors?: DamaiSelectors | null; timeout?: number } = {},
): Promise<PurchaseSheetOptions> {
  const sel = selectors ?? new DamaiSelectors();
  await damaiOpenConcert(deviceId, itemId, { selectors: sel, buyButtonTimeout: 0, settleMs: 500 });
  let elements = await dumpUi(deviceId, { compressed: false });
  if (!priceListReady(elements) && !sheetHeadingsReady(elements) && sessionCardsAwaitingPrices(elements).length === 0) {
    await tapDetailBuyButton(deviceId, sel, elements);
    elements = await dumpUntilReady(
      deviceId,
      timeout,
      (nodes) => priceListReady(nodes) || sheetBodiesReady(nodes) || sessionCardsAwaitingPrices(nodes).length > 0,
      READ_SHEET_DUMPS,
    );
  }
  elements = await revealPriceSection(deviceId, elements, timeout);
  elements = await withCardText(deviceId, elements);
  if (!priceListReady(elements)) {
    throw new DamaiGrabFailedError(
      sheetHeadingsReady(elements)
        ? "场次和票档标题已出现，但没有读出价格卡片"
        : "购买弹层里没有价格卡片",
    );
  }
  return parsePurchaseSheet(elements);
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

// ---- 重试泵内部信号 -------------------------------------------------------------
//
// 这些异常只在 damaiGrab 内部流转：外层 catch 只认 DamaiGrabFailedError /
// DamaiLoginExpiredError（转 failed 结果），泵用它们在「重试 / 终局」间分流。

/** 重试泵内部分段失败的原因码。 */
type GrabRetryableReason = "buy_button" | "price_sheet" | "viewers_timeout";

/**
 * 可重试的分段失败（泵内流转用）：分段（点购买 / 弹价格表 / 选观演人）未能完成，
 * 且订单请求必然尚未发出。是否真重试由泵结合词表分类与重试预算决定。
 */
class GrabRetryableError extends DamaiGrabFailedError {
  readonly reason: GrabRetryableReason;
  constructor(reason: GrabRetryableReason, message: string) {
    super(message);
    this.name = "GrabRetryableError";
    this.reason = reason;
  }
}

/** 带终局分类的抢票失败：外层 catch 读取 category 写入 GrabResult.errorCategory。 */
class GrabCategorizedError extends DamaiGrabFailedError {
  readonly category: GrabErrorCategory;
  constructor(category: GrabErrorCategory, message: string) {
    super(message);
    this.name = "GrabCategorizedError";
    this.category = category;
  }
}

/** {@link damaiGrab} 的关键字参数（对应 Python 版 keyword-only 参数）。 */
export interface DamaiGrabOptions {
  /** 选择器集合；缺省用默认 {@link DamaiSelectors}。 */
  selectors?: DamaiSelectors | null;
  /** 开票前多少秒开始预热。默认 30.0。 */
  preheatSeconds?: number;
  /**
   * 整个流程最大耗时（秒）的**硬停止**：deadline 贯穿预热等待、开票等待与
   * 重试循环，超限时抛 DamaiGrabFailedError（中文「已达最大运行时长」）。
   * `<= 0` 表示不启用硬停止，**默认 0**——Python 原版该参数未实现，为不改变
   * 直连调用方的等待行为而保守缺省；MCP 工具层（damai_grab）默认 600。
   */
  maxRuntimeSec?: number;
  /** 等待期间重新 dump 的轮询间隔（毫秒）。默认 150。 */
  pollIntervalMs?: number;
  /**
   * 是否在选完票档/观演人后自动提交订单。**默认 false**——
   * 只有用户明确选择提交时才传 true；支付永远不会被自动点击。
   */
  confirmOrder?: boolean;
  /**
   * 可重试失败（找不到购买按钮 / 价格表未弹出 / 选观演人超时）的最大尝试轮数
   * （含首轮）。**默认 1 = 不重试（与历史行为一致）**；> 1 时启用指数退避重试泵。
   * 终局失败（售罄/限购/登录失效/滑块验证）与 needs_action / needs_human_captcha /
   * ready_for_human / submitted 绝不重试——尤其 needs_action：提交点击是否送达
   * 未知，重跑即可能重复下单。
   */
  maxGrabAttempts?: number;
  /** 重试退避基数（毫秒），第 n 次失败后睡 retryIntervalMs * 2**(n-1)。默认 500。 */
  retryIntervalMs?: number;
  /** 重试退避的单轮上限（毫秒）。默认 10000。 */
  retryBackoffCapMs?: number;
  /**
   * 提交订单点击成功后是否做只读「订单已见」验证窗口（dump UI 找
   * orderConfirmIndicators 特征，≤2.5s，**绝不 tap**）。默认 true。
   * 验证只影响 GrabResult.order_seen 字段，**永不降级** submitted 状态。
   */
  verifyOrder?: boolean;
  /**
   * 场次序号（1-based）。仅在 {@link DamaiGrabOptions.sessionLabel} 为空时使用。
   * 没有日期卡片且序号为 1 时跳过点场次。默认 1。
   */
  sessionIndex?: number;
  /**
   * 场次卡片全文，例如「2026-10-18 周日 18:30」。
   * 非空时按文字点选，点不中即失败，不退回序号。
   */
  sessionLabel?: string;
  /**
   * 票档卡片全文，例如「内场988元」。
   * 非空时按文字点选，点不中即失败，不退回 {@link damaiGrab} 的 priceIndex。
   */
  priceLabel?: string;
  /**
   * 主档缺货或对不上时按顺序尝试的票档全文。不含主档，最多 {@link MAX_PRICE_FALLBACKS} 个。
   * 与 {@link DamaiGrabOptions.priceLabel} 都为空时仍按 priceIndex 点。
   */
  priceFallbacks?: readonly string[];
  /**
   * 外部停止。确认点击发出之前置位则返回 cancelled（订单未发出）；
   * 点击已经调用之后置位则返回 needs_action。
   */
  stopEvent?: { readonly isSet: () => boolean } | null;
}

/**
 * 准备一张订单并在敏感用户动作前停下。
 *
 * 默认流程在票档与观演人选择完成后即停止，让用户检查订单并完成可能需要的
 * 安全验证。仅在用户明确选择提交订单时传 `confirmOrder: true`。
 * 支付不在本自动化流程之内，必须由用户在 APP 内完成。
 *
 * 与 Python 原版的偏离：`maxRuntimeSec` 在 Python 版为「API 对等保留、未实现」；
 * 本版实现为**硬停止**（deadline 贯穿预热/开票等待与重试循环，超限抛
 * DamaiGrabFailedError）。库层默认 `0`（不启用）以保持直连调用方行为不变；
 * `ticketNum` 会在购买弹层里把张数点到该值；填了观演人时人数必须与张数一致。
 *
 * needs_action 语义：提交订单的点击发出后结果无法确认（如 adb 传输异常）时，
 * 返回 `status: "needs_action"` 并携带官方订单页 {@link DAMAI_ORDERS_URL}——
 * 调用方应提示用户先人工核对订单，再决定是否重跑，避免重复下单。
 * **needs_action 结果严禁被任何自动重试逻辑重跑**（重试泵内为硬规则）。
 *
 * needs_human_captcha 语义：提交订单**之前**在任一检测点（购买按钮缺失 /
 * 价格表未弹出 / 选观演人超时 / 确认按钮定位失败）的页面上检测到滑块验证文案
 * （{@link DamaiSelectors.captchaIndicator}）时，返回
 * `status: "needs_human_captcha"`——页面被风控拦截但订单未提交；本流程绝不
 * 自动滑动滑块（captchaSwipeTo 仅作文案展示），由人工过验后重跑。
 *
 * 有界重试泵：可重试失败（找不到购买按钮 / 价格表未弹出 / 选观演人超时）在
 * `maxGrabAttempts > 1` 时按指数退避重试；失败现场经
 * {@link classifyGrabBlocker} 分类——captcha/session/sold_out/restricted 均
 * 终局不重试，crowd 先经 {@link DamaiSelectors.crowdPopupConfirmButtons} 关闭
 * 弹窗再重试。每轮重试都从购买按钮重新开始（接受弹层重置的简化语义）。
 *
 * submitted 的「订单已见」验证：确认点击成功后做只读验证窗口
 * （见 {@link DamaiGrabOptions.verifyOrder}），命中
 * {@link DamaiSelectors.orderConfirmIndicators} 特征 → `order_seen: true`；
 * 未见证据**永不降级** status（仍 submitted，order_seen=false）。验证窗口内
 * 检测到滑块文案时不改 status（订单已提交），仅置
 * `requires_human_confirmation: true`——与提交前的 needs_human_captcha 语义区分。
 *
 * @returns {@link GrabResult}
 *   （status: "ready_for_human" | "submitted" | "needs_action" |
 *   "needs_human_captcha" | "failed"）
 */
export async function damaiGrab(
  deviceId: string,
  itemId: string,
  priceIndex = 1,
  viewerNames: string[] | null = null,
  ticketNum = 1,
  openTime = "",
  {
    selectors = null,
    preheatSeconds = 30.0,
    pollIntervalMs = 150,
    confirmOrder = false,
    maxGrabAttempts = 1,
    retryIntervalMs = 500,
    retryBackoffCapMs = 10000,
    maxRuntimeSec = 0,
    verifyOrder = true,
    sessionIndex = 1,
    sessionLabel = "",
    priceLabel = "",
    priceFallbacks = [],
    stopEvent = null,
  }: DamaiGrabOptions = {},
): Promise<GrabResult> {
  const sel = selectors ?? new DamaiSelectors();
  const viewers = viewerNames ?? [];
  if (!Number.isInteger(ticketNum) || ticketNum < 1 || ticketNum > MAX_TICKET_NUM) {
    return {
      status: "failed",
      elapsed_ms: 0,
      screenshots: [],
      error: `购票张数必须是 1 到 ${MAX_TICKET_NUM} 的整数`,
      attempts: 0,
    };
  }
  if (viewers.length > 0 && viewers.length !== ticketNum) {
    return {
      status: "failed",
      elapsed_ms: 0,
      screenshots: [],
      error: `观演人数（${viewers.length}）必须等于购票张数（${ticketNum}）`,
      attempts: 0,
    };
  }
  if (priceFallbacks.length > MAX_PRICE_FALLBACKS) {
    return {
      status: "failed",
      elapsed_ms: 0,
      screenshots: [],
      error: `备选档位最多 ${MAX_PRICE_FALLBACKS} 个`,
      attempts: 0,
    };
  }
  const tStart = nowSec();

  // maxRuntimeSec 硬停止（与 Python 原版的偏离，见函数 TSDoc）：deadline 贯穿
  // 各等待步骤——等待被截止到 deadline，到点未达目标即抛错；<= 0 视为不启用。
  const grabDeadline = maxRuntimeSec > 0 ? tStart + maxRuntimeSec : null;
  const deadlineMessage = (): string =>
    `已达最大运行时长（${formatPyFloat(maxRuntimeSec)}s），停止抢票`;
  /** 到点检查：deadline 已过则抛 DamaiGrabFailedError（走既有 failed 路径，含截图）。 */
  const assertWithinDeadline = (): void => {
    if (grabDeadline !== null && nowSec() >= grabDeadline) {
      throw new DamaiGrabFailedError(deadlineMessage());
    }
  };
  /**
   * 带硬停止的等待：等待目标被截止到 grabDeadline；deadline 先于目标到达时，
   * 睡到 deadline 即抛 DamaiGrabFailedError（硬停止，不无限等开票）。
   */
  const waitBounded = async (untilTs: number): Promise<void> => {
    const bounded = grabDeadline !== null ? Math.min(untilTs, grabDeadline) : untilTs;
    if (bounded > nowSec()) {
      await waitUntil(bounded, { pollMs: pollIntervalMs });
    }
    if (grabDeadline !== null && nowSec() < untilTs) {
      throw new DamaiGrabFailedError(deadlineMessage());
    }
  };

  const shotsDirPath = shotsDir();
  const logPaths: string[] = [];
  // 实际执行的尝试轮数（泵循环内自增；外层 catch 的 failed 结果也要透出）
  let attemptsUsed = 0;
  let pickedSessionLabel = "";
  let pickedPriceLabel = "";
  const selectionFields = (): { session_label?: string; price_label?: string } => ({
    ...(pickedSessionLabel !== "" ? { session_label: pickedSessionLabel } : {}),
    ...(pickedPriceLabel !== "" ? { price_label: pickedPriceLabel } : {}),
  });

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
      const note = openRes.evidence ? `，入口状态: ${openRes.evidence}` : "";
      throw new DamaiGrabFailedError(
        `详情页加载失败（${openRes.elapsed_ms}ms${note}），截图: ${shot}`,
      );
    }

    // 3. 计算目标时刻（open_time 按北京时间解析；parseIso 仍是本地时区）
    const targetTs = openTime ? parseBeijingDateTime(openTime).getTime() / 1000 : nowSec();

    // 4. 预热 —— 由 damai_open_concert 完成（已在详情页）。
    //    preheat > 0 时等到 target_ts - preheat_seconds 再点购买按钮。
    const preheatUntil = Math.max(targetTs - preheatSeconds, nowSec());
    if (preheatUntil > nowSec()) {
      await waitBounded(preheatUntil);
      logger.info(`预热完成，等待开票: ${(targetTs - nowSec()).toFixed(1)}s`);
    }

    // 5. 等开票
    if (nowSec() < targetTs) {
      await waitBounded(targetTs);
      logger.info(
        `⏰ 开票！开始抢票 (${pyListRepr(viewers)}, ` +
          `场次 ${sessionLabel.trim() || `#${sessionIndex}`}, 票档 ${priceLabel.trim() || `#${priceIndex}`})`,
      );
    }

    // ---- 抢票分段 + 有界重试泵 -------------------------------------------------
    //
    // 可重试失败集合 = 「找不到购买按钮」「价格表未弹出」「选观演人超时」，
    // 且失败现场经 classifyGrabBlocker 分类为 crowd（先关弹窗）或 null。
    // 硬规则（不可重试出口）：
    // - needs_action（提交点击是否送达未知）→ 立即原样返回，永不重试；
    // - needs_human_captcha / ready_for_human / submitted → 立即返回；
    // - captcha / session / sold_out / restricted 词表命中 → 终局失败，不重试。

    /**
     * 人工接管过滑块的结果（订单未提交；绝不自动滑动滑块）。
     */
    const needsHumanCaptchaResult = (attemptNo: number, word: string): GrabResult => ({
      status: "needs_human_captcha",
      elapsed_ms: Math.trunc((nowSec() - tStart) * 1000),
      item_id: itemId,
      price_index: priceIndex,
      ...selectionFields(),
      viewer_names: viewers,
      requires_human_confirmation: true,
      payment_started: false,
      screenshots: logPaths,
      error:
        `检测到滑块验证（${sel.captchaIndicator} 命中「${word}」）。` +
        "订单尚未提交，请在 30 秒内人工完成验证后重跑；本流程不会自动重试。",
      errorCategory: "captcha",
      attempts: attemptNo,
    });

    /** 在当前页面 dump 中做 captcha 检测；dump 失败按未命中处理（不改变原语义）。 */
    const detectCaptchaWord = async (): Promise<string | null> => {
      try {
        const elements = await dumpUi(deviceId);
        const blocker = classifyGrabBlocker(elements, sel);
        return blocker.kind === "captcha" ? blocker.word : null;
      } catch (exc) {
        logger.warning(`captcha 检测用 UI dump 失败（按未命中处理）: ${excToStr(exc)}`);
        return null;
      }
    };

    /**
     * 关闭「人数太多」类拥塞弹窗：在失败现场 dump 里找
     * {@link DamaiSelectors.crowdPopupConfirmButtons} 文案的按钮并 tap——
     * 这是关闭弹窗的 tap，不是支付/下单 tap。找不到按钮时不动任何元素
     * （返回 false，下一轮重试自行恢复）。
     */
    const dismissCrowdPopup = async (elements: readonly UIElement[]): Promise<boolean> => {
      for (const word of sel.crowdPopupConfirmButtons) {
        const btn = elements.find((e) => e.visible && grabElementMentionsWord(e, word));
        if (btn !== undefined) {
          logger.info(`点击弹窗关闭按钮「${btn.text || btn.contentDesc}」后重试`);
          await tap(deviceId, ...btn.center);
          await waitMs(400);
          return true;
        }
      }
      return false;
    };

    /**
     * 单轮抢票分段：点购买 → 选票档 → 选观演人 →（可选）提交。
     * 可重试失败抛 {@link GrabRetryableError}；终态直接返回 {@link GrabResult}；
     * 其余异常原样上抛（外层 catch 转 failed / 调用方接收）。
     */
    const cancelledBeforeSubmit = (attemptNo: number): GrabResult => ({
      status: "cancelled",
      elapsed_ms: Math.trunc((nowSec() - tStart) * 1000),
      item_id: itemId,
      price_index: priceIndex,
      ...selectionFields(),
      viewer_names: viewers,
      requires_human_confirmation: false,
      payment_started: false,
      screenshots: logPaths,
      error: "用户在提交前取消，订单未发出",
      attempts: attemptNo,
    });

    const runGrabAttempt = async (attemptNo: number): Promise<GrabResult> => {
      if (stopEvent !== null && stopEvent.isSet()) {
        return cancelledBeforeSubmit(attemptNo);
      }
      // 6. 打开购买弹层：弹层已在前台（独立 Activity）则直接进入选档；
      //    否则按 文本变体 → purchase bar rid → OCR 门控坐标点击 的顺序找入口。
      if (await isSkuSheetForeground(deviceId)) {
        logger.info("购买弹层已在前台，跳过点购买入口");
      } else {
        const buyBtn = await findBuyButtonByVariants(deviceId, sel, 1.5);
        if (buyBtn !== null) {
          await tap(deviceId, ...buyBtn.center);
        } else {
          const cta = await readBottomCta(deviceId, sel);
          if (cta.kind === "buyable") {
            logger.info(`OCR 读到 CTA「${cta.label}」，坐标点击打开购买弹层`);
            await tap(deviceId, ...cta.center);
          } else {
            const shot = join(shotsDirPath, `no_buy_btn_${truncSec()}.png`);
            await screenshot(deviceId, shot);
            logPaths.push(shot);
            const detail =
              cta.kind === "not_buyable"
                ? `详情页 CTA 为「${cta.label}」，当前不可购`
                : "找不到立即购买按钮";
            throw new GrabRetryableError("buy_button", `${detail}，截图: ${shot}`);
          }
        }
      }

      // 7. 选场次，再选票档（「价格表未弹出」属可重试失败）
      try {
        pickedSessionLabel = "";
        pickedPriceLabel = "";
        const sessionEl = await damaiSelectSession(deviceId, sessionIndex, { sessionLabel });
        pickedSessionLabel = sessionEl?.text.trim() ?? "";
        const priceEl = await damaiSelectPriceByPriority(deviceId, priceIndex, {
          selectors: sel,
          priceLabel,
          priceFallbacks,
        });
        pickedPriceLabel = priceEl.text.trim();
      } catch (exc) {
        if (
          exc instanceof DamaiGrabFailedError &&
          exc.message.startsWith("价格表未弹出")
        ) {
          throw new GrabRetryableError("price_sheet", exc.message);
        }
        if (
          exc instanceof DamaiGrabFailedError &&
          exc.message.startsWith(PRICE_FALLBACKS_SOLD_OUT)
        ) {
          throw new GrabCategorizedError("sold_out", exc.message);
        }
        throw exc;
      }

      await damaiSelectTicketCount(deviceId, ticketNum, { selectors: sel });

      // 8. 选观演人（「选观演人超时」属可重试失败）
      if (viewers.length > 0) {
        try {
          await damaiSelectViewers(deviceId, viewers);
        } catch (exc) {
          if (
            exc instanceof DamaiGrabFailedError &&
            exc.message.startsWith("选观演人超时")
          ) {
            throw new GrabRetryableError("viewers_timeout", exc.message);
          }
          throw exc;
        }
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
      ...selectionFields(),
          viewer_names: viewers,
          requires_human_confirmation: true,
          payment_started: false,
          screenshots: logPaths,
          error: null,
          attempts: attemptNo,
        };
      }

      // 只有调用方显式选择提交时才会走到这里。支付仍在本自动化流程之外，
      // 必须由用户完成。
      assertWithinDeadline(); // confirm 前的硬停止检查（此刻 tap 尚未发出，失败安全）
      if (stopEvent !== null && stopEvent.isSet()) {
        return cancelledBeforeSubmit(attemptNo);
      }

      // 提交段三态语义（防重复下单）：
      // ① 定位失败（确认按钮从未出现）→ 订单请求必然未发出，原样上抛走既有
      //    失败路径，无重复下单风险；
      // ② 点击传输异常（waitForElement 已成功、tap 经 adb shell 抛错）→ 点击
      //    是否送达设备未知，订单请求可能已被 app 发出 → needs_action：
      //    提示先查官方订单页，切勿直接重跑；
      // ③ 点击成功后的非致命失败（如调试截图）→ 订单已提交，仍返回 submitted，
      //    不降级为 failed（否则用户看到失败会重跑流程、重复下单）。
      const needsAction = (reason: string): GrabResult => ({
        status: "needs_action",
        elapsed_ms: Math.trunc((nowSec() - tStart) * 1000),
        item_id: itemId,
        price_index: priceIndex,
        ...selectionFields(),
        viewer_names: viewers,
        requires_human_confirmation: true,
        payment_started: false,
        order_url: DAMAI_ORDERS_URL,
        screenshots: logPaths,
        error: `${NEEDS_ACTION_MESSAGE}（原因: ${reason}）`,
        attempts: attemptNo,
      });

      let confirmButton: UIElement;
      try {
        confirmButton = await waitForElement(deviceId, `text=${sel.confirmButton}`, { timeout: 5.0 });
      } catch (exc) {
        if (exc instanceof UIElementNotFoundError) {
          // 阶段 ①：确认按钮定位失败 ≠ 已发单——上抛前先做 captcha 检测
          const captchaWord = await detectCaptchaWord();
          if (captchaWord !== null) {
            return needsHumanCaptchaResult(attemptNo, captchaWord);
          }
          throw exc;
        }
        throw exc;
      }
      if (stopEvent !== null && stopEvent.isSet()) {
        return cancelledBeforeSubmit(attemptNo);
      }
      try {
        await tap(deviceId, ...confirmButton.center);
      } catch (exc) {
        if (exc instanceof UIElementNotFoundError) {
          throw exc;
        }
        // 阶段 ②：点击是否送达未知
        return needsAction(excToStr(exc));
      }
      if (stopEvent !== null && stopEvent.isSet()) {
        return needsAction("用户在确认点击发出后取消");
      }
      // 阶段 ③：点击已成功送达——此后任何非致命失败都不得把已提交的订单
      // 降级为 failed；调试截图失败只损失该张截图。
      const submittedShot = join(shotsDirPath, `order_submitted_${truncSec()}.png`);
      try {
        await screenshot(deviceId, submittedShot);
        logPaths.push(submittedShot);
      } catch (exc) {
        logger.warning(`提交后调试截图失败（忽略，订单已提交）: ${excToStr(exc)}`);
      }

      // 只读「订单已见」验证窗口（≤2.5s：最多 2 次 dumpUi + 300ms 间隔）：
      // 绝不 tap（包括 payButton）——验证是纯读取。命中
      // orderConfirmIndicators（或 paySuccessIndicator）即视为已见订单证据；
      // 未见证据**永不降级** status（仍 submitted + warning）；验证期间命中
      // 滑块文案不改 status（订单已提交，与提交前的 needs_human_captcha 语义
      // 区分），仅置 requires_human_confirmation 并告警。
      let orderSeen = false;
      let captchaAfterSubmit = false;
      if (verifyOrder) {
        const evidenceWords = [...sel.orderConfirmIndicators, sel.paySuccessIndicator];
        for (let probe = 0; probe < 2 && !orderSeen; probe += 1) {
          if (probe > 0) {
            await waitMs(300);
          }
          let elements: UIElement[];
          try {
            elements = await dumpUi(deviceId);
          } catch (exc) {
            logger.warning(`订单验证 dump 失败（忽略，订单已提交）: ${excToStr(exc)}`);
            break;
          }
          if (grabFirstMentionedWord(elements, evidenceWords) !== null) {
            orderSeen = true;
          } else if (grabFirstMentionedWord(elements, [sel.captchaIndicator]) !== null) {
            captchaAfterSubmit = true;
          }
        }
        if (!orderSeen) {
          logger.warning(
            `提交后未捕获到订单/收银台页证据（order_seen=false）；提交点击已送达，` +
              `请以官方订单页为准: ${DAMAI_ORDERS_URL}`,
          );
        }
        if (captchaAfterSubmit) {
          logger.warning(
            `订单验证窗口内检测到滑块验证（命中「${sel.captchaIndicator}」）；` +
              "订单已提交，status 保持 submitted，请人工跟进后续支付环节",
          );
        }
      }

      const elapsed = Math.trunc((nowSec() - tStart) * 1000);
      return {
        status: "submitted",
        elapsed_ms: elapsed,
        item_id: itemId,
        price_index: priceIndex,
      ...selectionFields(),
        viewer_names: viewers,
        requires_human_confirmation: captchaAfterSubmit,
        payment_started: false,
        order_url: DAMAI_ORDERS_URL,
        screenshots: logPaths,
        error: null,
        attempts: attemptNo,
        // order_seen 仅在验证窗口真正运行时出现：verifyOrder=false 时该键缺席，
        // 避免与「验证过但未见证据」（false）混淆。
        ...(verifyOrder ? { order_seen: orderSeen } : {}),
      };
    };

    // 外层重试泵
    for (;;) {
      attemptsUsed += 1;
      const attemptNo = attemptsUsed;
      assertWithinDeadline(); // 重试循环每轮开始前的硬停止检查
      let result: GrabResult;
      try {
        result = await runGrabAttempt(attemptNo);
      } catch (exc) {
        if (!(exc instanceof GrabRetryableError)) {
          throw exc; // 非可重试失败 → 外层 catch / 调用方
        }
        // 失败现场分类（dump 失败按无命中处理）
        let elements: UIElement[] = [];
        try {
          elements = await dumpUi(deviceId);
        } catch (dumpExc) {
          logger.warning(`失败分类用 UI dump 失败（按无弹窗处理）: ${excToStr(dumpExc)}`);
        }
        const blocker = classifyGrabBlocker(elements, sel);
        if (blocker.kind === "captcha") {
          // 滑块验证拦截：订单未提交，转人工——绝不自动过滑块，也绝不重试
          logger.warning(`检测到滑块验证（命中「${blocker.word}」），转人工处理`);
          return needsHumanCaptchaResult(attemptNo, blocker.word);
        }
        if (blocker.kind === "session") {
          throw new DamaiLoginExpiredError(
            `登录态已失效（命中「${blocker.word}」），请在大麦 APP 重新登录后再试。`,
          );
        }
        if (blocker.kind === "sold_out") {
          throw new GrabCategorizedError(
            "sold_out",
            `票已售罄（命中「${blocker.word}」），停止抢票，不再重试。`,
          );
        }
        if (blocker.kind === "restricted") {
          throw new GrabCategorizedError(
            "restricted",
            `触发限购/实名限制（命中「${blocker.word}」），停止抢票，不再重试。`,
          );
        }
        if (blocker.kind === "crowd") {
          const dismissed = await dismissCrowdPopup(elements);
          if (dismissed) {
            logger.info(`已关闭拥塞弹窗（命中「${blocker.word}」）`);
          } else {
            logger.warning(
              `检测到拥塞弹窗（命中「${blocker.word}」）但未找到关闭按钮，仍按退避重试`,
            );
          }
        }
        if (attemptNo >= maxGrabAttempts) {
          // 重试预算耗尽：带最后一次失败原因走既有 failed 路径
          const message = `已达最大重试次数（共尝试 ${attemptNo} 次），停止抢票: ${exc.message}`;
          if (blocker.kind === null) {
            throw new DamaiGrabFailedError(message);
          }
          throw new GrabCategorizedError(blocker.kind, message);
        }
        // 指数退避（2**(attempt-1)，封顶 retryBackoffCapMs）；重试前不再复查
        // deadline——循环顶部每轮开始前已检查，到点即停。
        const delay = Math.min(retryIntervalMs * 2 ** (attemptNo - 1), retryBackoffCapMs);
        logger.warning(
          `第 ${attemptNo}/${maxGrabAttempts} 次尝试失败（${excToStr(exc)}），` +
            `${Math.trunc(delay)}ms 后重试`,
        );
        if (delay > 0) {
          await sleep(delay);
        }
        continue;
      }
      return result;
    }
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
        attempts: attemptsUsed,
        ...(exc instanceof GrabCategorizedError ? { errorCategory: exc.category } : {}),
      };
    }
    throw exc;
  }
}
