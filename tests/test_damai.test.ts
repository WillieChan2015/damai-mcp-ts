/**
 * damai 业务层辅助函数的测试（Python `tests/test_damai.py` 的 TS 对应物）。
 *
 * 完全 mock 掉设备侧，只测业务逻辑。
 *
 * 打桩方式说明：Python 版用 monkeypatch 直接替换 `damai_mcp.damai.actions`
 * 的模块属性（`_is_damai_foreground` / `assert_text` / `shell` /
 * `wait_for_element` / `tap` / `damai_select_price` / `damai_select_viewers` /
 * `damai_confirm_order` / `screenshot` / `_shots_dir`）。TS 的 ESM 具名导入
 * 不可变，且同模块内部调用无法被替换，因此等价做法是在**依赖模块**边界
 * （`device/adb` / `inspector/find` / `inspector/dump` / `actions/actions` /
 * `node:fs`）用 `vi.mock` 打桩，由桩驱动同一业务代码路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DAMAI_ORDERS_URL,
  NEEDS_ACTION_MESSAGE,
  classifyGrabBlocker,
  damaiGrab,
  damaiLoginCheck,
  isInViewerNameList,
  parseIso,
  waitUntil,
} from "../src/damai/actions";
import type { DamaiGrabOptions } from "../src/damai/actions";
import { DamaiSelectors, GrabConfig } from "../src/damai/selectors";
import { UIElement } from "../src/inspector/models";
import { ADBError, UIElementNotFoundError } from "../src/utils/errors";

// ---- 桩（vi.hoisted 保证先于 vi.mock 工厂与静态导入初始化） --------------------

const {
  shellMock,
  assertTextMock,
  waitForElementMock,
  dumpUiMock,
  tapMock,
  screenshotMock,
  waitMsMock,
  mkdirSyncMock,
} = vi.hoisted(() => ({
  /** `device/adb.shell` 桩（覆盖 `_is_damai_foreground` 的 dumpsys 查询与登录检查的窗口查询）。 */
  shellMock: vi.fn<(...args: unknown[]) => Promise<string>>(),
  /** `inspector/find.assertText` 桩。 */
  assertTextMock: vi.fn<(deviceId: string, text: string) => Promise<boolean>>(),
  /** `inspector/find.waitForElement` 桩。 */
  waitForElementMock: vi.fn<(...args: unknown[]) => Promise<UIElement>>(),
  /** `inspector/dump.dumpUi` 桩。 */
  dumpUiMock: vi.fn<(...args: unknown[]) => Promise<UIElement[]>>(),
  /** `actions/actions.tap` 桩。 */
  tapMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  /** `actions/actions.screenshot` 桩。 */
  screenshotMock: vi.fn<(...args: unknown[]) => Promise<Buffer>>(),
  /** `actions/actions.waitMs` 桩（保持用例即时完成）。 */
  waitMsMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  /** `node:fs.mkdirSync` 桩（对应 Python 把 `_shots_dir` 重定向到 tmp_path）。 */
  mkdirSyncMock: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock("../src/device/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/device/adb")>();
  return { ...actual, shell: shellMock };
});
vi.mock("../src/inspector/find", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/inspector/find")>();
  return { ...actual, assertText: assertTextMock, waitForElement: waitForElementMock };
});
vi.mock("../src/inspector/dump", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/inspector/dump")>();
  return { ...actual, dumpUi: dumpUiMock };
});
vi.mock("../src/actions/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/actions/actions")>();
  return { ...actual, tap: tapMock, screenshot: screenshotMock, waitMs: waitMsMock };
});
// 对应 Python 测试把 `_shots_dir` 补丁到 pytest 的 tmp_path：阻止 shotsDir()
// 在仓库里真实创建 damai_shots/ 目录（screenshot 本身已被 mock，不写文件）。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: mkdirSyncMock };
});

/** 从 shell 桩入参里取纯命令词（选项对象不计入，对应 Python 的 `*command` 元组）。 */
function shellArgv(call: unknown[]): string[] {
  return call.filter((a): a is string => typeof a === "string");
}

