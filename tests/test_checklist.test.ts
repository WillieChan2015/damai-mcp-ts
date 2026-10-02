/**
 * 抢票日 checklist 编排器的测试（Python `tests/test_checklist.py` 的 TS 对应物）。
 *
 * 通过模块级 mock 避开 ADB / 网络等重依赖：
 * - `damai/actions`（对应 Python monkeypatch `checklist.damai_grab` 等模块属性；
 *   TS 的 ESM 具名导入不可变，改为在来源模块上用 vi.mock 打桩）；
 * - `utils/ntp`（Python 版允许真实 NTP 查询在测试里失败后继续；TS 侧直接把
 *   `async_query` mock 成立即失败，既保持「无 NTP 也继续」的路径又避免触网）；
 * - `DeviceManager.shared`（对应 Python monkeypatch 该 classmethod 返回
 *   `_FakeDeviceManager`，用 vi.spyOn 静态方法实现）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChecklistResult,
  CountdownSignalGate,
  PhaseEvent,
  COUNTDOWN_NODE_RESOURCE_ID,
  GATE_BASELINE_COUNT,
  GATE_BASELINE_WINDOW_MS,
  GATE_DEFAULT_POLL_MS,
  GATE_FALLBACK_AFTER_MS,
  countdownLoop,
  parseOpenTime,
  runChecklist,
  waitForSaleStart,
  type StopEvent,
} from "../src/damai/checklist";
import { DeviceInfo, DeviceManager } from "../src/device/manager";
import { UIElement } from "../src/inspector/models";

// ---- 模块级桩 ------------------------------------------------------------------

const {
  grabMock,
  loginMock,
  openMock,
  asyncQueryMock,
  dumpUiMock,
  swipeMock,
  screenshotMock,
} = vi.hoisted(() => ({
  /** `damai/actions.damaiGrab` 桩。 */
  grabMock: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  /** `damai/actions.damaiLoginCheck` 桩。 */
  loginMock: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  /** `damai/actions.damaiOpenConcert` 桩。 */
  openMock: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  /** `utils/ntp.asyncQuery` 桩。 */
  asyncQueryMock: vi.fn<(...args: unknown[]) => Promise<never>>(),
  /** `inspector/dump.dumpUi` 桩（waitForSaleStart 的倒计时节点观察 + 预热 warm dump）。 */
  dumpUiMock: vi.fn<(...args: unknown[]) => Promise<UIElement[]>>(),
  /** `actions/actions.swipe` 桩（waitForSaleStart 的下拉刷新手势）。 */
  swipeMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  /** `actions/actions.screenshot` 桩（预热 warm dump 用，避免触达真实 adb）。 */
  screenshotMock: vi.fn<(...args: unknown[]) => Promise<Buffer>>(),
}));

vi.mock("../src/damai/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/damai/actions")>();
  return {
    ...actual,
    damaiGrab: grabMock,
    damaiLoginCheck: loginMock,
    damaiOpenConcert: openMock,
  };
});
vi.mock("../src/utils/ntp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ntp")>();
  return { ...actual, asyncQuery: asyncQueryMock };
});
// waitForSaleStart 经 dumpUi 观察倒计时节点、经 swipe 执行刷新手势：
// ESM 具名导入不可变，桩落在来源模块上（与本文件其余 mock 同一约定）。
vi.mock("../src/inspector/dump", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/inspector/dump")>();
  return { ...actual, dumpUi: dumpUiMock };
});
vi.mock("../src/actions/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/actions/actions")>();
  return { ...actual, swipe: swipeMock, screenshot: screenshotMock };
});

