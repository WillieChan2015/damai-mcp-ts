/**
 * L4 只读余票监控的测试（新模块，无 Python 对应物）。
 *
 * 通过模块级 mock 避开 ADB / 真机等重依赖（ESM 具名导入不可变，故在来源模块
 * `inspector/dump` 与 `device/adb` 上用 vi.mock 打桩，桩状态用 vi.hoisted 共享）；
 * 分类矩阵为纯函数用例。另含"只读守护"用例：直接读 monitor.ts 源码，断言
 * 不出现任何点击 / 下单符号——把"绝不点击购买"固化为 CI 断言。
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MONITOR_COUNTDOWN_RESOURCE_ID,
  MONITOR_DETAIL_URL_TEMPLATE,
  MONITOR_MAX_CONSECUTIVE_ERRORS,
  MonitorResult,
  type MonitorReportSnapshot,
  classifyAvailability,
  monitorAvailability,
} from "../src/damai/monitor";
import { ADBError } from "../src/utils/errors";
import { UIElement, type UIElementInit } from "../src/inspector/models";

// ---- 模块级桩 ------------------------------------------------------------------

const { dumpUiMock, shellMock } = vi.hoisted(() => ({
  /** `inspector/dump.dumpUi` 桩。 */
  dumpUiMock: vi.fn<(...args: unknown[]) => Promise<UIElement[]>>(),
  /** `device/adb.shell` 桩（深链不外发）。 */
  shellMock: vi.fn<(...args: unknown[]) => Promise<string>>(),
}));

vi.mock("../src/inspector/dump", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/inspector/dump")>();
  return { ...actual, dumpUi: dumpUiMock };
});
vi.mock("../src/device/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/device/adb")>();
  return { ...actual, shell: shellMock };
});

beforeEach(() => {
  vi.resetAllMocks();
  shellMock.mockResolvedValue("");
});

// ---- 元素构造辅助 ---------------------------------------------------------------

/** 构造一个可见的大麦包元素（bounds 非退化 + enabled 默认 true）。 */
function el(overrides: Partial<UIElementInit> = {}): UIElement {
  return new UIElement({
    tag: "node",
    bounds: [0, 0, 100, 40],
    package: "cn.damai",
    ...overrides,
  });
}

/** 未知状态页：大麦在前台但无任何余票证据。 */
function unknownPage(): UIElement[] {
  return [el({ text: "演出详情" })];
}

/** 非大麦前台页（如桌面启动器）。 */
function launcherPage(): UIElement[] {
  return [el({ text: "桌面", package: "com.android.launcher" })];
}

// ---- ① classifyAvailability 纯函数矩阵 ------------------------------------------