beforeEach(() => {
  // 清掉上一条用例设置的桩实现与调用记录
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- 纯函数 --------------------------------------------------------------------

describe("parse_iso", () => {
  it("按本地时区解析 YYYY-MM-DD HH:MM:SS", () => {
    const ts = parseIso("2026-07-09 17:21:00");
    expect(ts.getTime()).toBe(new Date(2026, 6, 9, 17, 21, 0).getTime());
  });
});

describe("is_in_viewer_name_list", () => {
  it("子串匹配观演人显示名", () => {
    expect(isInViewerNameList("杨安琪 (实名)", ["杨安琪"])).toBe(true);
    expect(isInViewerNameList("杨安琪", ["杨安琪"])).toBe(true);
    expect(isInViewerNameList("张三", ["杨安琪"])).toBe(false);
    expect(isInViewerNameList("", ["杨安琪"])).toBe(false);
  });
});

describe("wait_until", () => {
  it("目标时刻已过则立即返回（不会挂住）", async () => {
    const past = Date.now() / 1000 - 10;
    const t0 = Date.now();
    await waitUntil(past);
    expect((Date.now() - t0) / 1000).toBeLessThan(0.1);
  });

  it("到达目标时刻才返回", async () => {
    const target = Date.now() / 1000 + 0.2;
    await waitUntil(target);
    expect(Date.now() / 1000).toBeGreaterThanOrEqual(target);
  });
});

describe("grab_config", () => {
  it("默认值", () => {
    const c = new GrabConfig({ deviceId: "X", itemId: "Y" });
    expect(c.priceIndex).toBe(1);
    expect(c.ticketNum).toBe(1);
    expect(c.viewerNames).toEqual([]);
    expect(c.preheatSeconds).toBe(30.0);
    expect(c.maxRuntimeSec).toBe(600.0);
  });
});

describe("damai_selectors", () => {
  it("可整体覆盖单个选择器，其余保持默认", () => {
    const s = new DamaiSelectors({ detailBuyButton: "Buy Now" });
    expect(s.detailBuyButton).toBe("Buy Now");
    expect(s.detailBuyButtonAlt).toBe("立即预订");
  });

  it("抢票闭环词表默认值（拥塞/售罄/限购/登录失效/订单证据）", () => {
    const s = new DamaiSelectors();
    expect(s.crowdPopupWords).toContain("人数太多");
    expect(s.crowdPopupConfirmButtons).toContain("知道了");
    expect(s.soldOutWords).toContain("已售罄");
    expect(s.restrictedWords).toContain("限购");
    expect(s.sessionExpiredWords).toContain("请重新登录");
    expect(s.orderConfirmIndicators).toContain("立即支付");
  });
});

// ---- 抢票阻断词表分类（item-6） -------------------------------------------------

describe("classify_grab_blocker", () => {
  const sel = new DamaiSelectors();
  const el = (text: string, visible = true) =>
    new UIElement({
      tag: "node",
      text,
      bounds: visible ? [0, 0, 100, 40] : [0, 0, 0, 0],
    });

  it("按词表逐类命中", () => {
    expect(classifyGrabBlocker([el("请完成验证")], sel)).toEqual({
      kind: "captcha",
      word: "请完成验证",
    });
    expect(classifyGrabBlocker([el("登录已过期，请重新登录")], sel)).toEqual({
      kind: "session",
      word: "登录已过期",
    });
    expect(classifyGrabBlocker([el("已售罄")], sel)).toEqual({
      kind: "sold_out",
      word: "已售罄",
    });
    expect(classifyGrabBlocker([el("每单限购 2 张")], sel)).toEqual({
      kind: "restricted",
      word: "限购",
    });
    expect(classifyGrabBlocker([el("抢票人数太多，请稍后再试")], sel)).toEqual({
      kind: "crowd",
      word: "人数太多",
    });
  });

  it("高优先级词在场时压过低优先级词（captcha > session > sold_out > restricted > crowd）", () => {
    expect(classifyGrabBlocker([el("抢票人数太多"), el("请完成验证")], sel).kind).toBe(
      "captcha",
    );
    expect(classifyGrabBlocker([el("已售罄"), el("登录已过期")], sel).kind).toBe("session");
    expect(classifyGrabBlocker([el("限购"), el("已售罄")], sel).kind).toBe("sold_out");
    expect(classifyGrabBlocker([el("人数太多"), el("限购")], sel).kind).toBe("restricted");
  });

  it("content-desc 命中同样有效；不可见元素被忽略", () => {
    const descEl = new UIElement({
      tag: "node",
      contentDesc: "已售罄",
      bounds: [0, 0, 100, 40],
    });
    expect(classifyGrabBlocker([descEl], sel).kind).toBe("sold_out");
    expect(classifyGrabBlocker([el("已售罄", false)], sel).kind).toBeNull();
  });

  it("无命中返回 null + 空词", () => {
    expect(classifyGrabBlocker([el("¥680")], sel)).toEqual({ kind: null, word: "" });
    expect(classifyGrabBlocker([], sel)).toEqual({ kind: null, word: "" });
  });
});

// ---- 登录检查 ------------------------------------------------------------------

describe("damai_login_check", () => {
  it("识别 9.0.31 的新版未登录文案「立即登录」", async () => {
    // _is_damai_foreground 桩：恒为前台
    shellMock.mockImplementation(async (...args: unknown[]) => {
      const argv = shellArgv(args);
      if (argv[0] === "dumpsys" && argv[1] === "activity") {
        return "… cn.damai …（前台）";
      }
      return ""; // dumpsys window windows：无安全验证 Activity
    });
    // assert_text 桩：只有新版未登录文案能命中
    assertTextMock.mockImplementation(async (_deviceId: string, text: string) => {
      return text === "立即登录";
    });

    const result = await damaiLoginCheck("emulator-5566");

    expect(result.foreground).toBe(true);
    expect(result.logged_in).toBe(false);
  });

  it("登录 / 安全验证 Activity 出现时立即停止", async () => {
    shellMock.mockImplementation(async (...args: unknown[]) => {
      const argv = shellArgv(args);
      if (argv[0] === "dumpsys" && argv[1] === "window" && argv[2] === "windows") {
        return (
          "mCurrentFocus=cn.damai/com.alibaba.wireless.security.open.middletier.fc.ui.ContainerActivity"
        );
      }
      return "… cn.damai …（前台）"; // 对应 Python 版 _is_damai_foreground 桩
    });

    const result = await damaiLoginCheck("emulator-5566");

    expect(result.logged_in).toBe(false);
    expect(result.user_hint).toBeTruthy();
    // Python 版在 shell 桩内断言 command == ("dumpsys", "window", "windows")；
    // TS 侧同模块的 _is_damai_foreground 无法独立打桩，改为校验确有该窗口查询
    const windowCall = shellMock.mock.calls.find((call) => {
      const argv = shellArgv(call);
      return (
        argv[0] === "dumpsys" && argv[1] === "window" && argv[2] === "windows"
      );
    });
    expect(windowCall).toBeDefined();
  });
});

// ---- 一站式抢票 ----------------------------------------------------------------

describe("damai_grab", () => {
  it("默认停在人工确认之前（confirm_order 默认 false，永不自动支付）", async () => {
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });

    // damai_login_check：前台 + 已登录（新文案未命中）
    shellMock.mockImplementation(async (...args: unknown[]) => {
      const argv = shellArgv(args);
      if (argv[0] === "dumpsys" && argv[1] === "activity") {
        return "… cn.damai …（前台）";
      }
      return ""; // dumpsys window windows：无安全验证 Activity
    });
    assertTextMock.mockResolvedValue(false);
    // damai_open_concert 内的「等购买按钮」与 damai_grab 第 6 步共用此桩
    waitForElementMock.mockResolvedValue(buyButton);
    // damai_select_price / damai_select_viewers 内的 dumpUi 桩：
    // 一个 ¥ 票档元素 + 一个观演人元素
    dumpUiMock.mockResolvedValue([
      new UIElement({ tag: "node", text: "¥680", bounds: [0, 100, 200, 160] }),
      new UIElement({ tag: "node", text: "viewer", bounds: [0, 300, 200, 360] }),
    ]);
    tapMock.mockResolvedValue(undefined);
    screenshotMock.mockResolvedValue(Buffer.alloc(0));
    waitMsMock.mockResolvedValue(undefined);
    mkdirSyncMock.mockReturnValue(undefined);

    const result = await damaiGrab("device", "item", 1, ["viewer"]);

    expect(result.status).toBe("ready_for_human");
    expect(result.requires_human_confirmation).toBe(true);
    expect(result.payment_started).toBe(false);
    // 重试泵默认关闭（maxGrabAttempts=1）：单轮即返回
    expect(result.attempts).toBe(1);
    // 订单请求尚未发出：不携带官方订单页指引（仅 submitted / needs_action 携带）
    expect(result.order_url).toBeUndefined();
    // Python 版 `confirm.assert_not_awaited()`：damai_confirm_order 与
    // damai_grab 同模块、无法直接打桩，以其唯一入口 waitForElement 请求
    // 「确认订单 / 立即支付」按钮从未发生作为等价断言
    const requestedSelectors = waitForElementMock.mock.calls.map(
      (call) => call[1] as string,
    );
    expect(requestedSelectors).not.toContain("text=确认订单");
    expect(requestedSelectors).not.toContain("text=立即支付");
  });
});