beforeEach(() => {
  vi.resetAllMocks();

  // 对应 Python monkeypatch "damai_mcp.device.manager.DeviceManager.shared"
  // 返回 _FakeDeviceManager（model="Leidian", screen_size="1080x1920"）
  const fakeInfo = new DeviceInfo({
    deviceId: "127.0.0.1:5555",
    state: "device",
    model: "Leidian",
    screenSize: "1080x1920",
  });
  const fakeManager = {
    require: vi.fn(async () => fakeInfo),
  } as unknown as DeviceManager;
  vi.spyOn(DeviceManager, "shared").mockReturnValue(fakeManager);

  // NTP 同步为尽力而为：桩成立即失败，走「无 NTP 继续」分支
  asyncQueryMock.mockRejectedValue(new Error("NTP 在测试中被 mock 禁用"));
});

afterEach(() => {
  // 恢复 DeviceManager.shared 原实现
  vi.restoreAllMocks();
});

// ---- 纯函数解析 ----------------------------------------------------------------

describe("parse_open_time", () => {
  it("空串 / now / 立即 返回 null", () => {
    expect(parseOpenTime("")).toBeNull();
    expect(parseOpenTime("now")).toBeNull();
    expect(parseOpenTime("立即")).toBeNull();
  });

  it("带空格的 YYYY-MM-DD HH:MM:SS", () => {
    const dt = parseOpenTime("2026-07-20 10:00:00");
    expect(dt?.getTime()).toBe(new Date(2026, 6, 20, 10, 0, 0).getTime());
  });

  // Python @pytest.mark.parametrize("fmt", ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"])
  it.each(["%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"])("round trip（%s）", (fmt) => {
    const s = strftime(fmt, new Date(2026, 6, 20, 10, 30, 45));
    expect(parseOpenTime(s)?.getTime()).toBe(new Date(2026, 6, 20, 10, 30, 45).getTime());
  });

  it("无法解析时抛 ValueError", () => {
    expect(() => parseOpenTime("not-a-date")).toThrow(/无法解析/);
  });
});

/** 测试本地 strftime：只实现上面参数化用到的两个格式（按本地时区取分量）。 */
function strftime(fmt: string, d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const ymd = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const hms = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  if (fmt === "%Y-%m-%dT%H:%M:%S") {
    return `${ymd}T${hms}`;
  }
  if (fmt === "%Y-%m-%d %H:%M:%S") {
    return `${ymd} ${hms}`;
  }
  throw new Error(`未实现的 strftime 格式: ${fmt}`);
}

// ---- 倒计时循环 ----------------------------------------------------------------

describe("countdown_loop", () => {
  it("至少推进一次进度回调", async () => {
    const cb = vi.fn();
    // Python 版传 asyncio.get_event_loop().time()（单调时钟，非 epoch 秒）。
    // 该值相对 time.time() 早已是「过去」，循环立即返回——与原测试一样，
    // 此处只断言小延迟后正常返回、不抛异常（performance.now() 同为单调时钟）。
    const target = performance.now() / 1000 + 0.05;
    await countdownLoop(target, { progressCb: cb });
  });

  it("stop_event 已置位时提前返回", async () => {
    // Python asyncio.Event().set() 的最小等价物
    const stop: StopEvent = { isSet: () => true };
    const target = performance.now() / 1000 + 1000; // 单调意义上「远未来」
    const cb = vi.fn();
    await countdownLoop(target, { progressCb: cb, stopEvent: stop });
    expect(cb).not.toHaveBeenCalled();
  });

  it("回调抛异常不会杀死等待", async () => {
    const badCb = async (_left: number, _elapsed: number): Promise<void> => {
      throw new Error("boom");
    };
    const target = performance.now() / 1000 + 0.05;
    // 即使回调恒抛异常也必须正常返回
    await countdownLoop(target, { progressCb: badCb });
  });
});

// ---- run_checklist（全 mock）----------------------------------------------------

