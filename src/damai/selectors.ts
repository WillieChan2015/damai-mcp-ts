/**
 * 大麦 app 的 text / resource-id 常量（Python `damai/selectors.py` 的 TS 对应物）。
 *
 * 我们**不**把这些硬编码进业务动作里——大麦每周发一个新版本，选择器会漂移。
 * 因此这里只是「默认值」，调用方可以通过 `selectors` 参数整体覆盖。
 *
 * 校准基准：大麦 app v8.4.5（2026-06）。选择器漂移时通过
 * `damai_inspect_selectors` MCP 工具更新。
 */

/** {@link DamaiSelectors} 的构造参数；全部可选，缺省值与 Python dataclass 一致。 */
export interface DamaiSelectorsInit {
  /** 底部 tab「首页」（主页面内）。 */
  tabHome?: string;
  /** 底部 tab「我的」。 */
  tabMine?: string;
  /** 详情页主购买 CTA。 */
  detailBuyButton?: string;
  /** 详情页购买 CTA 备用文案。 */
  detailBuyButtonAlt?: string;
  /** 详情页购买 CTA「选座购买」变体。 */
  detailBuyButtonAlt2?: string;
  /** 观演人勾选框前缀——视觉勾选态靠 class 变化判断，这里恒为空串。 */
  viewerCheckboxPrefix?: string;
  /** 订单页底部确认按钮。 */
  confirmButton?: string;
  /** 支付页底部支付按钮。 */
  payButton?: string;
  /** 支付完成后出现的文本。 */
  paySuccessIndicator?: string;
  /** 登录态（搜索顶栏等）。 */
  loginButton?: string;
  /** 滑块验证码出现时的标志文本。 */
  captchaIndicator?: string;
  /** 滑块验证码的滑块提示文本。 */
  captchaSwipeTo?: string;
  /** 购买弹层里张数行的标题。 */
  ticketCountLabel?: string;
  /** 张数增加按钮的可见文案或 content-desc。 */
  ticketIncreaseTexts?: string[];
  /** 「抢票人数太多」类瞬时拥塞弹窗文案（可重试）。 */
  crowdPopupWords?: string[];
  /** 拥塞弹窗上的关闭/确认按钮文案（tap 后重试；这是关闭弹窗的 tap，不是支付/下单 tap）。 */
  crowdPopupConfirmButtons?: string[];
  /** 售罄类终局文案（不可重试）。 */
  soldOutWords?: string[];
  /** 限购/实名类终局文案（不可重试）。 */
  restrictedWords?: string[];
  /** 登录态失效文案（命中时抛 DamaiLoginExpiredError）。 */
  sessionExpiredWords?: string[];
  /**
   * 提交订单后判定「订单已创建」的页面特征词（收银台/订单页元素）。
   * {@link DamaiSelectors.paySuccessIndicator} 也会纳入检查，但不作为唯一证据。
   */
  orderConfirmIndicators?: string[];
}

/** 大麦动作用到的全部 UI 选择器。大麦更新后在此修改。 */
export class DamaiSelectors {
  /** 底部 tab「首页」（主页面内）。 */
  readonly tabHome: string;
  /** 底部 tab「我的」。 */
  readonly tabMine: string;
  /** 详情页主购买 CTA。 */
  readonly detailBuyButton: string;
  /** 详情页购买 CTA 备用文案。 */
  readonly detailBuyButtonAlt: string;
  /** 详情页购买 CTA「选座购买」变体。 */
  readonly detailBuyButtonAlt2: string;
  /** 观演人勾选框前缀——视觉勾选态靠 class 变化判断，这里恒为空串。 */
  readonly viewerCheckboxPrefix: string;
  /** 订单页底部确认按钮。 */
  readonly confirmButton: string;
  /** 支付页底部支付按钮。 */
  readonly payButton: string;
  /** 支付完成后出现的文本。 */
  readonly paySuccessIndicator: string;
  /** 登录态（搜索顶栏等）。 */
  readonly loginButton: string;
  /** 滑块验证码出现时的标志文本。 */
  readonly captchaIndicator: string;
  /** 滑块验证码的滑块提示文本。 */
  readonly captchaSwipeTo: string;
  /** 购买弹层里张数行的标题。 */
  readonly ticketCountLabel: string;
  /** 张数增加按钮的可见文案或 content-desc。 */
  readonly ticketIncreaseTexts: readonly string[];
  /** 「抢票人数太多」类瞬时拥塞弹窗文案（可重试）。 */
  readonly crowdPopupWords: string[];
  /** 拥塞弹窗上的关闭/确认按钮文案（tap 后重试；这是关闭弹窗的 tap，不是支付/下单 tap）。 */
  readonly crowdPopupConfirmButtons: string[];
  /** 售罄类终局文案（不可重试）。 */
  readonly soldOutWords: string[];
  /** 限购/实名类终局文案（不可重试）。 */
  readonly restrictedWords: string[];
  /** 登录态失效文案（命中时抛 DamaiLoginExpiredError）。 */
  readonly sessionExpiredWords: string[];
  /**
   * 提交订单后判定「订单已创建」的页面特征词（收银台/订单页元素）。
   * {@link DamaiSelectors.paySuccessIndicator} 也会纳入检查，但不作为唯一证据。
   */
  readonly orderConfirmIndicators: string[];