// ---- 提交订单三态语义（防重复下单）---------------------------------------------

/**
 * 提交段三态语义的公共桩：登录/前台/详情页/票档全部放行，只有「确认订单」
 * 按钮的点击结果由用例通过 `confirmTapBehavior` 决定。
 *
 * 按钮以坐标区分：确认订单元素 bounds [500,1200,700,1260] → 中心 (600,1230)，
 * 与前置阶段的购买按钮 (5,5) / 票档 (100,130) 不重叠，tapMock 按落点分流。
 */
async function runGrabToConfirm(
  confirmTapBehavior: () => Promise<void>,
  {
    screenshotError,
    grabOptions,
    dumpAfterPrice,
  }: {
    screenshotError?: Error;
    /** 额外透传给 damaiGrab 的选项（confirmOrder: true 恒已设置）。 */
    grabOptions?: DamaiGrabOptions;
    /**
     * 提交后（选票档那次 dumpUi 之外）dumpUi 的返回：
     * 元素列表或抛出的错误；缺省保持旧的「恒返回 ¥680」桩行为。
     */
    dumpAfterPrice?: UIElement[] | Error;
  } = {},
): Promise<Awaited<ReturnType<typeof damaiGrab>>> {
  const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
  const confirmButton = new UIElement({
    tag: "node",
    text: "确认订单",
    bounds: [500, 1200, 700, 1260],
  });
  const [confirmX, confirmY] = confirmButton.center;

  // damai_login_check：前台 + 已登录
  shellMock.mockImplementation(async (...args: unknown[]) => {
    const argv = shellArgv(args);
    if (argv[0] === "dumpsys" && argv[1] === "activity") {
      return "… cn.damai …（前台）";
    }
    return ""; // dumpsys window windows：无安全验证 Activity
  });
  assertTextMock.mockResolvedValue(false);
  // damai_open_concert / 购买按钮 / 票档弹层 / 确认订单 共用 waitForElement 桩，
  // 按选择器分流：仅「确认订单」返回独立元素（供 tapMock 按坐标识别）
  waitForElementMock.mockImplementation(async (...args: unknown[]) => {
    const selector = args[1] as string;
    if (selector === "text=确认订单") {
      return confirmButton;
    }
    return buyButton;
  });
  // damai_select_price 的 dumpUi 桩：一个 ¥ 票档元素（viewerNames=null，跳过观演人）
  if (dumpAfterPrice === undefined) {
    dumpUiMock.mockResolvedValue([
      new UIElement({ tag: "node", text: "¥680", bounds: [0, 100, 200, 160] }),
    ]);
  } else {
    let dumpCalls = 0;
    dumpUiMock.mockImplementation(async () => {
      dumpCalls += 1;
      if (dumpCalls === 1) {
        return [new UIElement({ tag: "node", text: "¥680", bounds: [0, 100, 200, 160] })];
      }
      if (dumpAfterPrice instanceof Error) {
        throw dumpAfterPrice;
      }
      return dumpAfterPrice;
    });
  }
  tapMock.mockImplementation(async (...args: unknown[]) => {
    const x = args[1] as number;
    const y = args[2] as number;
    if (x === confirmX && y === confirmY) {
      await confirmTapBehavior();
    }
  });
  screenshotMock.mockImplementation(async () => {
    if (screenshotError !== undefined) {
      throw screenshotError;
    }
    return Buffer.alloc(0);
  });
  waitMsMock.mockResolvedValue(undefined);
  mkdirSyncMock.mockReturnValue(undefined);

  return damaiGrab("device", "item", 1, null, 1, "", {
    confirmOrder: true,
    ...grabOptions,
  });
}