describe("run_checklist", () => {
  it("无 open_time 时以立即模式跑完整流程", async () => {
    loginMock.mockResolvedValue({ logged_in: true });
    openMock.mockResolvedValue({ item_id: "1", loaded: true, elapsed_ms: 0 });
    grabMock.mockResolvedValue({ status: "submitted", elapsed_ms: 1, item_id: "1" });

    const res = await runChecklist("127.0.0.1:5555", "1", {
      openTime: "", // immediate
      priceIndex: 1,
      viewerNames: ["张三"],
    });

    expect(res).toBeInstanceOf(ChecklistResult);
    const phaseNames = res.phases.map((p) => p.phase);
    expect(phaseNames).toContain("connectivity");
    expect(phaseNames).toContain("login_check");
    expect(phaseNames).toContain("grab_fire");
    expect(res.status).toBe("submitted");
  });

  it("grab 失败时错误透传到结果", async () => {
    loginMock.mockResolvedValue({ logged_in: true });
    openMock.mockResolvedValue({ item_id: "1", loaded: true, elapsed_ms: 0 });

    grabMock.mockRejectedValue(new Error("simulated network blip"));

    const res = await runChecklist("127.0.0.1:5555", "1", { openTime: "" });

    expect(res.status).toBe("failed");
    expect(res.error ?? "").toContain("simulated network blip");
  });
});

// ---- 序列化 --------------------------------------------------------------------

describe("to_dict 序列化", () => {
  it("PhaseEvent", () => {
    const ev = new PhaseEvent({ phase: "login", startedAtMs: 1000 });
    ev.finishedAtMs = 1500;
    const d = ev.toDict();
    expect(d["phase"]).toBe("login");
    expect(d["started_at_ms"]).toBe(1000);
    expect(d["finished_at_ms"]).toBe(1500);
    expect(d["elapsed_ms"]).toBe(500);
  });

  it("ChecklistResult", () => {
    const res = new ChecklistResult({ status: "submitted" });
    res.phases.push(new PhaseEvent({ phase: "connectivity", startedAtMs: 0 }));
    const d = res.toDict();
    expect(d["status"]).toBe("submitted");
    expect(d["phases"]).toHaveLength(1);
    expect(d["grab_result"]).toBeNull();
  });
});

// ---- 开票判定去抖门 ------------------------------------------------------------

/** 构造一个可见的倒计时节点元素。 */
function countdownNode(resourceId = COUNTDOWN_NODE_RESOURCE_ID): UIElement {
  return new UIElement({ tag: "node", resourceId, bounds: [0, 0, 100, 50] });
}

describe("countdown gate 常量", () => {
  it("resource-id 与阈值常量与设计一致", () => {
    expect(COUNTDOWN_NODE_RESOURCE_ID).toBe(
      "cn.damai:id/id_project_count_down_layout",
    );
    expect(GATE_BASELINE_COUNT).toBe(3);
    expect(GATE_BASELINE_WINDOW_MS).toBe(3000);
    expect(GATE_FALLBACK_AFTER_MS).toBe(150);
    expect(GATE_DEFAULT_POLL_MS).toBe(500);
  });
});