  constructor(init: DamaiSelectorsInit = {}) {
    this.tabHome = init.tabHome ?? "首页";
    this.tabMine = init.tabMine ?? "我的";
    this.detailBuyButton = init.detailBuyButton ?? "立即购买";
    this.detailBuyButtonAlt = init.detailBuyButtonAlt ?? "立即预订";
    this.detailBuyButtonAlt2 = init.detailBuyButtonAlt2 ?? "选座购买";
    this.viewerCheckboxPrefix = init.viewerCheckboxPrefix ?? "";
    this.confirmButton = init.confirmButton ?? "确认订单";
    this.payButton = init.payButton ?? "立即支付";
    this.paySuccessIndicator = init.paySuccessIndicator ?? "支付成功";
    this.loginButton = init.loginButton ?? "登录/注册";
    this.captchaIndicator = init.captchaIndicator ?? "请完成验证";
    this.captchaSwipeTo = init.captchaSwipeTo ?? "向右滑动滑块填充拼图";
    this.ticketCountLabel = init.ticketCountLabel ?? "数量";
    this.ticketIncreaseTexts = init.ticketIncreaseTexts ?? ["+", "增加"];
    this.crowdPopupWords = init.crowdPopupWords ?? [
      "人数太多",
      "抢票人数过多",
      "排队人数较多",
      "网络开小差",
      "系统繁忙",
    ];
    this.crowdPopupConfirmButtons = init.crowdPopupConfirmButtons ?? [
      "知道了",
      "确定",
      "重试",
    ];
    this.soldOutWords = init.soldOutWords ?? [
      "已售罄",
      "售罄",
      "缺货",
      "无票",
      "已结束",
    ];
    this.restrictedWords = init.restrictedWords ?? [
      "限购",
      "实名",
      "购买上限",
      "已达上限",
    ];
    this.sessionExpiredWords = init.sessionExpiredWords ?? [
      "登录已过期",
      "请重新登录",
      "登录失效",
    ];
    this.orderConfirmIndicators = init.orderConfirmIndicators ?? [
      "订单提交成功",
      "提交成功",
      "立即支付",
      "收银台",
      "核销/入场信息",
      "订单详情",
    ];
  }
}

/** {@link GrabConfig} 的构造参数；`deviceId` / `itemId` 必填，其余为默认值。 */
export interface GrabConfigInit {
  /** adb 设备序列号。 */
  deviceId: string;
  /** 大麦 item id，如 "1063631004645"。 */
  itemId: string;
  /** 第几个票档（1-based）——界面上以 ¥XXX 文本展示。默认 1。 */
  priceIndex?: number;
  /** 购票张数。默认 1。 */
  ticketNum?: number;
  /** 观演人姓名列表，如 ["杨安琪"]。默认空列表。 */
  viewerNames?: string[];
  /** 开票时间 "YYYY-MM-DD HH:MM:SS"；空串 = 立即。 */
  openTime?: string;
  /** 提前多少秒打开详情页预热。默认 30.0。 */
  preheatSeconds?: number;
  /** 硬性停止时限（秒）。默认 600.0。 */
  maxRuntimeSec?: number;
  /** 等待期间重新 dump UI 的频率（毫秒）。默认 150。 */
  pollIntervalMs?: number;
  /** 选择器集合；缺省时新建一份默认 {@link DamaiSelectors}。 */
  selectors?: DamaiSelectors;
}

/** 一次抢票运行的全部旋钮。作为参数对象传给 `damaiGrab`。 */
export class GrabConfig {
  /** adb 设备序列号。 */
  readonly deviceId: string;
  /** 大麦 item id，如 "1063631004645"。 */
  readonly itemId: string;
  /** 第几个票档（1-based）——界面上以 ¥XXX 文本展示。 */
  readonly priceIndex: number;
  /** 购票张数。 */
  readonly ticketNum: number;
  /** 观演人姓名列表（大麦实名制）。 */
  readonly viewerNames: string[];
  /** 开票时间 "YYYY-MM-DD HH:MM:SS"；空串 = 立即。 */
  readonly openTime: string;
  /** 提前多少秒打开详情页预热。 */
  readonly preheatSeconds: number;
  /** 硬性停止时限（秒）。 */
  readonly maxRuntimeSec: number;
  /** 等待期间重新 dump UI 的频率（毫秒）。 */
  readonly pollIntervalMs: number;
  /** 选择器集合（`default_factory` 语义：未给出时新建一份默认实例）。 */
  readonly selectors: DamaiSelectors;

  constructor(init: GrabConfigInit) {
    this.deviceId = init.deviceId;
    this.itemId = init.itemId;
    this.priceIndex = init.priceIndex ?? 1;
    this.ticketNum = init.ticketNum ?? 1;
    this.viewerNames = init.viewerNames ?? [];
    this.openTime = init.openTime ?? "";
    this.preheatSeconds = init.preheatSeconds ?? 30.0;
    this.maxRuntimeSec = init.maxRuntimeSec ?? 600.0;
    this.pollIntervalMs = init.pollIntervalMs ?? 150;
    this.selectors = init.selectors ?? new DamaiSelectors();
  }
}