describe("classifyAvailability 纯函数矩阵", () => {
  it("传入票档时只认列表里第一张未缺货卡片，不用整页立即购买", () => {
    const nodes = [
      el({ text: "票档", bounds: [16, 400, 80, 430] }),
      el({ text: "看台488元", bounds: [16, 450, 180, 510] }),
      el({ text: "缺货登记", bounds: [120, 460, 175, 490] }),
      el({ text: "看台688元", bounds: [16, 530, 180, 590] }),
      el({ text: "立即购买", bounds: [16, 700, 200, 760] }),
      el({ text: "确定", bounds: [250, 740, 380, 790] }),
    ];
    expect(
      classifyAvailability(nodes, { priceLabels: ["看台488元", "看台688元"] }),
    ).toEqual({ status: "available", reason: "看台688元" });
  });

  it("传入票档且全部缺货 → sold_out，不因立即购买报有票", () => {
    const nodes = [
      el({ text: "票档", bounds: [16, 400, 80, 430] }),
      el({ text: "看台488元", bounds: [16, 450, 180, 510] }),
      el({ text: "缺货登记", bounds: [120, 460, 175, 490] }),
      el({ text: "立即购买", bounds: [16, 700, 200, 760] }),
      el({ text: "确定", bounds: [250, 740, 380, 790] }),
    ];
    expect(classifyAvailability(nodes, { priceLabels: ["看台488元"] }).status).toBe("sold_out");
  });

  it("立即购买 → available（正证据 CTA）", () => {
    expect(classifyAvailability([el({ text: "立即购买" })])).toEqual({
      status: "available",
      reason: "立即购买",
    });
  });

  it("售罄与立即购买并存 → sold_out（阻塞词优先）", () => {
    const judge = classifyAvailability([
      el({ text: "立即购买" }),
      el({ text: "已售罄，下次再来" }),
    ]);
    expect(judge.status).toBe("sold_out");
    expect(judge.reason).toBe("售罄");
  });

  it.each(["未开售", "未开始", "即将开售", "登记", "候补"])("未开售词「%s」→ not_on_sale", (word) => {
    expect(classifyAvailability([el({ text: `门票${word}` })])).toEqual({
      status: "not_on_sale",
      reason: word,
    });
  });

  it.each(["已结束", "已取消", "下架"])("本场级终局词「%s」→ sold_out（reason 保留区分度）", (word) => {
    expect(classifyAvailability([el({ text: `该演出${word}` })])).toEqual({
      status: "sold_out",
      reason: word,
    });
  });

  it("空白页 / 空列表 → unknown（无正证据继续轮询）", () => {
    expect(classifyAvailability([el({ text: "演出详情" })])).toEqual({
      status: "unknown",
      reason: null,
    });
    expect(classifyAvailability([])).toEqual({ status: "unknown", reason: null });
  });

  it("content-desc 与 text 同样命中", () => {
    expect(classifyAvailability([el({ contentDesc: "立即购买" })])).toEqual({
      status: "available",
      reason: "立即购买",
    });
    expect(classifyAvailability([el({ contentDesc: "缺货" })])).toEqual({
      status: "sold_out",
      reason: "缺货",
    });
  });

  it("倒计时节点在场 → not_on_sale（resource-id 等值与后缀匹配）", () => {
    expect(
      classifyAvailability([el({ resourceId: MONITOR_COUNTDOWN_RESOURCE_ID })]),
    ).toEqual({ status: "not_on_sale", reason: "countdown_node" });
    expect(
      classifyAvailability([
        el({ resourceId: `xx/${MONITOR_COUNTDOWN_RESOURCE_ID}` }),
      ]).status,
    ).toBe("not_on_sale");
  });

  it("countdownResourceId=null 可关闭倒计时检查", () => {
    const page = [el({ resourceId: MONITOR_COUNTDOWN_RESOURCE_ID })];
    expect(classifyAvailability(page, { countdownResourceId: null }).status).toBe("unknown");
  });

  it("不可见元素不参与判定", () => {
    const invisible = el({ text: "售罄", bounds: [0, 0, 0, 0] });
    expect(invisible.visible).toBe(false);
    expect(classifyAvailability([invisible]).status).toBe("unknown");
  });
});

// ---- ②..⑧ monitorAvailability 轮询 ----------------------------------------------