describe("CountdownSignalGate 状态机", () => {
  // 逐字复刻 Python tests/test_sale_wait_logic.py:72-94 用例 ①：
  // disarm 后 miss 不触发 → 重新见到节点 re-arm（rearmCount=1）→
  // 再连续 2 次 miss 触发，且 missingStartedAtMs = 首个 miss 时刻。
  it("disarm 后缺失不触发；re-arm 后连续 2 次缺失才确认", () => {
    const gate = new CountdownSignalGate({ confirmCount: 2 });
    gate.disarm(1000);
    // 未武装（disarm 后）的缺失一律忽略
    expect(gate.observe(false, 2000, true)).toBe(false);
    expect(gate.armed).toBe(false);
    // 节点重现 → re-arm
    expect(gate.observe(true, 3000, false)).toBe(false);
    expect(gate.rearmCount).toBe(1);
    expect(gate.armed).toBe(true);
    // 到点后第 1 次缺失：记起点，未达确认数
    expect(gate.observe(false, 4000, true)).toBe(false);
    expect(gate.missingStartedAtMs).toBe(4000);
    // 第 2 次缺失 → 确认开票，缺失起点保持为首个 miss
    expect(gate.observe(false, 5000, true)).toBe(true);
    expect(gate.missingStartedAtMs).toBe(4000);
  });

  // 逐字复刻 Python tests/test_sale_wait_logic.py:72-94 用例 ②：
  // 节点从未出现 → 永不触发、rearmCount=0。
  it("节点从未出现则永不触发且 rearmCount=0", () => {
    const gate = new CountdownSignalGate({ confirmCount: 2 });
    for (let t = 1000; t <= 5000; t += 1000) {
      expect(gate.observe(false, t, true)).toBe(false);
    }
    expect(gate.rearmCount).toBe(0);
    expect(gate.armed).toBe(false);
    expect(gate.falseStreak).toBe(0);
    expect(gate.missingStartedAtMs).toBeNull();
  });

  it("confirmCount 越界 clamp 到 1..5（缺省 2）", () => {
    // 0 → 1：武装后 1 次缺失即触发
    const g1 = new CountdownSignalGate({ confirmCount: 0 });
    g1.observe(true, 1000, false);
    expect(g1.observe(false, 2000, true)).toBe(true);
    // 9 → 5：第 4 次缺失仍未触发，第 5 次才触发
    const g5 = new CountdownSignalGate({ confirmCount: 9 });
    g5.observe(true, 1000, false);
    for (let i = 0; i < 4; i++) {
      expect(g5.observe(false, 2000 + i * 100, true)).toBe(false);
    }
    expect(g5.observe(false, 3000, true)).toBe(true);
    // 缺省 = 2
    const gDefault = new CountdownSignalGate();
    gDefault.observe(true, 1000, false);
    expect(gDefault.observe(false, 2000, true)).toBe(false);
    expect(gDefault.observe(false, 3000, true)).toBe(true);
  });

  it("未到点（signalAllowed=false）的缺失一律忽略", () => {
    const gate = new CountdownSignalGate({ confirmCount: 1 });
    gate.observe(true, 1000, false);
    expect(gate.observe(false, 2000, false)).toBe(false);
    expect(gate.falseStreak).toBe(0);
    expect(gate.missingStartedAtMs).toBeNull();
    // 到点后的缺失立即计数（confirmCount=1）
    expect(gate.observe(false, 3000, true)).toBe(true);
  });

  it("disarm 清零 armed / falseStreak / missingStartedAtMs（rearmCount 保留）", () => {
    const gate = new CountdownSignalGate({ confirmCount: 3 });
    gate.observe(true, 1000, false);
    gate.observe(false, 2000, true);
    gate.observe(false, 3000, true);
    expect(gate.falseStreak).toBe(2);
    gate.disarm(3500);
    expect(gate.armed).toBe(false);
    expect(gate.falseStreak).toBe(0);
    expect(gate.missingStartedAtMs).toBeNull();
    // rearmCount 是跨整个等待周期的累计诊断量，不随 disarm 清零
    expect(gate.rearmCount).toBe(1);
  });
});

describe("waitForSaleStart 基线", () => {
  it("present×2 + miss → 基线计数归零，窗口内未建成 → 定时器兜底", async () => {
    const node = countdownNode();
    // 2 次在场后缺失（归零），随后再 2 次也只有 2 连击 → 基线始终未建成
    dumpUiMock
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValue([]);
    const targetUnix = Date.now() / 1000 + 0.05;
    const res = await waitForSaleStart("127.0.0.1:5555", targetUnix, {
      gatePollMs: 5,
    });
    expect(res.trigger).toBe("timer");
    expect(res.baselineEstablished).toBe(false);
    expect(res.armedAtTrigger).toBe(false);
    // 基线未建成 → 门从未武装
    expect(res.rearmCount).toBe(0);
    expect(res.uiDisabled).toBe(false);
  });

  it("present×3 → 基线建成；resource-id 后缀匹配同样命中", async () => {
    // 后缀变体：resource-id 以倒计时节点 id 结尾（语义同 inspector/find.ts 的 rid 规则）
    const node = countdownNode(`com.vendor/${COUNTDOWN_NODE_RESOURCE_ID}`);
    dumpUiMock
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValue([]);
    const targetUnix = Date.now() / 1000 + 0.2;
    const res = await waitForSaleStart("127.0.0.1:5555", targetUnix, {
      gatePollMs: 5,
      confirmCount: 2,
      // 放宽定时器兜底，给到点后的 2 次缺失留足确认窗口
      fallbackAfterMs: 2000,
    });
    expect(res.trigger).toBe("gate");
    expect(res.baselineEstablished).toBe(true);
    expect(res.armedAtTrigger).toBe(true);
    expect(res.rearmCount).toBe(1);
    expect(res.missingMs).not.toBeNull();
    expect(res.uiDisabled).toBe(false);
    expect(res.refreshes).toBe(0);
  });
});

