/**
 * 原子动作函数的测试——验证它们按约定调用 adb
 * （Python `tests/test_actions.py` 的 TS 对应物；用例一一对应）。
 *
 * Python 用 `patch("damai_mcp.actions.actions.shell", ...)` 替换模块级
 * `shell` / `adb`；TS 侧等价物是在文件顶层 `vi.mock("../src/device/adb")`
 * 替换同一层（actions.ts 正是从该模块导入 `adb` / `shell`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tap, type KeyName, screenshot, inputText, longPress, pressKey, scroll, swipe, doubleTap } from "../src/actions/actions";
import { jitterInt, jitteredDelayMs, setJitterRngForTests } from "../src/actions/actions";
import { adb, shell } from "../src/device/adb";
import { ADBError } from "../src/utils/errors";
import { fakeAdbResult } from "./helpers";

vi.mock("../src/device/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/device/adb")>();
  return { ...actual, adb: vi.fn(), shell: vi.fn() };
});

/** 最近一次 mock 调用的第一个参数（对应 Python 的 `m.call_args.args[0]`）。 */
function lastShellCmd(): string {
  const calls = vi.mocked(shell).mock.calls;
  const last = calls[calls.length - 1];
  return last?.[0] as string;
}

describe("atomic actions call adb correctly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shell).mockResolvedValue("");
  });

  it("test_tap_sends_input_tap", async () => {
    await tap("DEV", 100, 200);
    expect(vi.mocked(shell)).toHaveBeenCalledTimes(1);
    expect(lastShellCmd()).toBe("input tap 100 200");
  });

  it("test_tap_with_duration_uses_swipe", async () => {
    await tap("DEV", 100, 200, { durationMs: 500 });
    const cmd = lastShellCmd();
    expect(cmd.startsWith("input swipe")).toBe(true);
    expect(cmd).toContain("500");
  });

  it("test_double_tap_calls_tap_twice", async () => {
    await doubleTap("DEV", 100, 200);
    expect(vi.mocked(shell)).toHaveBeenCalledTimes(2);
  });

  it("test_long_press_uses_long_swipe", async () => {
    await longPress("DEV", 100, 200, { durationMs: 1000 });
    const cmd = lastShellCmd();
    expect(cmd.startsWith("input swipe")).toBe(true);
    expect(cmd.endsWith("1000")).toBe(true);
  });

  it("test_swipe_passes_duration", async () => {
    await swipe("DEV", 0, 0, 100, 100, { durationMs: 250 });
    expect(lastShellCmd()).toBe("input swipe 0 0 100 100 250");
  });

  it("test_scroll_down_calls_swipe", async () => {
    // 对应 Python 的 fake_shell：args[0] == "wm" 时返回屏幕尺寸
    vi.mocked(shell).mockImplementation(async (...args) =>
      args[0] === "wm" ? "Physical size: 1080x2400" : "",
    );
    await scroll("DEV", "down", 0.5);
    const swipeCall = vi
      .mocked(shell)
      .mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).startsWith("input swipe"),
      );
    expect(swipeCall).toBeDefined();
    expect(swipeCall?.[0]).toContain("540"); // center x
    expect(swipeCall?.[0]).toContain("1200"); // center y
  });

  it("test_input_text_replaces_spaces_with_pct_s", async () => {
    await inputText("DEV", "hello world");
    expect(lastShellCmd()).toBe("input text hello%sworld");
  });

  it("test_press_key_known_name", async () => {
    await pressKey("DEV", "home");
    expect(lastShellCmd()).toBe("input keyevent 3"); // KEYCODE_HOME = 3
  });

  it("test_press_key_unknown_raises", async () => {
    // Python 侧入参是任意 str；KeyName 联合类型不含未知键名，仅做类型桥接
    const unknownKey = "no_such_key" as unknown as KeyName;
    let caught: unknown;
    try {
      await pressKey("DEV", unknownKey);
    } catch (exc) {
      caught = exc;
    }
    expect(caught).toBeInstanceOf(ADBError);
    expect((caught as Error).message).toContain("未知按键");
  });

  it("test_press_key_int", async () => {
    await pressKey("DEV", 187); // APP_SWITCH
    expect(lastShellCmd()).toBe("input keyevent 187");
  });

  it("test_screenshot_uses_exec_out", async () => {
    const fakeResult = fakeAdbResult({
      stdoutBytes: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // b"\x89PNG\r\n\x1a\n"
        Buffer.from("FAKE", "ascii"),
      ]),
    });
    vi.mocked(adb).mockResolvedValue(fakeResult);

    const png = (await screenshot("DEV")) as Buffer;
    expect(png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    // 对应 Python 的 m.call_args.args[:3] == ("exec-out", "screencap", "-p")
    const call = vi.mocked(adb).mock.calls[0];
    expect(call?.slice(0, 3)).toEqual(["exec-out", "screencap", "-p"]);
  });
});

