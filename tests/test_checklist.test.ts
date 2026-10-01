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
  PhaseEvent,
  countdownLoop,
  parseOpenTime,
  runChecklist,
  type StopEvent,
} from "../src/damai/checklist";
import { DeviceInfo, DeviceManager } from "../src/device/manager";

// ---- 模块级桩 ------------------------------------------------------------------

const { grabMock, loginMock, openMock, asyncQueryMock } = vi.hoisted(() => ({
  /** `damai/actions.damaiGrab` 桩。 */
  grabMock: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  /** `damai/actions.damaiLoginCheck` 桩。 */
  loginMock: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  /** `damai/actions.damaiOpenConcert` 桩。 */
  openMock: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  /** `utils/ntp.asyncQuery` 桩。 */
  asyncQueryMock: vi.fn<(...args: unknown[]) => Promise<never>>(),
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