describe("waitForSaleStart 主循环", () => {
  it("目标时刻已过 → 定时器兜底立即触发（不 dump）", async () => {
    dumpUiMock.mockResolvedValue([countdownNode()]);
    const res = await waitForSaleStart("127.0.0.1:5555", Date.now() / 1000 - 5, {
      gatePollMs: 5,
    });
    expect(res.trigger).toBe("timer");
    expect(res.baselineEstablished).toBe(false);
    expect(res.armedAtTrigger).toBe(false);
    expect(res.uiDisabled).toBe(false);
    expect(dumpUiMock).not.toHaveBeenCalled();
  });

  it("dumpUi 连续 3 次失败 → uiDisabled 退化为纯定时器", async () => {
    dumpUiMock.mockRejectedValue(new Error("uiautomator 卡死"));
    const targetUnix = Date.now() / 1000 + 0.05;
    const res = await waitForSaleStart("127.0.0.1:5555", targetUnix, {
      gatePollMs: 5,
    });
    expect(res.trigger).toBe("timer");
    expect(res.uiDisabled).toBe(true);
    expect(res.baselineEstablished).toBe(false);
    expect(res.armedAtTrigger).toBe(false);
    // UI 观察被禁用后不再刷新
    expect(res.refreshes).toBe(0);
    expect(swipeMock).not.toHaveBeenCalled();
  });

  it("刷新窗口触发 swipe 后 disarm：节点重现重新武装（rearmCount 累积），缺失重新计数", async () => {
    const node = countdownNode();
    // 序列：3 次基线在场 → 主循环第 1 轮在场（此时刷新 + disarm）→
    // 第 2 轮在场（re-arm）→ 之后恒缺失（到点后连续 2 次确认开票）
    dumpUiMock
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValue([]);
    const targetUnix = Date.now() / 1000 + 0.2;
    const res = await waitForSaleStart("127.0.0.1:5555", targetUnix, {
      gatePollMs: 5,
      confirmCount: 2,
      fallbackAfterMs: 2000,
      refreshIntervalMs: 0, // 立即满足刷新窗口
      refreshStopAtSec: 0, // 距开票 > 0 即允许刷新
      refreshSettleMs: 1000, // 冷却盖过剩余等待 → 刷新恰好一次
    });
    expect(res.trigger).toBe("gate");
    expect(res.refreshes).toBe(1);
    expect(swipeMock).toHaveBeenCalledTimes(1);
    expect(res.baselineEstablished).toBe(true);
    // 基线武装 1 次 + 刷新 disarm 后节点重现再武装 1 次；disarm 同时清掉了
    // 此前的缺失计数（门要求刷新后的 2 次全新缺失才确认）
    expect(res.rearmCount).toBe(2);
    expect(res.armedAtTrigger).toBe(true);
    expect(res.missingMs).not.toBeNull();
  });

  it("stopEvent 已置位 → 立即返回（trigger=timer），不做任何 dump", async () => {
    const stop: StopEvent = { isSet: () => true };
    dumpUiMock.mockResolvedValue([countdownNode()]);
    const res = await waitForSaleStart("127.0.0.1:5555", Date.now() / 1000 + 50, {
      gatePollMs: 5,
      stopEvent: stop,
    });
    expect(res.trigger).toBe("timer");
    expect(dumpUiMock).not.toHaveBeenCalled();
    expect(res.baselineEstablished).toBe(false);
  });

  it("进度回调抛异常不会杀死等待", async () => {
    const node = countdownNode();
    dumpUiMock
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValue([]);
    const badCb = async (_left: number, _elapsed: number): Promise<void> => {
      throw new Error("boom");
    };
    const targetUnix = Date.now() / 1000 + 0.2;
    const res = await waitForSaleStart("127.0.0.1:5555", targetUnix, {
      gatePollMs: 5,
      confirmCount: 2,
      fallbackAfterMs: 2000,
      progressCb: badCb,
    });
    expect(res.trigger).toBe("gate");
  });
});

