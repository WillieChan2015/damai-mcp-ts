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
  damaiGrab,
  damaiLoginCheck,
  isInViewerNameList,
  parseIso,
  waitUntil,
} from "../src/damai/actions";
import { DamaiSelectors, GrabConfig } from "../src/damai/selectors";
import { UIElement } from "../src/inspector/models";

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
