/**
 * 原子动作函数的测试——验证它们按约定调用 adb
 * （Python `tests/test_actions.py` 的 TS 对应物；用例一一对应）。
 *
 * Python 用 `patch("damai_mcp.actions.actions.shell", ...)` 替换模块级
 * `shell` / `adb`；TS 侧等价物是在文件顶层 `vi.mock("../src/device/adb")`
 * 替换同一层（actions.ts 正是从该模块导入 `adb` / `shell`）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { tap, type KeyName, screenshot, inputText, longPress, pressKey, scroll, swipe, doubleTap } from "../src/actions/actions";
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