describe("monitorAvailability", () => {
  it("首轮即 available → 立即返回 found=true 并附 detailUrl（toDict 全 snake_case）", async () => {
    dumpUiMock.mockResolvedValue([el({ text: "立即购买" })]);
    const res = await monitorAvailability("emulator-5554", "12345", {
      openPage: false,
      intervalMs: 5,
    });

    expect(res).toBeInstanceOf(MonitorResult);
    expect(res.found).toBe(true);
    expect(res.stopReason).toBe("available");
    expect(res.finalStatus).toBe("available");
    expect(res.attempts).toBe(1);
    expect(res.consecutiveErrors).toBe(0);
    expect(res.lastReason).toBe("立即购买");
    expect(res.error).toBeNull();
    expect(res.detailUrl).toBe(MONITOR_DETAIL_URL_TEMPLATE + "12345");
    expect(dumpUiMock).toHaveBeenCalledTimes(1);

    const d = res.toDict();
    expect(Object.keys(d)).toEqual([
      "found",
      "final_status",
      "attempts",
      "consecutive_errors",
      "stop_reason",
      "detail_url",
      "last_reason",
      "elapsed_ms",
      "error",
    ]);
    expect(d["found"]).toBe(true);
    expect(d["stop_reason"]).toBe("available");
    expect(d["detail_url"]).toBe(MONITOR_DETAIL_URL_TEMPLATE + "12345");
  });

  it("dump 连续 5 次失败 → consecutive_errors，错误信息中文且截断 200 字符", async () => {
    // 上游原始输出主体长达 500 字符，截断后不得整段携带
    dumpUiMock.mockRejectedValue(new ADBError(`uiautomator dump 失败: ${"B".repeat(500)}`));
    const res = await monitorAvailability("dev", "1", { openPage: false, intervalMs: 1 });

    expect(res.stopReason).toBe("consecutive_errors");
    expect(res.found).toBe(false);
    expect(res.attempts).toBe(MONITOR_MAX_CONSECUTIVE_ERRORS);
    expect(res.consecutiveErrors).toBe(MONITOR_MAX_CONSECUTIVE_ERRORS);
    expect(res.finalStatus).toBe("unknown");
    expect(res.error).not.toBeNull();
    expect(res.error!.startsWith("UI 采样连续失败")).toBe(true);
    expect(res.error!.length).toBeLessThanOrEqual(200);
    expect(res.error!.includes("B".repeat(300))).toBe(false);
  });

  it("退避序列 interval, 2i, 4i, … 封顶，成功后回到 interval（onReport 快照）", async () => {
    // 注：vitest 假时钟只替换 globalThis.setTimeout，而 node:timers/promises 的
    // setTimeout 不经全局对象分发（已实测计数为 0），无法被 advanceTimersByTimeAsync
    // 推进；故退避用 10ms 量级的真实等待断言同一序列。
    dumpUiMock
      .mockRejectedValueOnce(new ADBError("e1"))
      .mockRejectedValueOnce(new ADBError("e2"))
      .mockRejectedValueOnce(new ADBError("e3"))
      .mockRejectedValueOnce(new ADBError("e4"))
      .mockRejectedValueOnce(new ADBError("e5"))
      .mockResolvedValue(unknownPage());

    const reports: MonitorReportSnapshot[] = [];
    const res = await monitorAvailability("dev", "1", {
      openPage: false,
      intervalMs: 10,
      maxAttempts: 7,
      maxBackoffMs: 80, // 10 → 20 → 40 → 80 → 封顶 80
      maxConsecutiveErrors: 10, // 放宽连败上限，专门观察退避曲线
      onReport: (snapshot) => {
        reports.push({ ...snapshot });
      },
    });

    expect(res.stopReason).toBe("max_attempts");
    expect(res.found).toBe(false);
    expect(reports.map((r) => r.nextDelayMs)).toEqual([10, 20, 40, 80, 80, 10, null]);
    expect(reports.map((r) => r.errors)).toEqual([1, 2, 3, 4, 5, 0, 0]);
    expect(reports.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(reports.map((r) => r.status)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  it("max_attempts=3 未命中 → max_attempts 且 found=false", async () => {
    dumpUiMock.mockResolvedValue(unknownPage());
    const res = await monitorAvailability("dev", "1", {
      openPage: false,
      intervalMs: 2,
      maxAttempts: 3,
    });

    expect(res.stopReason).toBe("max_attempts");
    expect(res.found).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.finalStatus).toBe("unknown");
    expect(dumpUiMock).toHaveBeenCalledTimes(3);
  });

  it("dump 无 cn.damai 包元素 → not_foreground（不做自动重导航）", async () => {
    dumpUiMock.mockResolvedValue(launcherPage());
    const res = await monitorAvailability("dev", "1", { openPage: false, intervalMs: 5 });

    expect(res.stopReason).toBe("not_foreground");
    expect(res.found).toBe(false);
    expect(res.attempts).toBe(1);
    expect(res.finalStatus).toBe("unknown");
    expect(dumpUiMock).toHaveBeenCalledTimes(1);
    expect(shellMock).not.toHaveBeenCalled();
  });

  it("deadlineUnixMs 已过 → timeout 且不打开页面", async () => {
    const res = await monitorAvailability("dev", "1", {
      openPage: true, // 已过截止时连深链都不应执行
      deadlineUnixMs: Date.now() - 1000,
    });

    expect(res.stopReason).toBe("timeout");
    expect(res.found).toBe(false);
    expect(res.attempts).toBe(0);
    expect(shellMock).not.toHaveBeenCalled();
    expect(dumpUiMock).not.toHaveBeenCalled();
  });

  it("stopEvent 已置位 → cancelled 且不打开页面", async () => {
    const res = await monitorAvailability("dev", "1", {
      openPage: true,
      stopEvent: { isSet: () => true },
    });

    expect(res.stopReason).toBe("cancelled");
    expect(res.found).toBe(false);
    expect(res.attempts).toBe(0);
    expect(shellMock).not.toHaveBeenCalled();
    expect(dumpUiMock).not.toHaveBeenCalled();
  });

  it("轮询中途置位 stopEvent → cancelled", async () => {
    dumpUiMock.mockResolvedValue(unknownPage());
    const stop = { set: false, isSet: () => stop.set };
    const res = await monitorAvailability("dev", "1", {
      openPage: false,
      intervalMs: 5,
      stopEvent: stop,
      onReport: () => {
        stop.set = true;
      },
    });

    expect(res.stopReason).toBe("cancelled");
    expect(res.attempts).toBe(1);
  });

  it("openPage=true 先深链打开再轮询（am start 参数断言）", async () => {
    dumpUiMock
      .mockResolvedValueOnce([el()]) // 深链加载判据：cn.damai 包元素在场
      .mockResolvedValue([el({ text: "立即预订" })]); // 轮询首轮 → available
    const res = await monitorAvailability("emulator-5554", "999", { intervalMs: 5 });

    expect(res.found).toBe(true);
    expect(res.attempts).toBe(1); // 加载探测不计入 attempts
    expect(shellMock).toHaveBeenCalledTimes(1);
    const args = shellMock.mock.calls[0];
    expect(args[0]).toBe("am");
    expect(args[1]).toBe("start");
    expect(args[2]).toBe("-a");
    expect(args[3]).toBe("android.intent.action.VIEW");
    expect(args[4]).toBe("-d");
    expect(args[5]).toBe("damai://item?id=999");
    const opts = args[6] as { deviceId?: string; check?: boolean };
    expect(opts.deviceId).toBe("emulator-5554");
    expect(opts.check).toBe(false);
    expect(dumpUiMock).toHaveBeenCalledTimes(2); // 1 次加载判据 + 1 次轮询
  });

  it("两次深链均未加载 → page_not_loaded（第二次回退 web URL，错误中文）", async () => {
    dumpUiMock.mockResolvedValue(launcherPage());
    const res = await monitorAvailability("dev", "999", { intervalMs: 5 });

    expect(res.stopReason).toBe("page_not_loaded");
    expect(res.found).toBe(false);
    expect(res.attempts).toBe(0);
    expect(res.finalStatus).toBe("unknown");
    expect(res.error).toContain("无法打开大麦详情页");
    expect(shellMock).toHaveBeenCalledTimes(2);
    expect(shellMock.mock.calls[0][5]).toBe("damai://item?id=999");
    expect(shellMock.mock.calls[1][5]).toBe("https://m.damai.cn/shows/item.html?itemId=999");
    expect(dumpUiMock).toHaveBeenCalledTimes(2);
  });

  it("intervalMs<=0 / maxAttempts<0 抛中文错误且不触设备", async () => {
    await expect(
      monitorAvailability("dev", "1", { intervalMs: 0, openPage: false }),
    ).rejects.toThrow("监控间隔必须为正数");
    await expect(
      monitorAvailability("dev", "1", { intervalMs: -1, openPage: false }),
    ).rejects.toThrow("监控间隔必须为正数");
    await expect(
      monitorAvailability("dev", "1", { maxAttempts: -1, openPage: false }),
    ).rejects.toThrow("max_attempts 不能为负");
    expect(shellMock).not.toHaveBeenCalled();
    expect(dumpUiMock).not.toHaveBeenCalled();
  });
});

// ---- ⑨ 只读守护 ------------------------------------------------------------------

describe("只读守护", () => {
  it("monitor.ts 源码不含任何点击 / 下单符号（绝不点击购买、绝不提交订单）", () => {
    const source = readFileSync(new URL("../src/damai/monitor.ts", import.meta.url), "utf-8");
    const forbidden = /\btap\(|\bswipe\(|pressKey|inputText|damaiGrab|damaiConfirmOrder|damaiPay/;
    expect(forbidden.test(source)).toBe(false);
  });
});