describe("damai_grab 提交订单三态语义", () => {
  it("confirmOrder=true 快乐路径 → submitted 且携带官方订单页 URL", async () => {
    const result = await runGrabToConfirm(async () => {});

    expect(result.status).toBe("submitted");
    expect(result.order_url).toBe(DAMAI_ORDERS_URL);
    expect(result.error).toBeNull();
    expect(result.requires_human_confirmation).toBe(false);
    expect(result.payment_started).toBe(false);
    expect(result.screenshots).toHaveLength(1);
  });

  it("确认按钮定位成功后 tap 抛 ADBError → needs_action（结果未知，不报 failed）", async () => {
    const result = await runGrabToConfirm(async () => {
      throw new ADBError("模拟：确认订单点击传输失败");
    });

    expect(result.status).toBe("needs_action");
    // error 恒以固定中文句式开头，原因子句携带底层异常文本
    expect(result.error?.startsWith(NEEDS_ACTION_MESSAGE)).toBe(true);
    expect(result.error).toContain("模拟：确认订单点击传输失败");
    expect(result.order_url).toBe(DAMAI_ORDERS_URL);
    expect(result.requires_human_confirmation).toBe(true);
    expect(result.payment_started).toBe(false);
  });

  it("确认订单阶段抛 UIElementNotFoundError → 仍按失败上抛（定位失败 ≠ 已发单）", async () => {
    // 既有语义：定位类异常原样上抛（外层 catch 只兜 DamaiGrabFailedError /
    // DamaiLoginExpiredError），绝不能被归类成 needs_action
    const err: unknown = await runGrabToConfirm(async () => {
      throw new UIElementNotFoundError("模拟：确认订单点击抛定位异常");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UIElementNotFoundError);
    // 消息含「确认订单」：确认异常来自确认订单阶段而非前置购买/票档阶段
    expect((err as Error).message).toContain("确认订单");
  });

  it("tap 成功后截图失败 → 仍 submitted 不降级（重复下单 bug 修复）", async () => {
    const result = await runGrabToConfirm(async () => {}, {
      screenshotError: new Error("模拟：提交后截图失败"),
    });

    // 订单已提交：截图失败只损失该张调试截图，不得把结果降级为 failed
    expect(result.status).toBe("submitted");
    expect(result.error).toBeNull();
    expect(result.order_url).toBe(DAMAI_ORDERS_URL);
    expect(result.screenshots).toHaveLength(0);
  });

  it("选票档前置失败 → 仍 failed（请求未发出，语义不变）", async () => {
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    shellMock.mockImplementation(async (...args: unknown[]) => {
      const argv = shellArgv(args);
      if (argv[0] === "dumpsys" && argv[1] === "activity") {
        return "… cn.damai …（前台）";
      }
      return "";
    });
    assertTextMock.mockResolvedValue(false);
    waitForElementMock.mockResolvedValue(buyButton);
    // dumpUi 无任何 ¥xxx 价格元素 → damai_select_price 抛 DamaiGrabFailedError
    dumpUiMock.mockResolvedValue([
      new UIElement({ tag: "node", text: "选座", bounds: [0, 0, 10, 10] }),
    ]);
    tapMock.mockResolvedValue(undefined);
    screenshotMock.mockResolvedValue(Buffer.alloc(0));
    waitMsMock.mockResolvedValue(undefined);
    mkdirSyncMock.mockReturnValue(undefined);

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      confirmOrder: true,
    });

    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("未找到任何 ¥xxx");
    expect(result.order_url).toBeUndefined();
  });
});