describe("run_checklist（open_time + 去抖门）", () => {
  it("带 open_time 时经去抖门等待跑完整流程，openTime 仍透传给 damaiGrab", async () => {
    loginMock.mockResolvedValue({ logged_in: true });
    openMock.mockResolvedValue({ item_id: "1", loaded: true, elapsed_ms: 0 });
    grabMock.mockResolvedValue({ status: "submitted", elapsed_ms: 1, item_id: "1" });
    // 序列：Phase 2.5 warm dump 消耗 2 次（恒在场）→ 基线 3 次在场 → 主循环恒缺失
    // （open_time 截断到整秒，目标至少 1s 后 → 到点后连续 2 次缺失由门确认开票）
    const node = countdownNode();
    dumpUiMock
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValueOnce([node])
      .mockResolvedValue([]);
    swipeMock.mockResolvedValue(undefined);
    screenshotMock.mockResolvedValue(Buffer.alloc(0));

    // strftime 只保留整秒：+2s 保证截断后目标仍至少 1s 在未来（确定性强）
    const openTime = strftime("%Y-%m-%d %H:%M:%S", new Date(Date.now() + 2000));
    const res = await runChecklist("127.0.0.1:5555", "1", {
      openTime,
      priceIndex: 1,
      viewerNames: ["张三"],
      // 小轮询间隔：让基线段（min(3s, 距开票) 窗口）容得下 3 次观察
      signalGateOptions: { gatePollMs: 5 },
    });

    expect(res).toBeInstanceOf(ChecklistResult);
    const phaseNames = res.phases.map((p) => p.phase);
    expect(phaseNames).toContain("preheat_open");
    expect(phaseNames).toContain("countdown");
    expect(phaseNames).toContain("grab_fire");
    expect(res.status).toBe("submitted");
    // Phase 4 仍把 openTime 透传给 damaiGrab（第 6 个位置参数），不绕过其内置闸门
    expect(grabMock.mock.calls[0]?.[5]).toBe(openTime);
  });

  it("signalGateDisabled=true 时回退为纯 countdownLoop（旧行为）", async () => {
    loginMock.mockResolvedValue({ logged_in: true });
    openMock.mockResolvedValue({ item_id: "1", loaded: true, elapsed_ms: 0 });
    grabMock.mockResolvedValue({ status: "submitted", elapsed_ms: 1, item_id: "1" });
    dumpUiMock.mockResolvedValue([countdownNode()]);
    screenshotMock.mockResolvedValue(Buffer.alloc(0));

    const res = await runChecklist("127.0.0.1:5555", "1", {
      openTime: "2020-01-01 10:00:00", // 已过去 → 立即到点
      signalGateDisabled: true,
    });

    expect(res.status).toBe("submitted");
    expect(res.phases.map((p) => p.phase)).toContain("countdown");
    // 只剩 Phase 2.5 warm dump 的 2 次 dumpUi——去抖门主循环没有做 UI 观察
    expect(dumpUiMock).toHaveBeenCalledTimes(2);
  });
});