describe("行为随机化原语（item-7）", () => {
  afterEach(() => {
    setJitterRngForTests(null); // 恢复 Math.random，避免泄漏到其他用例
  });

  it("jitterInt：边界 / 取整 / clamp 负值", () => {
    expect(jitterInt(100, 4, () => 0)).toBe(96); // 下界
    expect(jitterInt(100, 4, () => 0.5)).toBe(100); // 中心
    expect(jitterInt(100, 4, () => 0.999)).toBe(104); // 上界（rng < 1）
    expect(jitterInt(2.4, 0, () => 0.5)).toBe(2); // radius=0 → 仅取整
    expect(jitterInt(2, 4, () => 0)).toBe(0); // 负值 clamp 到 0
    expect(jitterInt(0, 3, () => 0.999)).toBe(3); // 0 附近不越界为负
  });

  it("jitteredDelayMs：±ratio 区间内，注入与默认 rng 均可", () => {
    expect(jitteredDelayMs(1000, 0.2, () => 0)).toBe(800);
    expect(jitteredDelayMs(1000, 0.2, () => 0.5)).toBe(1000);
    expect(jitteredDelayMs(1000, 0.2, () => 0.999)).toBe(1200);
    setJitterRngForTests(null); // 默认 Math.random
    for (let i = 0; i < 20; i++) {
      const v = jitteredDelayMs(1000, 0.2);
      expect(v).toBeGreaterThanOrEqual(800);
      expect(v).toBeLessThanOrEqual(1200);
    }
  });

  it("jitterPx=0 时 tap 命令字符串与现状逐字节一致（回归）", async () => {
    setJitterRngForTests(() => 0.99); // 即便 rng 会给出大抖动，不传 jitterPx 也不得消费
    await tap("DEV", 100, 200);
    expect(lastShellCmd()).toBe("input tap 100 200");
    await tap("DEV", 100, 200, { jitterPx: 0 });
    expect(lastShellCmd()).toBe("input tap 100 200");
    await tap("DEV", 100, 200, { durationMs: 500, jitterPx: 0 });
    expect(lastShellCmd()).toBe("input swipe 100 200 100 200 500");
  });

  it("jitterPx>0 且 rng 固定时命令坐标可预测", async () => {
    setJitterRngForTests(() => 0.25);
    await tap("DEV", 100, 200, { jitterPx: 4 });
    // x = round(96 + 0.25*8) = 98；y = round(196 + 2) = 198
    expect(lastShellCmd()).toBe("input tap 98 198");
  });

  it("jitterPx>0 时约 20% 概率把 50ms 按压时长变为 60-120ms（rng 序列可复现）", async () => {
    setJitterRngForTests(() => 0.1); // < 0.2 → 触发；时长 = 60 + round(0.1*60) = 66
    await tap("DEV", 50, 60, { jitterPx: 3 });
    // x = round(47 + 0.6) = 48；y = round(57 + 0.6) = 58
    expect(lastShellCmd()).toBe("input swipe 48 58 48 58 66");
    setJitterRngForTests(() => 0.9); // ≥ 0.2 → 不触发
    await tap("DEV", 50, 60, { jitterPx: 3 });
    expect(lastShellCmd()).toBe("input tap 52 62");
  });

  it("显式 durationMs 与 jitterPx 并存时不改写调用方时长", async () => {
    setJitterRngForTests(() => 0.05); // 会触发 roll，但 durationMs≠50 时跳过
    await tap("DEV", 10, 20, { durationMs: 300, jitterPx: 2 });
    const cmd = lastShellCmd();
    expect(cmd.startsWith("input swipe")).toBe(true);
    expect(cmd.endsWith("300")).toBe(true);
  });
});