// ---- 抢票闭环：重试泵 + maxRuntimeSec 硬停止（item-4 / item-6） ------------------

/** 抢票分段内购买按钮等待的 timeout 上限（详情页加载等待/价格弹层等待都 ≥4s）。 */
const BUY_WAIT_TIMEOUT_MAX = 2;

/** 公共环境桩：登录/前台放行、截图与等待全放行（waitForElement / dumpUi 由用例定制）。 */
function stubGrabEnv(): void {
  shellMock.mockImplementation(async (...args: unknown[]) => {
    const argv = shellArgv(args);
    if (argv[0] === "dumpsys" && argv[1] === "activity") {
      return "… cn.damai …（前台）";
    }
    return "";
  });
  assertTextMock.mockResolvedValue(false);
  tapMock.mockResolvedValue(undefined);
  screenshotMock.mockResolvedValue(Buffer.alloc(0));
  waitMsMock.mockResolvedValue(undefined);
  mkdirSyncMock.mockReturnValue(undefined);
}

describe("damai_grab 重试泵", () => {
  it("购买按钮前 2 轮等待失败、第 3 轮成功 → attempts=3 且最终 submitted", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    const confirmButton = new UIElement({
      tag: "node",
      text: "确认订单",
      bounds: [500, 1200, 700, 1260],
    });
    const BUY_LABELS = new Set(["text=立即购买", "text=立即预订", "text=选座购买"]);
    let buyRejectsLeft = 6; // 前 2 轮 × 3 个文案变体全部落空
    waitForElementMock.mockImplementation(async (...args: unknown[]) => {
      const selector = args[1] as string;
      const opts = (args[2] ?? {}) as { timeout?: number };
      if (selector === "text=确认订单") {
        return confirmButton;
      }
      const isBuyLoopWait = BUY_LABELS.has(selector) && (opts.timeout ?? 0) <= BUY_WAIT_TIMEOUT_MAX;
      if (isBuyLoopWait && buyRejectsLeft > 0) {
        buyRejectsLeft -= 1;
        throw new UIElementNotFoundError(`模拟：未找到 ${selector}`);
      }
      return buyButton;
    });
    dumpUiMock.mockResolvedValue([
      new UIElement({ tag: "node", text: "¥680", bounds: [0, 100, 200, 160] }),
    ]);

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      confirmOrder: true,
      maxGrabAttempts: 3,
      retryIntervalMs: 1,
    });

    expect(result.status).toBe("submitted");
    expect(result.attempts).toBe(3);
  });

  it("crowd 词表命中 → 先 tap「知道了」关闭弹窗再重试成功", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    const crowdWord = new UIElement({
      tag: "node",
      text: "抢票人数太多，请稍后再试",
      bounds: [100, 400, 600, 460],
    });
    const dismissBtn = new UIElement({
      tag: "node",
      text: "知道了",
      bounds: [200, 480, 400, 540],
    });
    const [dismissX, dismissY] = dismissBtn.center;
    let crowdDismissed = false;
    tapMock.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === dismissX && args[2] === dismissY) {
        crowdDismissed = true;
      }
    });
    waitForElementMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[2] ?? {}) as { timeout?: number };
      // 详情页加载等待 / 价格弹层等待放行；抢票分段内的购买按钮等待被弹窗遮挡
      if ((opts.timeout ?? 0) > BUY_WAIT_TIMEOUT_MAX || crowdDismissed) {
        return buyButton;
      }
      throw new UIElementNotFoundError("模拟：拥塞弹窗遮挡页面");
    });
    dumpUiMock.mockImplementation(async () => {
      if (!crowdDismissed) {
        return [crowdWord, dismissBtn];
      }
      return [new UIElement({ tag: "node", text: "¥680", bounds: [0, 100, 200, 160] })];
    });

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      maxGrabAttempts: 2,
      retryIntervalMs: 1,
    });

    expect(result.status).toBe("ready_for_human");
    expect(result.attempts).toBe(2);
    // 第一笔 tap 是关闭弹窗（关闭弹窗的 tap，不是支付/下单 tap），随后才是购买/票档
    expect(tapMock.mock.calls.length).toBe(3);
    expect(tapMock.mock.calls[0][1]).toBe(dismissX);
    expect(tapMock.mock.calls[0][2]).toBe(dismissY);
  });

  it("sold_out 词表命中 → 立即 failed 不重试（零 tap）", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    waitForElementMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[2] ?? {}) as { timeout?: number };
      if ((opts.timeout ?? 0) > BUY_WAIT_TIMEOUT_MAX) {
        return buyButton; // 详情页加载等待放行
      }
      throw new UIElementNotFoundError("模拟：售罄后购买按钮消失");
    });
    dumpUiMock.mockResolvedValue([
      new UIElement({ tag: "node", text: "已售罄", bounds: [0, 0, 100, 40] }),
    ]);

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      maxGrabAttempts: 5,
      retryIntervalMs: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("售罄");
    expect(result.errorCategory).toBe("sold_out");
    expect(result.attempts).toBe(1);
    // 终局失败不重试：全程零 tap（既没点购买也没关弹窗）
    expect(tapMock.mock.calls.length).toBe(0);
  });

  it("restricted 词表命中 → 立即 failed 不重试", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    waitForElementMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[2] ?? {}) as { timeout?: number };
      if ((opts.timeout ?? 0) > BUY_WAIT_TIMEOUT_MAX) {
        return buyButton;
      }
      throw new UIElementNotFoundError("模拟：限购提示页无购买按钮");
    });
    dumpUiMock.mockResolvedValue([
      new UIElement({ tag: "node", text: "本轮限购 2 张", bounds: [0, 0, 100, 40] }),
    ]);

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      maxGrabAttempts: 5,
      retryIntervalMs: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("限购");
    expect(result.errorCategory).toBe("restricted");
    expect(result.attempts).toBe(1);
    expect(tapMock.mock.calls.length).toBe(0);
  });

  it("session 词表命中 → 按 DamaiLoginExpiredError 归 failed，不重试", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    waitForElementMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[2] ?? {}) as { timeout?: number };
      if ((opts.timeout ?? 0) > BUY_WAIT_TIMEOUT_MAX) {
        return buyButton;
      }
      throw new UIElementNotFoundError("模拟：登录过期页无购买按钮");
    });
    dumpUiMock.mockResolvedValue([
      new UIElement({ tag: "node", text: "登录已过期，请重新登录", bounds: [0, 0, 100, 40] }),
    ]);

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      maxGrabAttempts: 5,
      retryIntervalMs: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("重新登录");
    expect(result.attempts).toBe(1);
    expect(tapMock.mock.calls.length).toBe(0);
  });

  it("重试预算耗尽（无词表命中）→ failed 且 error 含「重试」并保留最后失败原因", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    waitForElementMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[2] ?? {}) as { timeout?: number };
      if ((opts.timeout ?? 0) > BUY_WAIT_TIMEOUT_MAX) {
        return buyButton;
      }
      throw new UIElementNotFoundError("模拟：购买按钮始终未出现");
    });
    dumpUiMock.mockResolvedValue([
      new UIElement({ tag: "node", text: "正在排队中", bounds: [0, 0, 100, 40] }),
    ]);

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      maxGrabAttempts: 2,
      retryIntervalMs: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("重试");
    expect(result.error ?? "").toContain("找不到立即购买按钮");
    expect(result.attempts).toBe(2);
  });

  it("maxRuntimeSec=0.5 且开票时刻更远 → 硬停止 failed，error 含「最大运行时长」", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    waitForElementMock.mockResolvedValue(buyButton);
    dumpUiMock.mockResolvedValue([
      new UIElement({ tag: "node", text: "¥680", bounds: [0, 100, 200, 160] }),
    ]);
    const target = new Date(Date.now() + 5000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const openTime =
      `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())} ` +
      `${pad(target.getHours())}:${pad(target.getMinutes())}:${pad(target.getSeconds())}`;

    const result = await damaiGrab("device", "item", 1, null, 1, openTime, {
      preheatSeconds: 0.0,
      maxRuntimeSec: 0.5,
    });

    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("最大运行时长");
  });
});

// ---- 抢票闭环：captcha 拦截 → needs_human_captcha（item-8） ----------------------

const CAPTCHA_ELEMENT = new UIElement({
  tag: "node",
  text: "请完成验证后继续购票",
  bounds: [0, 0, 100, 40],
});

describe("damai_grab captcha 拦截（needs_human_captcha）", () => {
  it("检测点①：购买按钮未出现且页面含验证文案 → needs_human_captcha（绝不 tap、不重试）", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    waitForElementMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[2] ?? {}) as { timeout?: number };
      if ((opts.timeout ?? 0) > BUY_WAIT_TIMEOUT_MAX) {
        return buyButton;
      }
      throw new UIElementNotFoundError("模拟：验证层遮挡购买按钮");
    });
    dumpUiMock.mockResolvedValue([CAPTCHA_ELEMENT]);

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      maxGrabAttempts: 3,
    });

    expect(result.status).toBe("needs_human_captcha");
    expect(result.error?.startsWith("检测到滑块验证（")).toBe(true);
    expect(result.error ?? "").toContain("请完成验证");
    expect(result.error ?? "").toContain("订单尚未提交");
    expect(result.error ?? "").toContain("本流程不会自动重试");
    expect(result.requires_human_confirmation).toBe(true);
    expect(result.payment_started).toBe(false);
    expect(result.errorCategory).toBe("captcha");
    // 订单未发出：不携带官方订单页指引
    expect(result.order_url).toBeUndefined();
    // maxGrabAttempts=3 但 captcha 不重试：单轮即返回
    expect(result.attempts).toBe(1);
    // 绝不自动过滑块：全程零 tap
    expect(tapMock.mock.calls.length).toBe(0);
  });

  it("检测点②：价格表未弹出且页面含验证文案 → needs_human_captcha", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    waitForElementMock.mockImplementation(async (...args: unknown[]) => {
      const selector = args[1] as string;
      if (selector === "text=¥") {
        throw new UIElementNotFoundError("模拟：价格弹层被验证层挡住");
      }
      return buyButton;
    });
    dumpUiMock.mockResolvedValue([CAPTCHA_ELEMENT]);

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      confirmOrder: true,
      maxGrabAttempts: 3,
    });

    expect(result.status).toBe("needs_human_captcha");
    expect(result.error?.startsWith("检测到滑块验证（")).toBe(true);
    expect(result.attempts).toBe(1);
    // 只有购买按钮那一次 tap，无任何后续下单动作
    expect(tapMock.mock.calls.length).toBe(1);
  });

  it("检测点③：选观演人超时且页面含验证文案 → needs_human_captcha", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    waitForElementMock.mockResolvedValue(buyButton);
    // 第 1 次 dump：选票档扫描（需有 ¥ 元素）；其后：观演人轮询与失败分类都只见验证层
    dumpUiMock
      .mockResolvedValueOnce([
        new UIElement({ tag: "node", text: "¥680", bounds: [0, 100, 200, 160] }),
      ])
      .mockResolvedValue([CAPTCHA_ELEMENT]);

    const result = await damaiGrab("device", "item", 1, ["杨安琪"], 1, "", {
      maxGrabAttempts: 3,
    });

    expect(result.status).toBe("needs_human_captcha");
    expect(result.error?.startsWith("检测到滑块验证（")).toBe(true);
    expect(result.attempts).toBe(1);
  }, 15000);

  it("检测点④：确认按钮定位失败且页面含验证文案 → needs_human_captcha（不外抛定位异常）", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    waitForElementMock.mockImplementation(async (...args: unknown[]) => {
      const selector = args[1] as string;
      if (selector === "text=确认订单") {
        throw new UIElementNotFoundError("模拟：确认按钮被验证层遮挡");
      }
      return buyButton;
    });
    // 第 1 次 dump：选票档扫描；第 2 次 dump：captcha 检测
    dumpUiMock
      .mockResolvedValueOnce([
        new UIElement({ tag: "node", text: "¥680", bounds: [0, 100, 200, 160] }),
      ])
      .mockResolvedValueOnce([CAPTCHA_ELEMENT]);

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      confirmOrder: true,
    });

    expect(result.status).toBe("needs_human_captcha");
    expect(result.error?.startsWith("检测到滑块验证（")).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it("captcha 命中优先于 crowd：弹窗与验证文案同时在场 → 仍 needs_human_captcha", async () => {
    stubGrabEnv();
    const buyButton = new UIElement({ tag: "node", text: "Buy", bounds: [0, 0, 10, 10] });
    waitForElementMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[2] ?? {}) as { timeout?: number };
      if ((opts.timeout ?? 0) > BUY_WAIT_TIMEOUT_MAX) {
        return buyButton;
      }
      throw new UIElementNotFoundError("模拟：弹窗遮挡");
    });
    dumpUiMock.mockResolvedValue([
      new UIElement({ tag: "node", text: "抢票人数太多", bounds: [0, 100, 100, 140] }),
      CAPTCHA_ELEMENT,
    ]);

    const result = await damaiGrab("device", "item", 1, null, 1, "", {
      maxGrabAttempts: 3,
    });

    expect(result.status).toBe("needs_human_captcha");
    expect(tapMock.mock.calls.length).toBe(0);
  });
});

// ---- 抢票闭环：needs_action 严禁重试（防重复下单硬规则） -------------------------

describe("damai_grab needs_action 严禁重试", () => {
  it("maxGrabAttempts=3 时确认按钮 tap 失败 → 单轮即返回 needs_action，确认按钮只定位一次", async () => {
    const result = await runGrabToConfirm(
      async () => {
        throw new ADBError("模拟：确认订单点击传输失败");
      },
      { grabOptions: { maxGrabAttempts: 3, retryIntervalMs: 1 } },
    );

    expect(result.status).toBe("needs_action");
    expect(result.error?.startsWith(NEEDS_ACTION_MESSAGE)).toBe(true);
    // 单轮即返回：attempts=1，确认按钮只被定位一次（重试会重新走全链路）
    expect(result.attempts).toBe(1);
    const confirmLocates = waitForElementMock.mock.calls.filter(
      (call) => call[1] === "text=确认订单",
    );
    expect(confirmLocates.length).toBe(1);
  });
});

// ---- 抢票闭环：提交后「订单已见」只读验证（item-5） ------------------------------

describe("damai_grab 提交后订单验证（order_seen）", () => {
  const PAY_EVIDENCE = new UIElement({
    tag: "node",
    text: "立即支付",
    bounds: [100, 1300, 400, 1360],
  });
  const CAPTCHA_ON_PAGE = new UIElement({
    tag: "node",
    text: "请完成验证",
    bounds: [0, 0, 100, 40],
  });

  it("提交后 dump 命中「立即支付」→ order_seen=true 且 status 仍 submitted", async () => {
    const result = await runGrabToConfirm(async () => {}, {
      dumpAfterPrice: [PAY_EVIDENCE],
    });

    expect(result.status).toBe("submitted");
    expect(result.order_seen).toBe(true);
    expect(result.requires_human_confirmation).toBe(false);
    // 全程只有 购买/票档/确认 三次 tap——验证窗口绝不 tap（支付安全回归）
    expect(tapMock.mock.calls.length).toBe(3);
  });

  it("提交后 dump 无任何证据 → order_seen=false 但 status 永不降级（仍 submitted）", async () => {
    const result = await runGrabToConfirm(async () => {}, { dumpAfterPrice: [] });

    expect(result.status).toBe("submitted");
    expect(result.order_seen).toBe(false);
    expect(result.error).toBeNull();
    expect(result.order_url).toBe(DAMAI_ORDERS_URL);
    expect(tapMock.mock.calls.length).toBe(3);
  });

  it("verifyOrder=false → 完全不做提交后 dump（dumpUi 仅选票档那一次）", async () => {
    const result = await runGrabToConfirm(async () => {}, {
      grabOptions: { verifyOrder: false },
      dumpAfterPrice: [PAY_EVIDENCE], // 若开了验证本可命中——反证确实没 dump
    });

    expect(result.status).toBe("submitted");
    expect(result.order_seen).toBeUndefined();
    expect(dumpUiMock.mock.calls.length).toBe(1);
  });

  it("订单验证 dump 抛错 → 吞掉，order_seen=false，status 仍 submitted", async () => {
    const result = await runGrabToConfirm(async () => {}, {
      dumpAfterPrice: new Error("模拟：提交后 dump 失败"),
    });

    expect(result.status).toBe("submitted");
    expect(result.order_seen).toBe(false);
    expect(result.error).toBeNull();
  });

  it("验证窗口内命中滑块文案 → status 保持 submitted，仅 requires_human_confirmation 置 true", async () => {
    const result = await runGrabToConfirm(async () => {}, {
      dumpAfterPrice: [CAPTCHA_ON_PAGE],
    });

    // 订单已提交：与提交前的 needs_human_captcha 语义区分，绝不改 status
    expect(result.status).toBe("submitted");
    expect(result.order_seen).toBe(false);
    expect(result.requires_human_confirmation).toBe(true);
    // 绝不为过滑块 tap：仍只有 购买/票档/确认 三次
    expect(tapMock.mock.calls.length).toBe(3);
  });
});
